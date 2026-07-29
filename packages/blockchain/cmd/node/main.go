// Command node is the entrypoint for the packages/blockchain v2 Go node:
// config → logging → HTTP server (health-only in M01; the full JSON-RPC
// surface is mounted starting M04) → graceful shutdown.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"zk-blockchain/internal/config"
	"zk-blockchain/internal/rpc"
)

// shutdownTimeout bounds how long graceful shutdown waits for in-flight
// requests to finish before the listener is forced closed.
const shutdownTimeout = 10 * time.Second

func main() {
	// Load a local .env file if present (dev convenience only — real
	// deployments set real environment variables; missing files are
	// silently ignored).
	_ = godotenv.Load()

	cfg, err := config.Load()
	if err != nil {
		// Deliberately printed before logging is configured: a
		// misconfiguration must never be swallowed by a broken logger.
		fmt.Fprintf(os.Stderr, "invalid configuration:\n%v\n", err)
		os.Exit(1)
	}

	configureLogging(cfg)

	log.Info().
		Uint64("chainId", cfg.ChainID).
		Str("role", string(cfg.Role)).
		Int("rpcPort", cfg.RPCPort).
		Str("dataDir", cfg.DataDir).
		Msg("starting zk-blockchain node")

	mux := http.NewServeMux()
	// M01 has no chain yet, so height always reports 0. M02+ replaces this
	// provider with a function reading the real chain head.
	mux.Handle("/health", rpc.NewHealthHandler(cfg.ChainID, string(cfg.Role), func() uint64 { return 0 }))

	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.RPCPort),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	serveErr := make(chan error, 1)
	go func() {
		log.Info().Str("addr", server.Addr).Msg("listening")
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	select {
	case <-ctx.Done():
		log.Info().Msg("shutdown signal received")
	case err := <-serveErr:
		if err != nil {
			log.Fatal().Err(err).Msg("server failed to start")
		}
		return
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Error().Err(err).Msg("graceful shutdown failed; forcing close")
		_ = server.Close()
		os.Exit(1)
	}

	log.Info().Msg("clean shutdown complete")
}

func configureLogging(cfg *config.Config) {
	level, err := zerolog.ParseLevel(cfg.LogLevel)
	if err != nil {
		// Config.Validate already guarantees LogLevel is one of the known
		// values, so this defends against future drift rather than
		// anything reachable today.
		level = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(level)

	if cfg.LogFormat == "console" {
		log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339})
	} else {
		log.Logger = zerolog.New(os.Stderr).With().Timestamp().Logger()
	}
}
