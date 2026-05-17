package network

import (
	"bytes"
	"encoding/json"
	"log"

	"zk-blockchain/internal/core"
)

// BroadcastBlock sends a newly created block to all known peer nodes
// over TLS-encrypted HTTPS connections.
//
// SECURITY CHANGE: Previously used http.Post() (plain HTTP), which sent
// block data — including votes, nullifier hashes, and proofs — in cleartext
// across the network. Any attacker with network access could intercept and
// read this data (man-in-the-middle attack).
//
// Now uses the TLS-configured secureClient (from client.go), which:
//   - Encrypts all block data in transit using AES symmetric encryption
//   - Verifies message integrity with SHA-256 HMAC
//   - Establishes encrypted channels via TLS handshake (asymmetric key exchange)
//
// Each peer is contacted in a separate goroutine for concurrent broadcasting.
func BroadcastBlock(block core.Block) {
	for _, peer := range Peers {

		go func(url string) {
			data, _ := json.Marshal(block)

			// Uses the TLS-secured HTTP client instead of plain http.Post()
			// The secureClient encrypts all data before sending over the network
			resp, err := secureClient.Post(
				url+"/internal/block",
				"application/json",
				bytes.NewBuffer(data),
			)

			if err != nil {
				log.Println("❌ Failed to send to", url, ":", err)
				return
			}
			defer resp.Body.Close()
		}(peer)
	}
}