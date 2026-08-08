package rpc

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/rs/zerolog/log"
)

// Write forwarding (M10 deliverable 3): a replica answers every read from its
// own verified state, and hands anything that would change state to the
// primary.
//
// Why forward at the HTTP layer instead of implementing eth_sendRawTransaction
// as an RPC method that calls the primary:
//
//   - M10 requires the primary's response *verbatim*. The revert path is the
//     reason: MASTER §10 pitfall 1/2 make the exact JSON-RPC error object —
//     code 3, message "execution reverted", and the raw revert bytes in
//     `data` — part of this chain's contract with viem and ethers. Decoding
//     that into Go and re-encoding it is an opportunity to change it. Copying
//     the bytes is not.
//   - It generalises. Any method that mutates state is forwarded by rule
//     rather than by having been remembered, so M07's dev namespaces and
//     anything added later are covered without a second edit here.
//
// The cost is that this handler has to read the request body to see the
// method name. That is bounded (maxRPCBodyBytes) and the body is handed
// on intact, so a locally-served request is unaffected apart from one copy.

// maxRPCBodyBytes caps a JSON-RPC request body. A signed vote transaction is
// a few hundred bytes; a HonkVerifier deployment is about 22 KB. 16 MiB is
// far past anything legitimate and exists so that peeking at the method name
// cannot be turned into an unbounded allocation.
const maxRPCBodyBytes = 16 << 20

// DefaultForwardTimeout bounds one forwarded call. It must exceed the
// primary's own work: eth_sendRawTransaction executes and seals the
// transaction before answering, and the slowest such call in this app is a
// ~4.7M-gas verifier deployment.
const DefaultForwardTimeout = 30 * time.Second

// writeMethods are the eth_ methods a replica must not answer locally.
//
// eth_sendTransaction is included even though this node never implements it
// (no accounts are managed here, so it answers -32601): if it is ever added
// on the primary, forwarding it is already correct, and forwarding a method
// the primary also rejects produces the primary's own error rather than a
// subtly different one from a replica.
var writeMethods = map[string]bool{
	"eth_sendRawTransaction": true,
	"eth_sendTransaction":    true,
}

// devNamespacePrefixes are forwarded wholesale. Every method in them mutates
// chain state outside a transaction (M07), which on this topology only the
// sequencer may do — a replica that mined its own empty block would fork the
// cluster instantly.
var devNamespacePrefixes = []string{"evm_", "hardhat_", "anvil_"}

// ShouldForward reports whether a replica must hand this method to the
// primary rather than answer it itself.
func ShouldForward(method string) bool {
	if writeMethods[method] {
		return true
	}
	for _, prefix := range devNamespacePrefixes {
		if strings.HasPrefix(method, prefix) {
			return true
		}
	}
	return false
}

// Forwarder proxies a JSON-RPC request to another node and copies the answer
// back unchanged.
//
// It has two shapes, and the difference between them is not merely where the
// request goes but what happens when it cannot get there:
//
//	static (solo)   target is fixed at construction (PRIMARY_RPC_URL). An
//	                unreachable primary is reported as -32603 and the request
//	                is *never* served locally: on a single-sequencer chain a
//	                replica that answered a write itself would fork the
//	                cluster.
//	dynamic (bft)   resolve names the current proposer, which changes with
//	                every height and every round change, so it cannot be
//	                captured at construction. An unreachable proposer falls
//	                back to *local* handling, because under consensus every
//	                validator is a legitimate entry point — the local engine
//	                queues the request and a round change carries it. This is
//	                what makes forwarding a latency optimisation rather than a
//	                correctness requirement, and it is why killing the current
//	                proposer does not stop writes.
type Forwarder struct {
	target string
	// resolve is nil for a static forwarder. When set, it returns the URL to
	// forward to and false when this node should handle the request itself.
	resolve func() (string, bool)
	client  *http.Client
}

// NewForwarder builds a forwarder pointed at the primary's public JSON-RPC
// URL (config.PrimaryRPCURL). A zero timeout means DefaultForwardTimeout.
func NewForwarder(primaryRPCURL string, timeout time.Duration) (*Forwarder, error) {
	parsed, err := url.Parse(strings.TrimSpace(primaryRPCURL))
	if err != nil {
		return nil, fmt.Errorf("invalid PRIMARY_RPC_URL %q: %w", primaryRPCURL, err)
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("invalid PRIMARY_RPC_URL %q: must include scheme and host", primaryRPCURL)
	}
	if timeout <= 0 {
		timeout = DefaultForwardTimeout
	}
	return &Forwarder{target: parsed.String(), client: &http.Client{Timeout: timeout}}, nil
}

// NewDynamicForwarder builds a forwarder whose target is resolved per
// request, for BFT mode: resolve returns the current proposer's JSON-RPC URL,
// and false when this node is the proposer or the proposer's address is not
// known.
//
// resolve returning false is not an error. It means "handle this here", which
// under consensus is always a valid answer — see the type's doc comment.
func NewDynamicForwarder(resolve func() (string, bool), timeout time.Duration) *Forwarder {
	if timeout <= 0 {
		timeout = DefaultForwardTimeout
	}
	return &Forwarder{resolve: resolve, client: &http.Client{Timeout: timeout}}
}

// Target reports where writes are being sent — used in the startup log,
// where "which primary" is the first thing to check when a replica's writes
// fail. A dynamic forwarder has no fixed target and reports the proposer it
// would use right now.
func (f *Forwarder) Target() string {
	if f.resolve == nil {
		return f.target
	}
	if target, ok := f.resolve(); ok {
		return target
	}
	return "(this node)"
}

