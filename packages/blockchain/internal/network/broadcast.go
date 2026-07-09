package network

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"net/http"

	"github.com/rs/zerolog/log"
	"zk-blockchain/internal/core"
)

var tlsClient *http.Client

// InitNetworkClient sets up the mTLS HTTP client for broadcasting blocks.
func InitNetworkClient(tlsConfig *tls.Config) {
	tlsClient = &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: tlsConfig,
		},
	}
}

func BroadcastBlock(block core.Block) {
	if tlsClient == nil {
		log.Warn().Msg("⚠️ TLS Client not initialized, skipping broadcast")
		return
	}

	for _, peer := range Peers {
		go func(url string) {
			data, _ := json.Marshal(block)

			// Assuming peers are configured with "https://"
			resp, err := tlsClient.Post(
				url+"/internal/block",
				"application/json",
				bytes.NewBuffer(data),
			)

			if err != nil {
				log.Warn().Err(err).Str("peer", url).Msg("Failed to broadcast block")
				return
			}
			defer resp.Body.Close()
		}(peer)
	}
}
