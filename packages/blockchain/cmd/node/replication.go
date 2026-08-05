package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/rs/zerolog/log"

	"zk-blockchain/internal/chain"
	"zk-blockchain/internal/config"
	"zk-blockchain/internal/p2p"
	"zk-blockchain/internal/rpc"
)

// Replication wiring (M10). Everything role-dependent lives here so main.go
// stays the same linear story it has been since M01: config → storage →
// genesis → sequencer → RPC → serve.
//
// The three shapes a node can take:
//
//	primary, no PEERS   standalone. No certificates are read, no P2P port is
//	                    opened, nothing changes from M09. This is what
//	                    `make run` and every gate from M05 to M09 use, and
//	                    keeping it certificate-free is why the P2P listener
//	                    is conditional rather than always-on.
//	primary, PEERS set  sequencer plus announcements: serves /p2p/blocks and
//	                    /p2p/head for catch-up, pushes each sealed block.
//	replica             follows: accepts pushes, pulls what it missed, serves
//	                    reads locally, forwards writes to the primary.

// p2pShutdownTimeout bounds how long the P2P listener is given to finish
// in-flight requests. A push is one block; a catch-up page is at most
// MaxPullLimit of them.
const p2pShutdownTimeout = 5 * time.Second

// replication owns the background machinery a clustered node runs: the P2P
// listener, the follower loop (replica) or push workers (primary), and the
// RPC write forwarder (replica).
//
// A standalone node gets a zero-value one, whose methods all do nothing —
// so main.go has no role branches of its own.
type replication struct {
	server    *http.Server
	follower  *p2p.Follower
	forwarder *rpc.Forwarder

	cancel context.CancelFunc
	wg     sync.WaitGroup
	errs   chan error
}

// startReplication builds and starts whatever cfg.Role requires. The
// returned value is never nil; shutdown must be called on it.
func startReplication(cfg *config.Config, seq *chain.Sequencer) (*replication, error) {
	ctx, cancel := context.WithCancel(context.Background())
	r := &replication{cancel: cancel, errs: make(chan error, 1)}

	switch cfg.Role {
	case config.RolePrimary:
		if len(cfg.Peers) == 0 {
			log.Debug().Msg("no PEERS configured; running standalone (no P2P listener, no certificates required)")
			return r, nil
		}
		if err := r.startPrimary(ctx, cfg, seq); err != nil {
			r.shutdownNow()
			return nil, err
		}

	case config.RoleReplica:
		if err := r.startReplica(ctx, cfg, seq); err != nil {
			r.shutdownNow()
			return nil, err
		}

	default:
		r.shutdownNow()
		return nil, fmt.Errorf("unknown role %q", cfg.Role)
	}

	return r, nil
}

// startPrimary opens the P2P listener replicas pull from and starts the push
// workers that announce every sealed block.
func (r *replication) startPrimary(ctx context.Context, cfg *config.Config, seq *chain.Sequencer) error {
	clientTLS, err := p2p.ClientTLSConfig(cfg.TLSCert, cfg.TLSKey, cfg.TLSCA)
	if err != nil {
		return fmt.Errorf("p2p client TLS (run `make gen-certs`, or unset PEERS to run standalone): %w", err)
	}

	peers := make([]*p2p.Client, 0, len(cfg.Peers))
	for _, url := range cfg.Peers {
		client, err := p2p.NewClient(url, clientTLS, 0)
		if err != nil {
			return fmt.Errorf("peer %q: %w", url, err)
		}
		peers = append(peers, client)
	}

	handler, err := p2p.NewHandler(p2p.HandlerConfig{Role: config.RolePrimary, Chain: seq})
	if err != nil {
		return err
	}
	if err := r.serveP2P(cfg, handler); err != nil {
		return err
	}

	// Subscribe before returning, and therefore before the RPC server starts
	// accepting transactions: a subscription taken later would miss blocks
	// sealed in between, and those replicas would only recover on their next
	// poll.
	pusher := p2p.NewPusher(p2p.PusherConfig{Peers: peers})
	events := seq.Subscribe(p2p.DefaultPushQueueSize)

	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		pusher.Run(ctx, events)
	}()

	log.Info().
		Int("peers", len(peers)).
		Int("p2pPort", cfg.P2PPort).
		Msg("sequencer will announce sealed blocks to its replicas")
	return nil
}

