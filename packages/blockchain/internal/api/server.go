package api

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/rs/zerolog/log"

	"zk-blockchain/internal/core"
	"zk-blockchain/internal/evm"
	"zk-blockchain/internal/network"
	"zk-blockchain/internal/persistence"
)

var (
	bc     *core.Blockchain
	store  *persistence.FileStore
	bridge *evm.ContractBridge // nil when artifacts are unavailable (Stage 1/2 mode)

	// registrationMu serializes /register requests so that LeafIndex assignment
	// and block append are atomic. Without this, two concurrent registrations
	// could both count N existing registrations and assign the same leaf index,
	// corrupting the Merkle tree.
	registrationMu sync.Mutex
)

// InitServer sets the shared state used by all handlers.
// bridge may be nil — if so, write operations skip EVM calls (Stage 1/2 mode).
func InitServer(blockchain *core.Blockchain, fs *persistence.FileStore, b *evm.ContractBridge) {
	bc = blockchain
	store = fs
	bridge = b
}

// newPublicMux builds the route table for the browser-facing API. Split out
// from StartPublicServer so tests can drive real route matching (method +
// path-parameter patterns like /voter/{voter_id}) through httptest without
// needing a live listener.
//
// P2P endpoints deliberately do NOT appear here: they live on a separate
// mTLS-only listener (see newP2PMux/StartP2PServer). The public listener must
// be reachable by browsers, which cannot present client certificates.
func newPublicMux() *http.ServeMux {
	mux := http.NewServeMux()

	// Public read endpoints
	mux.HandleFunc("/health", RequestLogger(handleHealth))
	mux.HandleFunc("/chain", RequestLogger(handleGetChain))
	mux.HandleFunc("/blocks", RequestLogger(handleGetBlocks))

	// Stage 4: EVM-backed read endpoints
	mux.HandleFunc("GET /voting-data", RequestLogger(handleGetVotingData))
	mux.HandleFunc("GET /voter/{voter_id}", RequestLogger(handleGetVoterData))
	mux.HandleFunc("GET /candidates", RequestLogger(handleGetCandidates))
	mux.HandleFunc("GET /vote-counts", RequestLogger(handleGetVoteCounts))
	mux.HandleFunc("GET /commitments", RequestLogger(handleGetCommitments))
	mux.HandleFunc("GET /voters", RequestLogger(handleGetVoters))

	// Admin-only write endpoints
	mux.HandleFunc("/add-voter", RequestLogger(AdminAuthMiddleware(handleAddVoter)))

	// Admin-only election lifecycle endpoints (mirror the admin page's phase
	// controls — see packages/nextjs/app/voting/admin/page.tsx)
	mux.HandleFunc("/set-question", RequestLogger(AdminAuthMiddleware(handleSetQuestion)))
	mux.HandleFunc("/set-candidates", RequestLogger(AdminAuthMiddleware(handleSetCandidates)))
	mux.HandleFunc("/start-registration", RequestLogger(AdminAuthMiddleware(handleStartRegistration)))
	mux.HandleFunc("/start-voting", RequestLogger(AdminAuthMiddleware(handleStartVoting)))
	mux.HandleFunc("/end-election", RequestLogger(AdminAuthMiddleware(handleEndElection)))
	mux.HandleFunc("/reset-election", RequestLogger(AdminAuthMiddleware(handleResetElection)))

	// Public voter endpoints — rate limited per IP
	mux.HandleFunc("/register", RequestLogger(RateLimitMiddleware(handleRegister)))
	mux.HandleFunc("/vote", RequestLogger(RateLimitMiddleware(handleVote)))

	return mux
}

// newP2PMux builds the route table for node-to-node traffic. These endpoints
// are only ever served behind mTLS (StartP2PServer) — a client without a valid
// peer certificate cannot even complete the TLS handshake.
func newP2PMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/block", RequestLogger(handleReceiveBlock))
	mux.HandleFunc("/internal/chain", RequestLogger(handleSendChain))
	return mux
}

