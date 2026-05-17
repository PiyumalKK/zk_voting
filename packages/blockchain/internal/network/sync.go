package network

import (
	"encoding/json"

	"zk-blockchain/internal/core"
)

// SyncWithPeers contacts all known peer nodes over TLS-encrypted HTTPS
// connections to synchronise the local blockchain with the longest valid chain.
//
// SECURITY CHANGE: Previously used http.Get() (plain HTTP), which downloaded
// the entire blockchain from peers in cleartext. This exposed all election
// data (voter registrations, votes, proofs) to network eavesdroppers.
//
// Now uses the TLS-configured secureClient (from client.go), which:
//   - Encrypts the chain data in transit using AES symmetric encryption
//   - Verifies data integrity with SHA-256 HMAC (detects tampering)
//   - Authenticates the peer's identity via its TLS certificate
//
// The sync process also validates the received chain's integrity using
// LoadFromBlocks(), which performs SHA-256 hash verification on every
// block and transaction before accepting the chain. This provides
// defence-in-depth: even if TLS is somehow compromised, the hash-chain
// integrity check will catch any modified blocks.
func SyncWithPeers(bc **core.Blockchain, store interface {
	SaveBlockchain(*core.Blockchain) error
}) {

	for _, peer := range Peers {

		// Uses the TLS-secured HTTP client instead of plain http.Get()
		// All chain data is encrypted during transfer between nodes
		resp, err := secureClient.Get(peer + "/internal/chain")
		if err != nil {
			continue
		}
		defer resp.Body.Close()

		var remoteBlocks []*core.Block
		if err := json.NewDecoder(resp.Body).Decode(&remoteBlocks); err != nil {
			continue
		}

		if len(remoteBlocks) > len((*bc).GetBlocks()) {

			// LoadFromBlocks validates the entire chain integrity (SHA-256 hashes)
			// before accepting it — this is a second layer of security beyond TLS
			loaded, err := core.LoadFromBlocks(remoteBlocks)
			if err == nil {
				*bc = loaded
				store.SaveBlockchain(*bc)
			}
		}
	}
}