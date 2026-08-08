package rpc

import (
	"fmt"
	"net/http"
	"time"

	"github.com/rs/zerolog/log"

	gethrpc "github.com/ethereum/go-ethereum/rpc"

	"zk-blockchain/internal/chain"
)

// ServerConfig is the projection of internal/config.Config the JSON-RPC
// services need. It exists (M06) instead of a growing positional parameter
// list on NewJSONRPCServer: M05 needed only the chain id, M06 added the log
// range cap, and M07 adds the DEV_RPC flag and client-version mode — each of
// which would otherwise be another unlabelled uint64/bool/string at a call
// site.
type ServerConfig struct {
	ChainID uint64
	// LogRangeLimit caps how many blocks a single eth_getLogs query may
	// span (config.LogRangeLimit). 0 disables the cap.
	LogRangeLimit uint64
	// DevRPC enables the evm_/hardhat_/anvil_ namespaces (config.DevRPC,
	// MASTER §7's DEV_RPC). When false those namespaces are never
	// registered at all, so every method in them answers -32601 — see the
	// gating note in dev.go.
	DevRPC bool
	// ClientVersionMode selects what web3_clientVersion reports
	// (config.ClientVersionMode: "zkchain" or "anvil"). Empty means the
	// default, "zkchain".
	ClientVersionMode string
	// Writer is the write path eth_sendRawTransaction and the dev namespaces
	// drive. nil — every caller before CONSENSUS_MODE existed — means the
	// Sequencer itself, i.e. seal directly, which is solo mode's behaviour
	// unchanged. In BFT mode cmd/node passes the consensus engine. See
	// proposer.go.
	Writer Proposer
}

// NewJSONRPCServer builds a *gethrpc.Server with the eth/net/web3
// namespaces registered (M04 read methods + M05 write methods + M06
// eth_getLogs, the latter two as additional receivers under the same "eth"
// name; M07 adds "evm"/"hardhat"/"anvil").
// gethrpc.Server implements http.Handler directly (rpc/http.go) and
// natively batches JSON-RPC array requests and returns -32601/-32602 for
// unknown methods/malformed params — "geth server gives this free" per the
// M04 spec, so none of that is reimplemented here.
func NewJSONRPCServer(seq *chain.Sequencer, cfg ServerConfig) (*gethrpc.Server, error) {
	srv := gethrpc.NewServer()

	// Reads always come from seq directly; only writes are routed. A nil
	// Writer is the pre-consensus behaviour: the Sequencer is its own
	// proposer, sealing whatever it executes.
	writer := cfg.Writer
	if writer == nil {
		writer = seq
	}

	if err := srv.RegisterName("eth", NewEthService(seq, cfg.ChainID)); err != nil {
		return nil, fmt.Errorf("register eth namespace: %w", err)
	}
	// Second receiver, same namespace: go-ethereum's serviceRegistry merges
	// callbacks into the existing "eth" service entry rather than replacing
	// it, so the read methods above and the write methods here end up in one
	// flat eth_* namespace (M05; see eth_write.go's package doc comment).
	//
	// *** If this ever returns an error, or the read methods stop resolving
	// once the write ones are registered: *** the fix is to embed
	// *EthWriteService in EthService and make a single RegisterName call —
	// Go promotes an embedded type's methods into the outer type's method
	// set, which the registry's reflection-based scan picks up regardless of
	// how it handles duplicate names. internal/rpc's tests exercise a read
	// method and a write method against the same server, so a regression
	// here fails loudly rather than silently dropping half the namespace.
	if err := srv.RegisterName("eth", NewEthWriteService(seq, writer, cfg.ChainID)); err != nil {
		return nil, fmt.Errorf("register eth write namespace: %w", err)
	}
	// Third receiver, same namespace (M06) — same merge behavior as the
	// second, and covered by the same regression guard: internal/rpc's
	// tests hit a read, a write and a logs method against one server.
	if err := srv.RegisterName("eth", NewEthLogsService(seq, cfg.LogRangeLimit)); err != nil {
		return nil, fmt.Errorf("register eth logs namespace: %w", err)
	}
	if err := srv.RegisterName("net", NewNetService(cfg.ChainID)); err != nil {
		return nil, fmt.Errorf("register net namespace: %w", err)
	}
	if err := srv.RegisterName("web3", NewWeb3Service(cfg.ClientVersionMode)); err != nil {
		return nil, fmt.Errorf("register web3 namespace: %w", err)
	}

	// M07's dev namespaces are gated *by not existing*: when DEV_RPC is
	// false nothing below runs, so go-ethereum's dispatcher answers -32601
	// for evm_*/hardhat_*/anvil_* exactly as it does for a method that was
	// never written. That is stronger than a per-method flag check — there
	// is no code path on a production node that can reach a state mutation
	// outside a transaction.
	if cfg.DevRPC {
		if err := srv.RegisterName("evm", NewEvmService(seq, writer)); err != nil {
			return nil, fmt.Errorf("register evm namespace: %w", err)
		}
		if err := srv.RegisterName("hardhat", NewHardhatService(writer)); err != nil {
			return nil, fmt.Errorf("register hardhat namespace: %w", err)
		}
		// Alias namespace, same underlying service (MASTER §9 lists both
		// spellings). Registered separately rather than as a fourth receiver
		// on "hardhat" because these are genuinely different namespaces, not
		// two halves of one.
		if err := srv.RegisterName("anvil", NewAnvilService(writer)); err != nil {
			return nil, fmt.Errorf("register anvil namespace: %w", err)
		}
		log.Warn().Msg("DEV_RPC is enabled: evm_*, hardhat_setBalance and anvil_setBalance can mutate chain state — never enable this on a production node")
	}

	return srv, nil
}

