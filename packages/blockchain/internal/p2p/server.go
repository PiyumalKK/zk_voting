package p2p

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/rs/zerolog/log"

	"zk-blockchain/internal/chain"
	"zk-blockchain/internal/config"
)

// maxPushBodyBytes caps a pushed block's encoded size. A block on this chain
// holds exactly one transaction (auto-mine, MASTER §3) and the largest
// transaction the app sends is a HonkVerifier deployment at roughly 22 KB of
// bytecode, so 16 MiB is four orders of magnitude of headroom — the number
// is a bound on what a peer can make this node allocate, not a limit anyone
// is expected to approach.
const maxPushBodyBytes = 16 << 20

// BlockStore is what the P2P server needs from the local chain in order to
// serve reads. internal/chain.Sequencer satisfies it.
//
// It is an interface rather than a *chain.Sequencer so that this package's
// tests can drive the handlers against a chain that is deliberately broken
// (a database that errors, a height that jumps) without having to
// manufacture such a chain for real.
type BlockStore interface {
	HeadInfo() (uint64, common.Hash, error)
	BlockByNumber(n uint64) (*types.Block, error)
}

// BlockApplier is what a replica needs in order to accept a pushed block.
// The implementation is *Follower (follower.go), which wraps the
// Sequencer's verifying apply path and adds gap-triggered catch-up.
type BlockApplier interface {
	ApplyBlock(block *types.Block) error
}

// HandlerConfig configures NewHandler.
type HandlerConfig struct {
	// Role decides whether pushes are accepted. A primary serves reads and
	// refuses POST /p2p/block: on a single-sequencer chain (MASTER §3) the
	// only node allowed to extend the chain is the one that seals, and
	// accepting a block from elsewhere is how a second writer would appear.
	Role config.Role
	// Chain serves /p2p/head and /p2p/blocks. Required for both roles —
	// a replica answers head queries too, which is how the cluster test and
	// the health endpoint compare heights across all three nodes.
	Chain BlockStore
	// Applier is required when Role is replica and ignored otherwise.
	Applier BlockApplier
	// MaxPullLimit caps how many blocks one /p2p/blocks response may carry.
	// Zero means MaxPullLimit.
	MaxPullLimit int
}

type handler struct {
	role     config.Role
	chain    BlockStore
	applier  BlockApplier
	maxLimit int
}

// NewHandler builds the P2P HTTP handler. It is an ordinary http.Handler
// with no TLS knowledge of its own — NewP2PServer wraps it in the mTLS
// listener, and the tests exercise both the plain handler (fast, focused on
// protocol behaviour) and the full TLS composition (tls_test.go).
func NewHandler(cfg HandlerConfig) (http.Handler, error) {
	if cfg.Chain == nil {
		return nil, errors.New("p2p: a BlockStore is required")
	}
	if cfg.Role == config.RoleReplica && cfg.Applier == nil {
		return nil, errors.New("p2p: a replica needs a BlockApplier to accept pushed blocks")
	}
	if cfg.Role != config.RolePrimary && cfg.Role != config.RoleReplica {
		return nil, fmt.Errorf("p2p: unknown role %q", cfg.Role)
	}

	limit := cfg.MaxPullLimit
	if limit <= 0 {
		limit = MaxPullLimit
	}

	h := &handler{role: cfg.Role, chain: cfg.Chain, applier: cfg.Applier, maxLimit: limit}

	mux := http.NewServeMux()
	mux.HandleFunc(PathHead, h.handleHead)
	mux.HandleFunc(PathBlocks, h.handleBlocks)
	mux.HandleFunc(PathBlock, h.handleBlock)
	return mux, nil
}

// NewP2PServer wraps handler in an HTTP server configured for the mTLS
// listener. The caller supplies the TLS configuration (ServerTLSConfig) and
// runs it; cmd/node does both in M10's phase B.
func NewP2PServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		// Generous but finite: a push carries one block and a catch-up
		// response carries up to MaxPullLimit of them, over a link that is
		// local or datacentre-local in every deployment this project has.
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
	}
}

