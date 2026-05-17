package network

// Peers is the list of known peer node addresses in the blockchain network.
//
// SECURITY CHANGE: URLs updated from http:// to https:// to enforce
// TLS-encrypted communication between all nodes. All peer-to-peer traffic
// (block broadcasts, chain synchronisation) now travels through an
// encrypted TLS tunnel, preventing eavesdropping and tampering.
//
// With HTTPS, the communication is protected by:
//   - Asymmetric encryption (ECDSA) during the TLS handshake for key exchange
//   - Symmetric encryption (AES-GCM) for bulk data transfer (fast)
//   - SHA-256 HMAC for message integrity verification
var Peers = []string{
	"https://localhost:3001",
	"https://localhost:3002",
	"https://localhost:3003",
}