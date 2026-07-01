package api

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"

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

// StartServer registers all routes and starts the TLS server.
// tlsConfig must be fully initialized before calling this (load it in main and
// call network.InitNetworkClient first so that peer sync works on startup).
func StartServer(port string, tlsConfig *tls.Config) {
	origin := os.Getenv("ALLOWED_ORIGIN")
	if origin == "" {
		origin = "http://localhost:3000" // default Next.js dev server
	}

	mux := http.NewServeMux()

	// Public read endpoints
	mux.HandleFunc("/health", RequestLogger(handleHealth))
	mux.HandleFunc("/chain", RequestLogger(handleGetChain))
	mux.HandleFunc("/blocks", RequestLogger(handleGetBlocks))

	// Admin-only write endpoint
	mux.HandleFunc("/add-voter", RequestLogger(AdminAuthMiddleware(handleAddVoter)))

	// Public voter endpoints — rate limited per IP
	mux.HandleFunc("/register", RequestLogger(RateLimitMiddleware(handleRegister)))
	mux.HandleFunc("/vote", RequestLogger(RateLimitMiddleware(handleVote)))

	// Internal P2P endpoints — reachable only via mTLS
	mux.HandleFunc("/internal/block", RequestLogger(handleReceiveBlock))
	mux.HandleFunc("/internal/chain", RequestLogger(handleSendChain))

	server := &http.Server{
		Addr:      port,
		Handler:   CORSMiddleware(origin, mux),
		TLSConfig: tlsConfig,
	}

	fmt.Printf("Secure Blockchain Node running on %s\n", port)
	log.Fatal().Err(server.ListenAndServeTLS("", "")).Msg("Server stopped")
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

func handleGetBlocks(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(bc.GetBlocks())
}

// ─── Admin ────────────────────────────────────────────────────────────────────

type AddVoterRequest struct {
	VoterID string `json:"voter_id"`
}

// handleAddVoter commits an ADD_VOTER block, then calls EVM addVoters() to update
// the on-chain allowlist. The EVM call is best-effort — a failure is logged but
// does not roll back the block, because addVoters is idempotent and will succeed
// on the next replay.
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

	tx, err := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{
		VoterID: req.VoterID,
		Allowed: true,
	})
	if err != nil {
		http.Error(w, "failed to create transaction", http.StatusInternalServerError)
		return
	}

	block, err := bc.AddTransaction(tx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if err := store.SaveBlock(block); err != nil {
		log.Error().Err(err).Msg("Failed to persist add-voter block")
	}

	network.BroadcastBlock(*block)

	// Update EVM state: mark voter as allowed in the Voting contract.
	// Best-effort — addVoters never reverts, so failure here indicates a
	// misconfiguration that will surface as an error during vote verification.
	if bridge != nil {
		if err := bridge.AddVoter(req.VoterID, true); err != nil {
			log.Error().Err(err).Str("voter_id", req.VoterID).Msg("EVM addVoters call failed")
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(block)
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
	var leafIndex uint64
	if bridge != nil {
		idx, err := bridge.Register(req.VoterID, req.Commitment)
		if err != nil {
			log.Warn().Err(err).Str("voter_id", req.VoterID).Msg("EVM register rejected")
			http.Error(w, "registration rejected: "+err.Error(), http.StatusBadRequest)
			return
		}
		leafIndex = idx
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

	block, err := bc.AddTransaction(tx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if err := store.SaveBlock(block); err != nil {
		log.Error().Err(err).Msg("Failed to persist register block")
	}

	network.BroadcastBlock(*block)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(block)
}

// ─── Vote ─────────────────────────────────────────────────────────────────────

// VoteRequest carries the ZK proof and its public inputs.
// Root and Depth must match the values used when the proof was generated.
type VoteRequest struct {
	Proof         string `json:"proof"`
	NullifierHash string `json:"nullifier_hash"`
	Root          string `json:"root"`
	Vote          bool   `json:"vote"`
	Depth         uint32 `json:"depth"`
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
	if bridge != nil {
		if err := bridge.Vote(req.Proof, req.NullifierHash, req.Root, req.Vote, req.Depth); err != nil {
			log.Warn().Err(err).Msg("EVM vote verification failed")
			http.Error(w, "vote rejected: "+err.Error(), http.StatusBadRequest)
			return
		}
	}

	tx, err := core.NewTransaction(core.TxVote, core.VotePayload{
		Proof:         req.Proof,
		NullifierHash: req.NullifierHash,
		Root:          req.Root,
		Vote:          req.Vote,
		Depth:         req.Depth,
	})
	if err != nil {
		http.Error(w, "failed to create transaction", http.StatusInternalServerError)
		return
	}

	block, err := bc.AddTransaction(tx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if err := store.SaveBlock(block); err != nil {
		log.Error().Err(err).Msg("Failed to persist vote block")
	}

	network.BroadcastBlock(*block)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(block)
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
	// the EVM state mirrors what the originating node recorded.
	if bridge != nil {
		for _, tx := range block.Transactions {
			if err := bridge.ReplayTransaction(tx); err != nil {
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
