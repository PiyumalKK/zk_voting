package network

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"

	"zk-blockchain/internal/core"
)

func BroadcastBlock(block core.Block) {
	for _, peer := range Peers {

		go func(url string) {
			data, _ := json.Marshal(block)

			resp, err := http.Post(
				url+"/internal/block",
				"application/json",
				bytes.NewBuffer(data),
			)

			if err != nil {
				log.Println("❌ Failed to send to", url)
				return
			}
			defer resp.Body.Close()
		}(peer)
	}
}