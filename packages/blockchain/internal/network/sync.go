package network

import (
	"encoding/json"
	"zk-blockchain/internal/core"

	"github.com/rs/zerolog/log"
)

func SyncWithPeers(bc **core.Blockchain, store interface {
	SaveBlockchain(*core.Blockchain) error
}) {
	if tlsClient == nil {
		log.Warn().Msg("⚠️ TLS Client not initialized, skipping sync")
		return
	}

	for _, peer := range Peers {
		log.Debug().Str("peer", peer).Msg("Attempting to sync with peer")
		resp, err := tlsClient.Get(peer + "/internal/chain")
		if err != nil {
			log.Debug().Err(err).Str("peer", peer).Msg("Failed to connect to peer for sync")
			continue
		}
		defer resp.Body.Close()

		var remoteBlocks []*core.Block
		if err := json.NewDecoder(resp.Body).Decode(&remoteBlocks); err != nil {
			continue
		}

		if len(remoteBlocks) > len((*bc).GetBlocks()) {

			loaded, err := core.LoadFromBlocks(remoteBlocks)
			if err == nil {
				*bc = loaded
				store.SaveBlockchain(*bc)
			}
		}
	}
}
