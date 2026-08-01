// Command node is the entrypoint for the packages/blockchain v2 Go node:
// config → logging → storage/genesis (M02) → sequencer (M03) → JSON-RPC +
// health HTTP server (M04) → graceful shutdown.
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

	"zk-blockchain/internal/chain"
	"zk-blockchain/internal/config"
	"zk-blockchain/internal/rpc"
	"zk-blockchain/internal/state"
	"zk-blockchain/internal/storage"
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

	db, err := storage.Open(cfg.DataDir)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to open chain database")
	}
	defer func() {
		if err := db.Close(); err != nil {
			log.Error().Err(err).Msg("error closing chain database")
		}
	}()

	genesisBlock, err := state.EnsureGenesis(db, cfg)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to ensure genesis")
	}
	log.Info().
		Str("genesisHash", genesisBlock.Hash().Hex()).
		Uint64("chainId", cfg.ChainID).
		Uint64("height", state.Height(db)).
		Msg("genesis ready")

	// Fail fast on a data directory whose head cannot be served (M09
	// deliverable 1). Without this the node would start, accept
	// transactions, and only fail on the first state read — by which point
	// the operator is debugging an RPC error rather than a storage problem,
	// and the sequencer may have sealed blocks on top of a root it cannot
	// read. VerifyHead's error names cmd/audit, which turns "the state is
	// broken" into "the state is broken at block N".
	head, err := state.VerifyHead(db)
	if err != nil {
		log.Fatal().Err(err).Msg("chain head failed its startup integrity check")
	}
	log.Info().
		Uint64("height", head.Number.Uint64()).
		Str("headHash", head.Hash().Hex()).
		Str("stateRoot", head.Root.Hex()).
		Uint64("headTimestamp", head.Time).
		Msg("chain head recovered")

	chainCfg := state.ChainConfig(cfg.ChainID)
	seq := chain.New(db, chainCfg, cfg.BlockGasLimit)

	// chain.New seeds the dev clock from the head when that head is ahead of
	// wall clock (a chain that used evm_increaseTime, e.g. the data
	// directory M08's contract-test gate leaves behind). Logged because a
	// non-zero value here explains block timestamps that would otherwise
	// look wrong, and because a large one is worth an operator's attention.
	if offset := seq.DevOffsetSeconds(); offset != 0 {
		log.Warn().
			Int64("devOffsetSeconds", offset).
			Msg("chain head is ahead of wall clock; dev clock seeded from it so block timestamps continue from the head")
	}

	rpcServer, err := rpc.NewJSONRPCServer(seq, rpc.ServerConfig{
		ChainID:           cfg.ChainID,
		LogRangeLimit:     cfg.LogRangeLimit,
		DevRPC:            cfg.DevRPC,
		ClientVersionMode: cfg.ClientVersionMode,
	})
	if err != nil {
		log.Fatal().Err(err).Msg("failed to build JSON-RPC server")
	}
	defer rpcServer.Stop()

	// Replication (M10) starts before the RPC server so that a primary's
	// block subscription is in place before the first transaction can be
	// accepted, and a replica is already following before it serves its
	// first read. On a standalone node this does nothing at all.
	repl, err := startReplication(cfg, seq)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to start replication")
	}

	healthHandler := rpc.NewHealthHandler(cfg.ChainID, string(cfg.Role), func() uint64 { return state.Height(db) }).
		WithReplicaStatus(repl.ReplicaStatus())
	handler := rpc.NewMux(healthHandler, rpcServer, rpc.MuxConfig{
		CORSOrigins:    cfg.CORSOrigins,
		RateLimitRPS:   cfg.RPCRateLimitRPS,
		RateLimitBurst: cfg.RPCRateLimitBurst,
		Forwarder:      repl.Forwarder(),
	})

	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.RPCPort),
		Handler:           handler,
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
	case err := <-repl.Errors():
		// A replica that cannot be pushed to, or a primary whose replicas
		// cannot pull from it, is not doing its job — better to fail at
		// startup than to serve a chain that quietly stops advancing.
		log.Fatal().Err(err).Msg("p2p server failed")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	p2pCtx, cancelP2P := context.WithTimeout(context.Background(), p2pShutdownTimeout)
	defer cancelP2P()
	repl.shutdown(p2pCtx)

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