// dynamic reports whether an unreachable target may fall back to local
// handling.
func (f *Forwarder) dynamic() bool { return f.resolve != nil }

// resolveTarget picks the URL for this request, and reports false when the
// request should be handled locally.
func (f *Forwarder) resolveTarget() (string, bool) {
	if f.resolve == nil {
		return f.target, true
	}
	return f.resolve()
}

// forward proxies one request body and copies status, content type and body
// back to the client.
//
// local is used only by a dynamic forwarder, and only when the target cannot
// be reached — see the Forwarder doc comment for why a static one must never
// fall back.
func (f *Forwarder) forward(w http.ResponseWriter, r *http.Request, body []byte, local http.Handler) {
	target, ok := f.resolveTarget()
	if !ok {
		// Dynamic only: this node is the proposer, or the proposer's RPC URL
		// is not configured. Either way it handles the request itself.
		local.ServeHTTP(w, r)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		writeRPCTransportError(w, fmt.Sprintf("building the forwarded request: %v", err))
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := f.client.Do(req)
	if err != nil {
		if f.dynamic() {
			// The proposer is down. Under consensus that is a survivable,
			// expected state — one validator is allowed to fail — so this
			// node takes the request itself: its engine queues it, the round
			// times out, the proposership rotates, and the transaction lands
			// one round later. Reporting an error here instead is what would
			// let a single dead validator stop the election.
			log.Warn().Err(err).Str("proposer", target).
				Msg("the current proposer is unreachable; handling this write locally and letting a round change carry it")
			local.ServeHTTP(w, r)
			return
		}
		// Static (solo): the primary being unreachable is this node's problem
		// to report, and it must be reported as a JSON-RPC error — viem and
		// ethers parse the body, and an HTTP 502 with an HTML body surfaces
		// to a voter as an unintelligible client-side exception. Serving the
		// write locally is not an option: it would fork the cluster.
		log.Error().Err(err).Str("primary", target).Msg("forwarding a write to the primary failed")
		writeRPCTransportError(w, fmt.Sprintf("cannot reach the sequencer at %s: %v", target, err))
		return
	}
	defer func() { _ = resp.Body.Close() }()

	payload, err := io.ReadAll(io.LimitReader(resp.Body, maxRPCBodyBytes))
	if err != nil {
		writeRPCTransportError(w, fmt.Sprintf("reading the sequencer's response: %v", err))
		return
	}

	if contentType := resp.Header.Get("Content-Type"); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	} else {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(resp.StatusCode)
	if _, err := w.Write(payload); err != nil {
		log.Debug().Err(err).Msg("writing a forwarded response")
	}
}

// writeRPCTransportError answers with a JSON-RPC error object rather than a
// bare HTTP status. -32603 (internal error) is the correct code: the request
// was well formed, and this node failed to service it.
//
// The id is null, which the spec allows when the request's id could not be
// determined or the failure is not tied to one request. viem surfaces the
// message, which is what an operator needs to see.
func writeRPCTransportError(w http.ResponseWriter, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      nil,
		"error":   map[string]any{"code": -32603, "message": message},
	})
}

// NewForwardingHandler wraps the local JSON-RPC handler so that
// state-changing calls go to the primary instead.
//
// Batch handling: a batch is forwarded whole if *any* member is a write. The
// primary serves reads too, so the answers are correct either way, and the
// alternative — splitting a batch, serving half locally and half remotely,
// then reassembling in request order — would be a lot of machinery to save
// one node a few reads. It also preserves the property that a batch is
// executed in one place, in order, which is what a caller batching a write
// and a follow-up read is relying on.
func NewForwardingHandler(local http.Handler, forwarder *Forwarder) http.Handler {
	if forwarder == nil {
		return local
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Body == nil {
			// GETs and the like are not JSON-RPC calls; let the local server
			// answer (or reject) them as it always has.
			local.ServeHTTP(w, r)
			return
		}

		// MaxBytesReader rather than io.LimitReader: a body over the cap must
		// be an error, not a silent truncation. Truncating would hand the
		// local server a half-read JSON document and report it as a parse
		// error, which is a confusing way to say "too large".
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRPCBodyBytes))
		_ = r.Body.Close()
		if err != nil {
			writeRPCTransportError(w, fmt.Sprintf("reading the request body: %v", err))
			return
		}
		// Whatever happens next, the local handler must see the body it would
		// have seen.
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))

		if bodyNeedsForwarding(body) {
			forwarder.forward(w, r, body, local)
			return
		}
		local.ServeHTTP(w, r)
	})
}

// bodyNeedsForwarding inspects a JSON-RPC request body for method names.
//
// A body it cannot parse is *not* forwarded: go-ethereum's server already
// produces the correct -32700/-32600 responses for malformed input, and
// reproducing that here would be a second, less accurate parser. The cost of
// being wrong in this direction is an error message from the wrong node; the
// cost of being wrong in the other is a malformed write silently disappearing
// into the primary.
func bodyNeedsForwarding(body []byte) bool {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return false
	}

	// Only the method field is decoded; params (which can be megabytes of
	// transaction data) are left as raw JSON.
	type rpcMethodOnly struct {
		Method string `json:"method"`
	}

	if trimmed[0] == '[' {
		var batch []rpcMethodOnly
		if err := json.Unmarshal(trimmed, &batch); err != nil {
			return false
		}
		for _, call := range batch {
			if ShouldForward(call.Method) {
				return true
			}
		}
		return false
	}

	var single rpcMethodOnly
	if err := json.Unmarshal(trimmed, &single); err != nil {
		return false
	}
	return ShouldForward(single.Method)
}