// startReplica opens the P2P listener the primary pushes to, starts the
// catch-up loop, and builds the RPC write forwarder.
func (r *replication) startReplica(ctx context.Context, cfg *config.Config, seq *chain.Sequencer) error {
	clientTLS, err := p2p.ClientTLSConfig(cfg.TLSCert, cfg.TLSKey, cfg.TLSCA)
	if err != nil {
		return fmt.Errorf("p2p client TLS (run `make gen-certs`): %w", err)
	}

	primary, err := p2p.NewClient(cfg.ReplicaPullURL, clientTLS, 0)
	if err != nil {
		return fmt.Errorf("REPLICA_PULL_URL: %w", err)
	}

	follower, err := p2p.NewFollower(p2p.FollowerConfig{Chain: seq, Applier: seq, Primary: primary})
	if err != nil {
		return err
	}
	r.follower = follower

	handler, err := p2p.NewHandler(p2p.HandlerConfig{
		Role:    config.RoleReplica,
		Chain:   seq,
		Applier: follower,
	})
	if err != nil {
		return err
	}
	if err := r.serveP2P(cfg, handler); err != nil {
		return err
	}

	forwarder, err := rpc.NewForwarder(cfg.PrimaryRPCURL, 0)
	if err != nil {
		return err
	}
	r.forwarder = forwarder

	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		follower.Run(ctx)
	}()

	log.Info().
		Str("pullFrom", cfg.ReplicaPullURL).
		Str("forwardWritesTo", forwarder.Target()).
		Int("p2pPort", cfg.P2PPort).
		Msg("replica following the sequencer")
	return nil
}

// serveP2P starts the mTLS listener on P2P_PORT.
func (r *replication) serveP2P(cfg *config.Config, handler http.Handler) error {
	serverTLS, err := p2p.ServerTLSConfig(cfg.TLSCert, cfg.TLSKey, cfg.TLSCA)
	if err != nil {
		return fmt.Errorf("p2p server TLS (run `make gen-certs`): %w", err)
	}

	server := p2p.NewP2PServer(fmt.Sprintf(":%d", cfg.P2PPort), handler)
	server.TLSConfig = serverTLS
	r.server = server

	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		log.Info().Str("addr", server.Addr).Msg("p2p listening (mTLS)")
		// Empty file names: the certificate and key are already loaded into
		// TLSConfig, which is what ListenAndServeTLS falls back to.
		if err := server.ListenAndServeTLS("", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
			select {
			case r.errs <- fmt.Errorf("p2p server: %w", err):
			default:
			}
		}
	}()
	return nil
}

// Errors reports a fatal failure of the P2P listener — a port already in
// use, most often. main selects on it alongside the RPC server's own error,
// because a replica that cannot be pushed to is not a working replica and
// should say so at startup rather than quietly serve a chain that stops
// advancing.
func (r *replication) Errors() <-chan error { return r.errs }

// Forwarder is the RPC write forwarder, or nil on a node that seals its own
// transactions.
func (r *replication) Forwarder() *rpc.Forwarder {
	if r == nil {
		return nil
	}
	return r.forwarder
}

// ReplicaStatus is the /health status provider, or nil on a primary.
func (r *replication) ReplicaStatus() rpc.ReplicaStatusProvider {
	if r == nil || r.follower == nil {
		return nil
	}
	return func() (uint64, bool) {
		status := r.follower.Status()
		return status.PrimaryHeight, status.Synced
	}
}

// shutdown stops the listener and waits for the background loops.
func (r *replication) shutdown(ctx context.Context) {
	if r == nil {
		return
	}
	if r.server != nil {
		if err := r.server.Shutdown(ctx); err != nil {
			log.Warn().Err(err).Msg("p2p server did not shut down cleanly; forcing close")
			_ = r.server.Close()
		}
	}
	r.shutdownNow()
}

// shutdownNow cancels the background loops and waits for them, without
// touching the listener. Used on the construction-failure path, where a
// partially started replication still has goroutines to stop.
func (r *replication) shutdownNow() {
	if r.cancel != nil {
		r.cancel()
	}
	r.wg.Wait()
}
