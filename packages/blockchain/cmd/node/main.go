package main

import (
	"fmt"
	"os"
	"path/filepath"
	"zk-blockchain/internal/api"
	"zk-blockchain/internal/core"
	"zk-blockchain/internal/persistence"
	"zk-blockchain/internal/network"
	"zk-blockchain/internal/security"
)

func main() {
	nodeID := os.Getenv("NODE_ID")
	if nodeID == "" {
		nodeID = "3001"
	}

	port := ":" + nodeID
	dataDir := "data_" + nodeID

	store := persistence.NewFileStore(dataDir)

	// ── AES-256-GCM Storage Encryption Setup ────────────────────────────
	// If ENCRYPTION_KEY is set, all blockchain data is encrypted at rest
	// using AES-256-GCM (symmetric encryption).
	//
	// How it works:
	//   1. The passphrase is hashed with SHA-256 to derive a 32-byte AES key
	//   2. When saving: JSON data → AES-256-GCM encrypt → write "ZKENC" + ciphertext
	//   3. When loading: detect "ZKENC" prefix → AES-256-GCM decrypt → parse JSON
	//
	// BACKWARD COMPATIBLE: If no ENCRYPTION_KEY is set, files are stored
	// as plaintext JSON (original behaviour). Existing unencrypted files
	// will load normally even after this feature is added.
	//
	// Environment variable: ENCRYPTION_KEY (any passphrase string)
	encryptionKey := os.Getenv("ENCRYPTION_KEY")
	if encryptionKey != "" {
		store.SetEncryptionKey(encryptionKey)
	}

	// ── HMAC-SHA256 Admin Authentication Setup ──────────────────────────
	// If ADMIN_API_KEY is set, the /add-voter endpoint requires
	// HMAC-SHA256 authentication. The admin must include:
	//   Header: X-HMAC-Signature: HMAC-SHA256(request_body, api_key)
	//
	// This is a SYMMETRIC KEY authentication scheme — the same secret key
	// is shared between the admin client and the server.
	//
	// Environment variable: ADMIN_API_KEY (shared secret string)
	adminAPIKey := os.Getenv("ADMIN_API_KEY")

	// ── RSA Digital Signature Setup ─────────────────────────────────────
	// Generate or load an RSA-2048 key pair for admin transaction signing.
	//
	// RSA is an ASYMMETRIC encryption algorithm that uses two mathematically
	// related keys:
	//   - PRIVATE KEY (secret): Used by the admin to SIGN transactions.
	//     Stored with restricted permissions (0600 — owner read/write only).
	//   - PUBLIC KEY (distributed): Used by all nodes to VERIFY signatures.
	//     Can be freely shared — knowing the public key does NOT reveal
	//     the private key (based on the difficulty of factoring large primes).
	//
	// Digital signatures provide three security guarantees:
	//   1. AUTHENTICATION: Only the private key holder (admin) can create signatures
	//   2. INTEGRITY: Any modification invalidates the signature
	//   3. NON-REPUDIATION: The admin cannot deny having signed a transaction
	//
	// The RSA key pair is stored in the node's data directory under keys/.
	keyDir := filepath.Join(dataDir, "keys")
	rsaKeys, err := security.GenerateRSAKeyPair(keyDir)
	if err != nil {
		fmt.Println("❌ Failed to setup RSA key pair:", err)
		os.Exit(1)
	}

	// ── TLS Certificate Setup ───────────────────────────────────────────
	// Generate or load a self-signed TLS certificate for this node.
	// Each node gets its own certificate stored in its data directory.
	//
	// The certificate contains:
	//   - The node's ECDSA public key (shared with connecting clients/peers)
	//   - Identity information (organisation, hostname)
	//   - A digital signature (self-signed with the node's private key)
	//
	// The private key is stored separately with restricted file permissions
	// (0600) — only the owner can read it. This is the SECRET half of the
	// asymmetric key pair used during TLS handshakes.
	certDir := filepath.Join(dataDir, "certs")
	tlsCfg, err := security.GenerateSelfSignedCert(certDir)
	if err != nil {
		fmt.Println("❌ Failed to setup TLS certificates:", err)
		os.Exit(1)
	}

	// Load the TLS configuration with modern cipher suites
	// This configures which encryption algorithms the server will accept:
	//   - ECDHE for key exchange (provides forward secrecy)
	//   - AES-GCM for symmetric data encryption
	//   - SHA-256/384 for integrity verification
	serverTLSConfig, err := security.NewServerTLSConfig(tlsCfg.CertFile, tlsCfg.KeyFile)
	if err != nil {
		fmt.Println("❌ Failed to load TLS configuration:", err)
		os.Exit(1)
	}

	// ── Blockchain Initialisation ───────────────────────────────────────
	var bc *core.Blockchain

	if store.Exists() {
		loaded, err := store.LoadBlockchain()
		if err != nil {
			fmt.Println("❌ Failed to load blockchain:", err)
			os.Exit(1)
		}
		bc = loaded
	} else {
		bc = core.NewBlockchain("Do you support this proposal?")
		store.SaveBlockchain(bc)
	}

	// Sync with peers over TLS-encrypted connections (https://)
	network.SyncWithPeers(&bc, store)

	// ── Start HTTPS Server ──────────────────────────────────────────────
	// The server now has a FULL SECURITY STACK:
	//
	//   Layer 1: TLS/HTTPS — encrypts all data in transit (AES-256-GCM)
	//   Layer 2: Rate Limiting — protects availability (SHA-256 hashed IPs)
	//   Layer 3: SHA-256 Checksum — verifies request body integrity
	//   Layer 4: HMAC-SHA256 Auth — authenticates admin requests (symmetric)
	//   Layer 5: RSA Digital Signatures — signs admin transactions (asymmetric)
	//   Layer 6: AES-256-GCM Storage — encrypts data at rest (if configured)
	//   Layer 7: SHA-256 Hash Chain — blockchain integrity verification
	api.InitServer(bc, store, api.ServerConfig{
		APIKey:     adminAPIKey,
		RSAPrivKey: rsaKeys.PrivateKey,
		RSAPubKey:  rsaKeys.PublicKey,
	})
	api.StartServer(port, tlsCfg.CertFile, tlsCfg.KeyFile, serverTLSConfig)
}