// StartPublicServer starts the browser-facing API listener and blocks.
// tlsConfig semantics:
//   - nil        → plain HTTP (local development; the default)
//   - non-nil    → HTTPS with NO client-certificate requirement (production
//     behind a real certificate). Never pass the mTLS peer config here —
//     browsers cannot present client certificates.
func StartPublicServer(addr string, tlsConfig *tls.Config) {
	origin := os.Getenv("ALLOWED_ORIGIN")
	if origin == "" {
		origin = "http://localhost:3000" // default Next.js dev server
	}

	server := &http.Server{
		Addr:      addr,
		Handler:   CORSMiddleware(origin, newPublicMux()),
		TLSConfig: tlsConfig,
	}

	if tlsConfig != nil {
		fmt.Printf("Public API (HTTPS) running on %s\n", addr)
		log.Fatal().Err(server.ListenAndServeTLS("", "")).Msg("Public API server stopped")
	} else {
		fmt.Printf("Public API (HTTP) running on %s\n", addr)
		log.Fatal().Err(server.ListenAndServe()).Msg("Public API server stopped")
	}
}

// StartP2PServer starts the mTLS node-to-node listener in a goroutine.
// tlsConfig must be the mutual-TLS config from security.LoadTLSConfig
// (ClientAuth: RequireAndVerifyClientCert) — that requirement is exactly why
// these endpoints live on their own listener instead of the public one.
func StartP2PServer(addr string, tlsConfig *tls.Config) {
	server := &http.Server{
		Addr:      addr,
		Handler:   newP2PMux(),
		TLSConfig: tlsConfig,
	}
	go func() {
		fmt.Printf("P2P listener (mTLS) running on %s\n", addr)
		log.Fatal().Err(server.ListenAndServeTLS("", "")).Msg("P2P server stopped")
	}()
}

// ─── Handlers ────────────────────────────────────────────────────────────────

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func handleGetChain(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"length": bc.Len(),
		"blocks": bc.GetBlocks(),
	})
}