// handleHead answers GET /p2p/head.
func (h *handler) handleHead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, CodeMalformed, "GET only")
		return
	}

	number, hash, err := h.chain.HeadInfo()
	if err != nil {
		writeError(w, http.StatusInternalServerError, CodeInternal, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, HeadResponse{Number: number, Hash: hash})
}

// handleBlocks answers GET /p2p/blocks?from=N&limit=M — the catch-up pull a
// replica uses at boot and after any gap.
//
// Asking for blocks this node does not have is not an error: a replica that
// is level with the primary asks for head+1 every time it polls, and a
// 404-per-poll would make an idle, healthy cluster look broken. It returns
// an empty list and its current head instead.
func (h *handler) handleBlocks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, CodeMalformed, "GET only")
		return
	}

	from, err := parseUintQuery(r, "from", 0)
	if err != nil {
		writeError(w, http.StatusBadRequest, CodeMalformed, err.Error())
		return
	}
	if from == 0 {
		// Genesis is never transmitted (internal/chain.ErrGenesisPush): every
		// node derives it from its own configuration, so a request starting
		// at 0 is a caller bug worth naming rather than silently shifting.
		writeError(w, http.StatusBadRequest, CodeMalformed, "from must be at least 1; genesis is derived locally, never transferred")
		return
	}

	limit, err := parseUintQuery(r, "limit", uint64(DefaultPullLimit))
	if err != nil {
		writeError(w, http.StatusBadRequest, CodeMalformed, err.Error())
		return
	}
	if limit == 0 || limit > uint64(h.maxLimit) {
		limit = uint64(h.maxLimit)
	}

	head, _, err := h.chain.HeadInfo()
	if err != nil {
		writeError(w, http.StatusInternalServerError, CodeInternal, err.Error())
		return
	}

	resp := BlocksResponse{Head: head, Blocks: []BlockMessage{}}
	for n := from; n <= head && uint64(len(resp.Blocks)) < limit; n++ {
		block, err := h.chain.BlockByNumber(n)
		if err != nil {
			writeError(w, http.StatusInternalServerError, CodeInternal, fmt.Sprintf("reading block %d: %v", n, err))
			return
		}
		msg, err := EncodeBlock(block)
		if err != nil {
			writeError(w, http.StatusInternalServerError, CodeInternal, err.Error())
			return
		}
		resp.Blocks = append(resp.Blocks, msg)
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleBlock answers POST /p2p/block — the primary announcing a sealed
// block to a replica.
//
// The status codes are chosen so a pusher can act on them without reading
// the body: 200 means "this block is on my chain" (whether this push put it
// there or an earlier one did), 409 means "I will not take it", 4xx anything
// else means the request was malformed, 5xx means I failed. Only 5xx and the
// gap case are worth retrying, which is what pusher.go does.
func (h *handler) handleBlock(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, CodeMalformed, "POST only")
		return
	}
	if h.role != config.RoleReplica {
		writeError(w, http.StatusForbidden, CodeRefused,
			"this node is the sequencer; it extends the chain by sealing, never by accepting blocks")
		return
	}

	var msg BlockMessage
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPushBodyBytes)).Decode(&msg); err != nil {
		writeError(w, http.StatusBadRequest, CodeMalformed, fmt.Sprintf("decoding the request body: %v", err))
		return
	}
	block, err := msg.Decode()
	if err != nil {
		writeError(w, http.StatusBadRequest, CodeMalformed, err.Error())
		return
	}

	peer := peerName(r)
	if err := h.applier.ApplyBlock(block); err != nil {
		h.writeApplyError(w, block, peer, err)
		return
	}

	log.Debug().
		Uint64("number", block.NumberU64()).
		Str("hash", block.Hash().Hex()).
		Str("peer", peer).
		Msg("applied a pushed block")
	writeJSON(w, http.StatusOK, PushResponse{Status: StatusApplied, Number: block.NumberU64()})
}

