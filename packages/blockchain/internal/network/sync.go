package network

import (
	"encoding/json"
	"sync"
	"time"
	"zk-blockchain/internal/core"

	"github.com/rs/zerolog/log"
)

// SyncWithPeers fetches the chain from each peer and replaces our local chain
// if a peer has a longer valid chain (longest-chain rule). Returns true if any
// peer's chain was adopted.
//
// bc is mutated in place via Blockchain.ReplaceBlocks rather than having its
// pointer swapped — see ReplaceBlocks's doc comment for why that distinction
// matters once this is called periodically (StartPeriodicSync) rather than only
// once at startup. Must be called after InitNetworkClient so the mTLS client
// is ready.
func SyncWithPeers(bc *core.Blockchain, store interface {
	SaveBlockchain(*core.Blockchain) error
}) bool {
	if tlsClient == nil {
		log.Warn().Msg("TLS client not initialized — skipping peer sync")
		return false
	}

	synced := false

	for _, peer := range Peers {
		log.Debug().Str("peer", peer).Msg("Attempting to sync with peer")

		resp, err := tlsClient.Get(peer + "/internal/chain")
		if err != nil {
			log.Debug().Err(err).Str("peer", peer).Msg("Could not reach peer for sync")
			continue
		}

		var remoteBlocks []*core.Block
		decodeErr := json.NewDecoder(resp.Body).Decode(&remoteBlocks)
		resp.Body.Close() // close immediately — do not defer inside a loop

		if decodeErr != nil {
			log.Debug().Err(decodeErr).Str("peer", peer).Msg("Failed to decode chain from peer")
			continue
		}

		if len(remoteBlocks) <= bc.Len() {
			continue
		}

		if err := bc.ReplaceBlocks(remoteBlocks); err != nil {
			log.Warn().Err(err).Str("peer", peer).Msg("Peer sent invalid chain — rejecting")
			continue
		}

		if err := store.SaveBlockchain(bc); err != nil {
			log.Error().Err(err).Msg("Failed to persist synced chain to disk")
		}
		log.Info().Str("peer", peer).Int("blocks", len(remoteBlocks)).Msg("Chain synced from peer")
		synced = true
	}

	return synced
}

// StartPeriodicSync runs SyncWithPeers on a fixed interval in a background
// goroutine, for the lifetime of the process. This is the fix for the "Live Node
// Drift" gap documented in PLAN.md Stage 1.4: BroadcastBlock is fire-and-forget,
// so a peer that's briefly offline (or whose POST fails) silently falls behind
// and previously had no way to catch up short of a full restart. This ticker
// makes that self-healing: every interval, each live node re-checks its peers
// and adopts any longer valid chain it finds.
//
// onSync, if non-nil, is called (synchronously, from the ticker goroutine) every
// time a tick actually adopts a peer's chain — the caller uses this to rebuild the
// EVM state from the adopted chain, since ReplaceBlocks only updates the
// core.Blockchain, not any derived EVM state.
//
// lock/unlock, if non-nil, are held around the whole SyncWithPeers + onSync step so
// the chain replacement and EVM rebuild are serialized against request handlers
// (the api write lock). Pass nil,nil to run unsynchronized (e.g. tests).
//
// Returns a stop function that terminates the background goroutine and blocks
// until it has fully exited — not just signaled to exit. That distinction
// matters: Go's `select` picks pseudo-randomly among ready cases, so a done
// channel alone doesn't guarantee the loop won't process one more already-ready
// tick after stop() is called. Blocking until the goroutine actually returns
// gives callers (tests tearing down shared package state; any future
// graceful-shutdown path) a real guarantee that no more syncs will happen once
// stop() returns. main.go doesn't currently call this — the node has no
// graceful-shutdown path today, it just runs until killed — but the return
// value is cheap to provide and tests rely on it.
func StartPeriodicSync(bc *core.Blockchain, store interface {
	SaveBlockchain(*core.Blockchain) error
}, interval time.Duration, onSync func(), lock, unlock func()) (stop func()) {
	if interval <= 0 {
		log.Info().Msg("Periodic peer sync disabled (interval <= 0)")
		return func() {}
	}

	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if lock != nil {
					lock()
				}
				if SyncWithPeers(bc, store) && onSync != nil {
					onSync()
				}
				if unlock != nil {
					unlock()
				}
			}
		}
	}()

	log.Info().Dur("interval", interval).Msg("Periodic peer sync started")

	var once sync.Once
	return func() {
		once.Do(func() {
			close(done)
			<-finished
		})
	}
}
