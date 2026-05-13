package network

import (
	"encoding/json"
	"net/http"

	"zk-blockchain/internal/core"
)

func SyncWithPeers(bc **core.Blockchain, store interface {
	SaveBlockchain(*core.Blockchain) error
}) {

	for _, peer := range Peers {

		resp, err := http.Get(peer + "/internal/chain")
		if err != nil {
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