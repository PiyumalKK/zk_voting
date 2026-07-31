package rpc

import (
	"fmt"
	"net/http"
	"time"

	"github.com/rs/zerolog/log"

	gethrpc "github.com/ethereum/go-ethereum/rpc"

	"zk-blockchain/internal/chain"
)

// NewJSONRPCServer builds a *gethrpc.Server with the eth/net/web3
// namespaces registered (M04; M05 adds write methods to the same "eth"
// registration by extending EthService, M07 adds "evm"/"hardhat"/"anvil").
// gethrpc.Server implements http.Handler directly (rpc/http.go) and
// natively batches JSON-RPC array requests and returns -32601/-32602 for
// unknown methods/malformed params — "geth server gives this free" per the
// M04 spec, so none of that is reimplemented here.
func NewJSONRPCServer(seq *chain.Sequencer, chainID uint64) (*gethrpc.Server, error) {
	srv := gethrpc.NewServer()

	if err := srv.RegisterName("eth", NewEthService(seq, chainID)); err != nil {
		return nil, fmt.Errorf("register eth namespace: %w", err)
	}
	if err := srv.RegisterName("net", NewNetService(chainID)); err != nil {
		return nil, fmt.Errorf("register net namespace: %w", err)
	}
	if err := srv.RegisterName("web3", NewWeb3Service()); err != nil {
		return nil, fmt.Errorf("register web3 namespace: %w", err)
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
	mux.Handle("/", rpcServer)

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
