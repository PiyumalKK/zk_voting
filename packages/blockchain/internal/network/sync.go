package network

import (
	"encoding/json"
	"zk-blockchain/internal/core"

	"github.com/rs/zerolog/log"
)

// SyncWithPeers fetches the chain from each peer and replaces our local chain
// if a peer has a longer valid chain (longest-chain rule).
// Must be called after InitNetworkClient so the mTLS client is ready.
func SyncWithPeers(bc **core.Blockchain, store interface {
	SaveBlockchain(*core.Blockchain) error
}) {
	if tlsClient == nil {
		log.Warn().Msg("TLS client not initialized — skipping peer sync")
		return
	}

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

		if len(remoteBlocks) <= len((*bc).GetBlocks()) {
			continue
		}

		loaded, err := core.LoadFromBlocks(remoteBlocks)
		if err != nil {
			log.Warn().Err(err).Str("peer", peer).Msg("Peer sent invalid chain — rejecting")
			continue
		}

		*bc = loaded
		if err := store.SaveBlockchain(*bc); err != nil {
			log.Error().Err(err).Msg("Failed to persist synced chain to disk")
		}
		log.Info().Str("peer", peer).Int("blocks", len(remoteBlocks)).Msg("Chain synced from peer")
	}
}