// MuxConfig configures NewMux's middleware stack — a narrow projection of
// internal/config.Config so this package doesn't import config directly
// (cmd/node is the only place that needs to know both).
type MuxConfig struct {
	CORSOrigins    []string
	RateLimitRPS   float64
	RateLimitBurst int
	// Forwarder, when non-nil, sends state-changing JSON-RPC calls to the
	// primary instead of answering them locally (M10 deliverable 3). It is
	// nil on a primary and on a standalone node, which leaves the RPC
	// surface exactly as it was through M09.
	Forwarder *Forwarder
}

// NewMux builds the node's full HTTP surface: /health plus the JSON-RPC
// server at "/", wrapped in logging -> CORS -> rate-limit middleware
// (outermost first, in that order): logging sees every request including
// ones the later stages reject; CORS runs before rate limiting so a
// preflight OPTIONS request is answered immediately without consuming a
// rate-limit token or reaching the RPC dispatcher.
func NewMux(healthHandler http.Handler, rpcServer *gethrpc.Server, cfg MuxConfig) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/health", healthHandler)
	// NewForwardingHandler is the identity function when cfg.Forwarder is
	// nil, so this line is a no-op for every node that is not a replica.
	mux.Handle("/", NewForwardingHandler(rpcServer, cfg.Forwarder))

	limiter := NewRateLimiter(cfg.RateLimitRPS, cfg.RateLimitBurst)

	h := http.Handler(mux)
	h = RateLimitMiddleware(limiter, h)
	h = CORSMiddleware(cfg.CORSOrigins, h)
	h = LoggingMiddleware(h)
	return h
}

// CORSMiddleware applies MASTER §7's CORS_ORIGINS policy: "*" allows any
// origin, otherwise only origins in the explicit allowlist get
// Access-Control-Allow-Origin echoed back. Preflight (OPTIONS) requests are
// answered directly with 204 and never reach next.
func CORSMiddleware(origins []string, next http.Handler) http.Handler {
	wildcard := len(origins) == 1 && origins[0] == "*"
	allowed := make(map[string]bool, len(origins))
	for _, o := range origins {
		allowed[o] = true
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			switch {
			case wildcard:
				w.Header().Set("Access-Control-Allow-Origin", "*")
			case allowed[origin]:
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
			}
		}
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// LoggingMiddleware logs every request at debug level (M04 deliverable 1:
// "request logging at debug") — method, path, remote address, and how long
// the handler took.
func LoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Debug().
			Str("method", r.Method).
			Str("path", r.URL.Path).
			Str("remote", r.RemoteAddr).
			Dur("duration", time.Since(start)).
			Msg("rpc request")
	})
}