// writeApplyError translates the apply path's typed errors into wire
// responses. Each case exists because the caller reacts differently to it —
// that is the whole reason internal/chain returns typed errors instead of
// formatted strings.
func (h *handler) writeApplyError(w http.ResponseWriter, block *types.Block, peer string, err error) {
	number := block.NumberU64()

	// Already applied is a success. Pushes are at-least-once, so a duplicate
	// after a slow-but-successful delivery is routine traffic.
	if errors.Is(err, chain.ErrBlockAlreadyApplied) {
		writeJSON(w, http.StatusOK, PushResponse{Status: StatusDuplicate, Number: number})
		return
	}

	// A gap is self-healing: the replica pulls what it is missing. Reported
	// at info level, with the height it needs, so the pusher and anyone
	// reading logs can see how far behind it is.
	var outOfOrder *chain.OutOfOrderError
	if errors.As(err, &outOfOrder) {
		log.Info().
			Uint64("offered", outOfOrder.Offered).
			Uint64("expected", outOfOrder.Expected).
			Str("peer", peer).
			Msg("pushed block is ahead of this node; catching up")
		writeJSONError(w, http.StatusConflict, ErrorResponse{
			Code:     CodeGap,
			Message:  err.Error(),
			Expected: outOfOrder.Expected,
		})
		return
	}

	// The tamper-evidence path (M10 deliverable 2). Re-execution disagreed
	// with what the header claims, so either the sender fabricated the block
	// or the two nodes are not running the same rules. Both are emergencies
	// and neither is retryable — hence Error level and an explicit CRITICAL,
	// which is the string an operator greps for.
	var mismatch *chain.ReplayMismatch
	if errors.As(err, &mismatch) {
		log.Error().
			Uint64("block", mismatch.Block).
			Str("field", mismatch.Field).
			Str("got", mismatch.Got).
			Str("want", mismatch.Want).
			Str("peer", peer).
			Msg("CRITICAL state root mismatch: refusing a block whose header does not match its own execution")
		writeJSONError(w, http.StatusConflict, ErrorResponse{Code: CodeStateMismatch, Message: err.Error()})
		return
	}

	// A different block already occupies this height: history was rewritten,
	// or this replica is following two chains. Equally critical, equally
	// unretryable, and the local block is kept.
	if errors.Is(err, chain.ErrForkDetected) {
		log.Error().
			Uint64("block", number).
			Str("offered", block.Hash().Hex()).
			Str("peer", peer).
			Msg("CRITICAL fork detected: a different block is already canonical at this height")
		writeJSONError(w, http.StatusConflict, ErrorResponse{Code: CodeFork, Message: err.Error()})
		return
	}

	// Genesis is a protocol violation rather than a chain disagreement: no
	// honest peer ever sends block 0.
	if errors.Is(err, chain.ErrGenesisPush) {
		writeJSONError(w, http.StatusBadRequest, ErrorResponse{Code: CodeMalformed, Message: err.Error()})
		return
	}

	log.Error().Err(err).Uint64("block", number).Str("peer", peer).Msg("failed to apply a pushed block")
	writeJSONError(w, http.StatusInternalServerError, ErrorResponse{Code: CodeInternal, Message: err.Error()})
}

// peerName reports the common name from the client certificate, for logs.
// The connection cannot exist without a certificate the cluster CA signed
// (tls.go), so this is an authenticated identity rather than a claim — but
// it is empty for the plain-HTTP handler the protocol tests use, which is
// why every caller treats it as decoration only.
func peerName(r *http.Request) string {
	if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
		return ""
	}
	return r.TLS.PeerCertificates[0].Subject.CommonName
}

// parseUintQuery reads a non-negative integer query parameter, returning
// def when it is absent or empty.
func parseUintQuery(r *http.Request, name string, def uint64) (uint64, error) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return def, nil
	}
	v, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be a non-negative integer, got %q", name, raw)
	}
	return v, nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		// The status line and headers are already on the wire, so there is
		// nothing left to tell the client. Logging is all that remains.
		log.Debug().Err(err).Msg("writing a p2p response body")
	}
}

func writeJSONError(w http.ResponseWriter, status int, body ErrorResponse) {
	writeJSON(w, status, body)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSONError(w, status, ErrorResponse{Code: code, Message: message})
}