// handleGetBlocks returns the block list. Optional ?page=N&limit=M pagination
// (1-based pages over the chronological list); without both params the full
// chain is returned, preserving the original behavior.
func handleGetBlocks(w http.ResponseWriter, r *http.Request) {
	blocks := bc.GetBlocks()

	pageStr, limitStr := r.URL.Query().Get("page"), r.URL.Query().Get("limit")
	if pageStr != "" || limitStr != "" {
		page, err1 := strconv.Atoi(pageStr)
		limit, err2 := strconv.Atoi(limitStr)
		if err1 != nil || err2 != nil || page < 1 || limit < 1 {
			http.Error(w, "page and limit must be positive integers (both required for pagination)", http.StatusBadRequest)
			return
		}
		start := (page - 1) * limit
		if start > len(blocks) {
			start = len(blocks)
		}
		end := start + limit
		if end > len(blocks) {
			end = len(blocks)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"total":  len(blocks),
			"page":   page,
			"limit":  limit,
			"blocks": blocks[start:end],
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(blocks)
}

// ─── EVM Reads (Stage 4) ────────────────────────────────────────────────────────

// handleGetVotingData returns the current election tally and Merkle tree state,
// read live from the embedded EVM (question, owner, yes/no votes, tree size,
// depth, root). Returns 503 if the contract bridge is unavailable (Stage 1/2
// storage-only mode — see REQUIRE_EVM in main.go).
func handleGetVotingData(w http.ResponseWriter, r *http.Request) {
	if bridge == nil {
		http.Error(w, "EVM bridge not available on this node", http.StatusServiceUnavailable)
		return
	}

	data, err := bridge.GetVotingData()
	if err != nil {
		log.Error().Err(err).Msg("GetVotingData failed")
		http.Error(w, "failed to read voting data: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

// handleGetVoterData returns a single voter's on-chain eligibility/registration
// status. voter_id is the same opaque string used with /add-voter and /register
// (e.g. an email address); it is hashed to the EVM address internally. Returns
// 503 if the contract bridge is unavailable, 400 if voter_id is missing.
func handleGetVoterData(w http.ResponseWriter, r *http.Request) {
	if bridge == nil {
		http.Error(w, "EVM bridge not available on this node", http.StatusServiceUnavailable)
		return
	}

	voterID := r.PathValue("voter_id")
	if voterID == "" {
		http.Error(w, "voter_id is required", http.StatusBadRequest)
		return
	}

	data, err := bridge.GetVoterData(voterID)
	if err != nil {
		log.Error().Err(err).Str("voter_id", voterID).Msg("GetVoterData failed")
		http.Error(w, "failed to read voter data: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

// handleGetCandidates returns the current candidate list, in the same order used
// for vote submission (CandidateIndex) and returned by GET /vote-counts.
func handleGetCandidates(w http.ResponseWriter, r *http.Request) {
	if bridge == nil {
		http.Error(w, "EVM bridge not available on this node", http.StatusServiceUnavailable)
		return
	}

	candidates, err := bridge.GetCandidates()
	if err != nil {
		log.Error().Err(err).Msg("GetCandidates failed")
		http.Error(w, "failed to read candidates: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(candidates)
}

// CandidateTally pairs a candidate name with its current vote count.
// Votes is a decimal string, not a JSON number: on-chain counts are uint256,
// and JavaScript's JSON.parse silently corrupts integers past 2^53. Same
// policy as VotingData's root/election_id fields.
type CandidateTally struct {
	Candidate string `json:"candidate"`
	Votes     string `json:"votes"`
}

// handleGetVoteCounts zips GetCandidates() and GetVoteCounts() together into a
// single response, mirroring how packages/nextjs/app/voting/_components/VotingStats.tsx
// zips the two separate contract reads together client-side today.
func handleGetVoteCounts(w http.ResponseWriter, r *http.Request) {
	if bridge == nil {
		http.Error(w, "EVM bridge not available on this node", http.StatusServiceUnavailable)
		return
	}

	candidates, err := bridge.GetCandidates()
	if err != nil {
		log.Error().Err(err).Msg("GetCandidates failed")
		http.Error(w, "failed to read candidates: "+err.Error(), http.StatusInternalServerError)
		return
	}
	counts, err := bridge.GetVoteCounts()
	if err != nil {
		log.Error().Err(err).Msg("GetVoteCounts failed")
		http.Error(w, "failed to read vote counts: "+err.Error(), http.StatusInternalServerError)
		return
	}

	tally := make([]CandidateTally, 0, len(candidates))
	for i, name := range candidates {
		votes := "0"
		if i < len(counts) {
			votes = counts[i].String()
		}
		tally = append(tally, CandidateTally{Candidate: name, Votes: votes})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tally)
}

// handleGetCommitments returns every registered commitment, in insertion order —
// the same order LeanIMT assigns leaf indices in. This has no EVM/bridge
// dependency; it's derived purely from the blockchain's own REGISTER transaction
// log, so it works even in Stage 1/2 fallback mode.
//
// A client that needs to build a ZK proof (see packages/blockchain/integration-test)
// needs exactly this: the browser gets the equivalent list from Solidity's NewLeaf
// event logs, which this custom chain has no equivalent of, but the underlying
// data was always on-chain — every /register call already validates against the
// EVM before committing (see the Stage 3 hardening pass), so every REGISTER
// transaction on the chain corresponds 1:1 with a real tree leaf.
//
// Commitments are scoped to the current election: everything before the most
// recent RESET_ELECTION transaction belongs to a dead election and is excluded,
// otherwise a client would reconstruct a tree that doesn't match the live root.
func handleGetCommitments(w http.ResponseWriter, r *http.Request) {
	var commitments []string
	for _, block := range bc.GetBlocks() {
		for _, tx := range block.Transactions {
			switch tx.Type {
			case core.TxResetElection:
				commitments = commitments[:0] // everything before a reset belongs to a dead election
			case core.TxRegister:
				var p core.RegisterPayload
				if err := tx.ParsePayload(&p); err != nil {
					log.Error().Err(err).Str("tx_id", tx.ID).Msg("Failed to parse REGISTER payload")
					continue
				}
				commitments = append(commitments, p.Commitment)
			}
		}
	}
	if commitments == nil {
		commitments = []string{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(commitments)
}

// ─── Write responses ──────────────────────────────────────────────────────────

// TxResponse is the client contract for every accepted write: enough to cite
// the on-chain record, nothing about the chain's internal block format. The
// full block remains readable via GET /blocks and GET /chain.
type TxResponse struct {
	TxID       string `json:"tx_id"`
	BlockIndex uint64 `json:"block_index"`
}

// RegisterResponse extends TxResponse with the Merkle leaf index assigned to
// the commitment and the election it belongs to — both go into the voter's
// downloaded Voter Pass.
type RegisterResponse struct {
	TxResponse
	LeafIndex  uint64 `json:"leaf_index"`
	ElectionID string `json:"election_id,omitempty"`
}

// nowBlockTime returns the wall-clock instant used to stamp both the EVM call
// and the committed block, as (milliseconds for the block, seconds for the EVM).
// Using one instant for both is what makes replay deterministic — see
// ContractCaller.SetTime.
func nowBlockTime() (tsMs int64, evmTime uint64) {
	tsMs = time.Now().UnixMilli()
	return tsMs, uint64(tsMs) / 1000
}

// VoterEntry is one allowlist entry in the GET /voters response.
type VoterEntry struct {
	VoterID string `json:"voter_id"`
	Allowed bool   `json:"allowed"`
}

// handleGetVoters returns the current election's allowlist, derived from the
// chain's ADD_VOTER transaction log the same way /commitments derives leaves:
// insertion-ordered, last write per voter wins, everything before the most
// recent RESET_ELECTION excluded. This is the REST replacement for the
// Solidity VoterAdded event history the browser admin tools read on Hardhat.
func handleGetVoters(w http.ResponseWriter, r *http.Request) {
	var order []string
	entries := make(map[string]*VoterEntry)

	for _, block := range bc.GetBlocks() {
		for _, tx := range block.Transactions {
			switch tx.Type {
			case core.TxResetElection:
				order = order[:0]
				entries = make(map[string]*VoterEntry)
			case core.TxAddVoter:
				var p core.AddVoterPayload
				if err := tx.ParsePayload(&p); err != nil {
					log.Error().Err(err).Str("tx_id", tx.ID).Msg("Failed to parse ADD_VOTER payload")
					continue
				}
				if p.VoterID == "" {
					continue // genesis block reuses TxAddVoter with a GenesisPayload
				}
				if existing, ok := entries[p.VoterID]; ok {
					existing.Allowed = p.Allowed
				} else {
					e := &VoterEntry{VoterID: p.VoterID, Allowed: p.Allowed}
					entries[p.VoterID] = e
					order = append(order, p.VoterID)
				}
			}
		}
	}

	result := make([]VoterEntry, 0, len(order))
	for _, id := range order {
		result = append(result, *entries[id])
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// ─── Admin ────────────────────────────────────────────────────────────────────

type AddVoterRequest struct {
	VoterID string `json:"voter_id"`
	// Allowed defaults to true when omitted; send false to revoke a voter
	// (mirrors the admin page's Allow/Revoke radio per address).
	Allowed *bool `json:"allowed,omitempty"`
}

// handleAddVoter calls EVM addVoters() BEFORE committing the ADD_VOTER block.
// addVoters is only effective during Phase.Setup (Voting.sol's inPhase modifier),
// so — unlike the old binary-referendum contract where addVoters never reverted —
// this can now genuinely fail (Voting__WrongPhase) if called outside Setup. Calling
// EVM first, same as register/vote, ensures a rejected call never becomes a
// permanent chain entry.
func handleAddVoter(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var req AddVoterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.VoterID == "" {
		http.Error(w, "invalid request: voter_id required", http.StatusBadRequest)
		return
	}

	allowed := true
	if req.Allowed != nil {
		allowed = *req.Allowed
	}

	tsMs, evmTime := nowBlockTime()
	if bridge != nil {
		if err := bridge.AddVoter(req.VoterID, allowed, evmTime); err != nil {
			log.Warn().Err(err).Str("voter_id", req.VoterID).Msg("EVM addVoters rejected")
			http.Error(w, "add-voter rejected: "+err.Error(), http.StatusBadRequest)
			return
		}
	}

	commitAdminTx(w, core.TxAddVoter, core.AddVoterPayload{VoterID: req.VoterID, Allowed: allowed}, tsMs)
}

// ─── Election lifecycle ─────────────────────────────────────────────────────────
//
// setQuestion/setCandidates/startRegistration/startVoting/endElection/resetElection
// mirror packages/nextjs/app/voting/admin/page.tsx's admin controls exactly — same
// six actions, same phase-gating enforced by the contract. Each handler follows
// the register/vote ordering (call EVM first, commit only on success) rather than
// the old handleAddVoter ordering, since every one of these can genuinely fail on
// phase gating and a rejected transition must not become a permanent chain entry.

// commitAdminTx is the shared tail of every election-lifecycle handler: create a
// transaction, append it to the chain (stamped with the same instant the EVM
// executed at), persist it, and broadcast it to peers. The EVM call has already
// succeeded by the time this runs.
func commitAdminTx(w http.ResponseWriter, txType core.TxType, payload interface{}, tsMs int64) {
	tx, err := core.NewTransaction(txType, payload)
	if err != nil {
		http.Error(w, "failed to create transaction", http.StatusInternalServerError)
		return
	}

	block, err := bc.AddTransactionAt(tx, tsMs)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if err := store.SaveBlock(block); err != nil {
		log.Error().Err(err).Str("tx_type", string(txType)).Msg("Failed to persist block")
	}

	network.BroadcastBlock(*block)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(TxResponse{TxID: tx.ID, BlockIndex: block.Index})
}

type SetQuestionRequest struct {
	Question string `json:"question"`
}

func handleSetQuestion(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req SetQuestionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Question == "" {
		http.Error(w, "invalid request: question required", http.StatusBadRequest)
		return
	}
	tsMs, evmTime := nowBlockTime()
	if bridge != nil {
		if err := bridge.SetQuestion(req.Question, evmTime); err != nil {
			log.Warn().Err(err).Msg("EVM setQuestion rejected")
			http.Error(w, "set-question rejected: "+err.Error(), http.StatusBadRequest)
			return
		}
	}
	commitAdminTx(w, core.TxSetQuestion, core.SetQuestionPayload{Question: req.Question}, tsMs)
}

type SetCandidatesRequest struct {
	Candidates []string `json:"candidates"`
}

func handleSetCandidates(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req SetCandidatesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Candidates) == 0 {
		http.Error(w, "invalid request: at least one candidate required", http.StatusBadRequest)
		return
	}
	tsMs, evmTime := nowBlockTime()
	if bridge != nil {
		if err := bridge.SetCandidates(req.Candidates, evmTime); err != nil {
			log.Warn().Err(err).Msg("EVM setCandidates rejected")
			http.Error(w, "set-candidates rejected: "+err.Error(), http.StatusBadRequest)
			return
		}
	}
	commitAdminTx(w, core.TxSetCandidates, core.SetCandidatesPayload{Candidates: req.Candidates}, tsMs)
}

type DurationRequest struct {
	DurationSec uint64 `json:"duration_sec"`
}

func handleStartRegistration(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req DurationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.DurationSec == 0 {
		http.Error(w, "invalid request: positive duration_sec required", http.StatusBadRequest)
		return
	}
	tsMs, evmTime := nowBlockTime()
	if bridge != nil {
		if err := bridge.StartRegistration(req.DurationSec, evmTime); err != nil {
			log.Warn().Err(err).Msg("EVM startRegistration rejected")
			http.Error(w, "start-registration rejected: "+err.Error(), http.StatusBadRequest)
			return
		}
	}
	commitAdminTx(w, core.TxStartRegistration, core.StartRegistrationPayload{DurationSec: req.DurationSec}, tsMs)
}

func handleStartVoting(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req DurationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.DurationSec == 0 {
		http.Error(w, "invalid request: positive duration_sec required", http.StatusBadRequest)
		return
	}
	tsMs, evmTime := nowBlockTime()
	if bridge != nil {
		if err := bridge.StartVoting(req.DurationSec, evmTime); err != nil {
			log.Warn().Err(err).Msg("EVM startVoting rejected")
			http.Error(w, "start-voting rejected: "+err.Error(), http.StatusBadRequest)
			return
		}
	}
	commitAdminTx(w, core.TxStartVoting, core.StartVotingPayload{DurationSec: req.DurationSec}, tsMs)
}

func handleEndElection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	tsMs, evmTime := nowBlockTime()
	if bridge != nil {
		if err := bridge.EndElection(evmTime); err != nil {
			log.Warn().Err(err).Msg("EVM endElection rejected")
			http.Error(w, "end-election rejected: "+err.Error(), http.StatusBadRequest)
			return
		}
	}
	commitAdminTx(w, core.TxEndElection, struct{}{}, tsMs)
}

func handleResetElection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	tsMs, evmTime := nowBlockTime()
	if bridge != nil {
		if err := bridge.ResetElection(evmTime); err != nil {
			log.Warn().Err(err).Msg("EVM resetElection rejected")
			http.Error(w, "reset-election rejected: "+err.Error(), http.StatusBadRequest)
			return
		}
	}
	commitAdminTx(w, core.TxResetElection, struct{}{}, tsMs)
}

// ─── Register ─────────────────────────────────────────────────────────────────

type RegisterRequest struct {
	VoterID    string `json:"voter_id"`
	Commitment string `json:"commitment"`
}

// handleRegister serializes commitment registration to prevent duplicate leaf indices.
// When the EVM bridge is available, the EVM register() is called BEFORE the block is
// committed. This ensures only commitments that pass on-chain validation (voter is
// allowlisted, commitment is unique) are permanently recorded in the blockchain.
func handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var req RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.VoterID == "" || req.Commitment == "" {
		http.Error(w, "voter_id and commitment are required", http.StatusBadRequest)
		return
	}

	// Serialize registration handling at the HTTP layer too, so that block append
	// order matches EVM insertion order (auditability) and the tx-count fallback
	// path below stays consistent when the EVM bridge is unavailable.
	registrationMu.Lock()
	defer registrationMu.Unlock()

	// Stage 3: call EVM register() BEFORE committing the block.
	// If the EVM rejects the commitment (voter not allowlisted, duplicate commitment,
	// voter already registered), we return an error without touching the blockchain.
	//
	// LeafIndex is read back from the EVM's own tree size (bridge.Register's return
	// value), not derived by counting REGISTER transactions on the chain — a tx-count
	// can drift from the real Merkle index if any legacy/replay-rejected registration
	// ever existed. bridge.Register computes this under its own internal lock, so the
	// value is exact even if other requests are registering concurrently.
	tsMs, evmTime := nowBlockTime()
	var leafIndex uint64
	var electionID string
	if bridge != nil {
		idx, err := bridge.Register(req.VoterID, req.Commitment, evmTime)
		if err != nil {
			log.Warn().Err(err).Str("voter_id", req.VoterID).Msg("EVM register rejected")
			http.Error(w, "registration rejected: "+err.Error(), http.StatusBadRequest)
			return
		}
		leafIndex = idx
		if vd, err := bridge.GetVotingData(); err == nil {
			electionID = vd.ElectionID.String()
		}
	} else {
		// Stage 1/2 fallback mode (no EVM bridge): the transaction count is the
		// best available approximation since there is no on-chain tree to query.
		leafIndex = uint64(len(bc.GetAllTransactions(core.TxRegister)))
	}

	tx, err := core.NewTransaction(core.TxRegister, core.RegisterPayload{
		VoterID:    req.VoterID,
		Commitment: req.Commitment,
		LeafIndex:  leafIndex,
	})
	if err != nil {
		http.Error(w, "failed to create transaction", http.StatusInternalServerError)
		return
	}

	block, err := bc.AddTransactionAt(tx, tsMs)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if err := store.SaveBlock(block); err != nil {
		log.Error().Err(err).Msg("Failed to persist register block")
	}

	network.BroadcastBlock(*block)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(RegisterResponse{
		TxResponse: TxResponse{TxID: tx.ID, BlockIndex: block.Index},
		LeafIndex:  leafIndex,
		ElectionID: electionID,
	})
}

// ─── Vote ─────────────────────────────────────────────────────────────────────

// VoteRequest carries the ZK proof and its public inputs.
// Root and Depth must match the values used when the proof was generated.
// CandidateIndex is the 0-based index into the current candidate list (see
// GET /candidates) — the contract rejects an out-of-range index.
type VoteRequest struct {
	Proof          string `json:"proof"`
	NullifierHash  string `json:"nullifier_hash"`
	Root           string `json:"root"`
	CandidateIndex uint64 `json:"candidate_index"`
	Depth          uint32 `json:"depth"`
}

// handleVote verifies the ZK proof via the embedded EVM BEFORE committing the vote
// block to the blockchain. This guarantees that only cryptographically valid votes
// are permanently recorded. Rejected votes return a 400 with the specific EVM error.
func handleVote(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var req VoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Proof == "" || req.NullifierHash == "" || req.Root == "" {
		http.Error(w, "proof, nullifier_hash, and root are required", http.StatusBadRequest)
		return
	}

	// Stage 3: Verify the ZK proof via the embedded EVM BEFORE committing.
	// The EVM executes Voting.sol::vote() which calls HonkVerifier::verify()
	// using the BN254 pairing precompile. This also checks:
	//   - Root matches current Merkle tree root (prevents stale proof reuse)
	//   - NullifierHash not previously used (prevents double-voting)
	// Only if the EVM call succeeds do we commit the vote to the blockchain.
	tsMs, evmTime := nowBlockTime()
	if bridge != nil {
		if err := bridge.Vote(req.Proof, req.NullifierHash, req.Root, req.CandidateIndex, req.Depth, evmTime); err != nil {
			log.Warn().Err(err).Msg("EVM vote verification failed")
			http.Error(w, "vote rejected: "+err.Error(), http.StatusBadRequest)
			return
		}
	}

	tx, err := core.NewTransaction(core.TxVote, core.VotePayload{
		Proof:          req.Proof,
		NullifierHash:  req.NullifierHash,
		Root:           req.Root,
		CandidateIndex: req.CandidateIndex,
		Depth:          req.Depth,
	})
	if err != nil {
		http.Error(w, "failed to create transaction", http.StatusInternalServerError)
		return
	}

	block, err := bc.AddTransactionAt(tx, tsMs)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if err := store.SaveBlock(block); err != nil {
		log.Error().Err(err).Msg("Failed to persist vote block")
	}

	network.BroadcastBlock(*block)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(TxResponse{TxID: tx.ID, BlockIndex: block.Index})
}

// ─── P2P Internal ─────────────────────────────────────────────────────────────

// handleReceiveBlock accepts a block broadcast from a peer.
// It uses AppendExternalBlock (not AddBlock) to preserve the original hash,
// index, and timestamp so all nodes hold an identical chain.
// After appending, the block's transactions are replayed through the EVM so
// the local EVM state stays in sync with the peer's writes.
func handleReceiveBlock(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var block core.Block
	if err := json.NewDecoder(r.Body).Decode(&block); err != nil {
		http.Error(w, "invalid block payload", http.StatusBadRequest)
		return
	}

	if err := bc.AppendExternalBlock(&block); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}

	if err := store.SaveBlock(&block); err != nil {
		log.Error().Err(err).Msg("Failed to persist received block")
	}

	// Replay the peer block's transactions into the local EVM so that
	// the EVM state mirrors what the originating node recorded, executing at
	// the block's own timestamp so phase-deadline decisions match the origin.
	if bridge != nil {
		for _, tx := range block.Transactions {
			if err := bridge.ReplayTransaction(tx, evm.BlockEVMTime(block.Timestamp)); err != nil {
				log.Warn().
					Err(err).
					Str("tx_id", tx.ID).
					Str("tx_type", string(tx.Type)).
					Uint64("block", block.Index).
					Msg("EVM replay of peer transaction failed")
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "block accepted"})
}

func handleSendChain(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(bc.GetBlocks())
}
