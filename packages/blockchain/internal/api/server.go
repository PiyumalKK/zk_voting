package api

import (
	"crypto/rsa"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"zk-blockchain/internal/core"
	"zk-blockchain/internal/network"
	"zk-blockchain/internal/persistence"
	"zk-blockchain/internal/security"
)

// Global blockchain reference (simple for Phase 1)
var bc *core.Blockchain
var store *persistence.FileStore

// adminAPIKey is the shared secret used for HMAC-SHA256 authentication
// on admin endpoints. When set, admin requests must include a valid
// X-HMAC-Signature header. When empty, admin endpoints are unprotected.
var adminAPIKey string

// rsaPrivateKey is the admin's RSA private key used to digitally sign
// admin transactions (ADD_VOTER). This provides non-repudiation —
// the admin cannot deny having created the transaction.
var rsaPrivateKey *rsa.PrivateKey

// rsaPublicKey is the admin's RSA public key used to verify digital
// signatures on received admin transactions from peer nodes.
var rsaPublicKey *rsa.PublicKey

// ServerConfig holds all security configuration for the API server.
// This bundles TLS, HMAC authentication, and RSA digital signature settings
// into a single struct, demonstrating how multiple IS layers work together.
type ServerConfig struct {
	APIKey     string          // HMAC-SHA256 shared secret (symmetric key auth)
	RSAPrivKey *rsa.PrivateKey // RSA private key for signing (asymmetric)
	RSAPubKey  *rsa.PublicKey  // RSA public key for verification (asymmetric)
}

// InitServer sets up blockchain + storage + security configuration.
//
// Security layers configured here:
//   - HMAC-SHA256 authentication (symmetric key — same key on client & server)
//   - RSA digital signatures (asymmetric key — private key signs, public key verifies)
//   - Rate limiting and checksum verification are applied in StartServer
func InitServer(blockchain *core.Blockchain, fs *persistence.FileStore, config ServerConfig) {
	bc = blockchain
	store = fs
	adminAPIKey = config.APIKey
	rsaPrivateKey = config.RSAPrivKey
	rsaPublicKey = config.RSAPubKey
}

// StartServer starts the HTTPS blockchain node with full security stack.
//
// Security layers applied to each endpoint (defence-in-depth):
//
//   LAYER 1 — TLS/HTTPS (transport encryption):
//     All endpoints are encrypted with AES-256-GCM via TLS.
//
//   LAYER 2 — Rate Limiting (availability protection):
//     All endpoints are rate-limited to prevent DoS attacks.
//     IPs are hashed with SHA-256 for privacy.
//
//   LAYER 3 — SHA-256 Checksum (integrity verification):
//     Sensitive endpoints verify X-Content-SHA256 header if present.
//
//   LAYER 4 — HMAC-SHA256 Authentication (admin access control):
//     Admin endpoints require X-HMAC-Signature header.
//
//   LAYER 5 — RSA Digital Signatures (non-repudiation):
//     Admin transactions are signed with the admin's RSA private key.
//
// Parameters:
//   - port:      The port to listen on (e.g., ":3001")
//   - certFile:  Path to the PEM-encoded TLS certificate (public key + identity)
//   - keyFile:   Path to the PEM-encoded private key (kept secret on server)
//   - tlsConfig: TLS configuration with cipher suite and version settings
func StartServer(port, certFile, keyFile string, tlsConfig *tls.Config) {

	// ── Create Rate Limiters ────────────────────────────────────────────
	// Different endpoints get different rate limits based on their
	// sensitivity and expected usage patterns.
	//
	// Rate limiting protects AVAILABILITY (CIA triad) by preventing:
	//   - DoS (Denial of Service) attacks
	//   - Brute-force attacks on authenticated endpoints
	//   - Vote spamming
	generalRL := newRateLimiter(100, time.Minute) // 100 req/min for read endpoints
	voteRL := newRateLimiter(10, time.Minute)     // 10 req/min for voting (strict)
	adminRL := newRateLimiter(30, time.Minute)    // 30 req/min for admin operations

	// ── Public Read Endpoints (rate limited only) ───────────────────────
	http.HandleFunc("/health", rateLimitMiddleware(generalRL, handleHealth))
	http.HandleFunc("/chain", rateLimitMiddleware(generalRL, handleGetChain))
	http.HandleFunc("/blocks", rateLimitMiddleware(generalRL, handleGetBlocks))

	// ── Admin Endpoint: /add-voter ──────────────────────────────────────
	// Security layers (outermost → innermost):
	//   1. Rate Limiting (prevents brute-force)
	//   2. SHA-256 Checksum (verifies body integrity)
	//   3. HMAC-SHA256 Authentication (proves admin identity)
	//   4. Handler (creates RSA-signed transaction)
	addVoterHandler := checksumMiddleware(handleAddVoter)
	if adminAPIKey != "" {
		addVoterHandler = hmacAuthMiddleware(addVoterHandler)
		fmt.Println("   🔑 Admin auth: HMAC-SHA256 enabled for /add-voter")
	} else {
		fmt.Println("   ⚠️  Admin auth: DISABLED (set ADMIN_API_KEY to enable)")
	}
	http.HandleFunc("/add-voter", rateLimitMiddleware(adminRL, addVoterHandler))

	// ── Voter Endpoints: /register, /vote ───────────────────────────────
	// Security layers:
	//   1. Rate Limiting (prevents spam)
	//   2. SHA-256 Checksum (verifies body integrity)
	//   3. Handler (processes the request)
	http.HandleFunc("/register", rateLimitMiddleware(voteRL, checksumMiddleware(handleRegister)))
	http.HandleFunc("/vote", rateLimitMiddleware(voteRL, checksumMiddleware(handleVote)))

	// ── Internal P2P Endpoints ──────────────────────────────────────────
	// These are protected by TLS at the transport layer.
	// Rate limited to prevent rogue peers from overwhelming a node.
	http.HandleFunc("/internal/block", rateLimitMiddleware(generalRL, handleReceiveBlock))
	http.HandleFunc("/internal/chain", rateLimitMiddleware(generalRL, handleSendChain))

	// ── Print Security Status ───────────────────────────────────────────
	fmt.Println("🔒 Blockchain Node running with HTTPS/TLS on", port)
	fmt.Println("   🌐 API: https://localhost" + port)
	fmt.Println("   📄 Certificate:", certFile)
	if rsaPrivateKey != nil {
		fmt.Println("   🔏 RSA: Digital signatures enabled for admin transactions")
	}
	fmt.Println("   🛡️  Rate limiting: ACTIVE (vote: 10/min, admin: 30/min, general: 100/min)")
	fmt.Println("   🔍 SHA-256 checksum: ACTIVE on /add-voter, /register, /vote")

	// Create a custom HTTPS server with the TLS configuration
	server := &http.Server{
		Addr:      port,
		TLSConfig: tlsConfig,
	}

	log.Fatal(server.ListenAndServeTLS(certFile, keyFile))
}

/*
========================
        HANDLERS
========================
*/

func handleHealth(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]string{
		"status": "ok",
	})
}

func handleGetChain(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	json.NewEncoder(w).Encode(map[string]interface{}{
		"length": len(bc.GetBlocks()),
		"blocks": bc.GetBlocks(),
	})
}

func handleGetBlocks(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(bc.GetBlocks())
}

/*
========================
   TEST API (PHASE 1)
========================
*/

type AddVoterRequest struct {
	VoterID string `json:"voter_id"`
}

// handleAddVoter creates a new ADD_VOTER transaction with an optional
// RSA digital signature.
//
// When RSA is configured:
//   1. The transaction is created with a SHA-256 hash
//   2. The hash is signed with the admin's RSA private key
//   3. The hex-encoded signature is stored in the transaction's Signature field
//
// This provides NON-REPUDIATION — the admin cannot deny having created
// the transaction, because only they possess the private key needed to
// produce the signature. Any node can verify the signature using the
// admin's public key.
func handleAddVoter(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var req AddVoterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	tx, err := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{
		VoterID: req.VoterID,
		Allowed: true,
	})
	if err != nil {
		http.Error(w, "tx error", http.StatusInternalServerError)
		return
	}

	// ── RSA Digital Signature ───────────────────────────────────────
	// Sign the transaction hash with the admin's RSA private key.
	// The signature proves:
	//   - The transaction was created by the admin (AUTHENTICATION)
	//   - The transaction has not been modified (INTEGRITY)
	//   - The admin cannot deny creating it (NON-REPUDIATION)
	if rsaPrivateKey != nil {
		sig, err := security.SignData([]byte(tx.Hash), rsaPrivateKey)
		if err != nil {
			http.Error(w, "failed to sign transaction", http.StatusInternalServerError)
			return
		}
		tx.Signature = sig
	}

	block, err := bc.AddTransaction(tx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	network.BroadcastBlock(*block)
	_ = store.SaveBlockchain(bc)

	json.NewEncoder(w).Encode(block)
}

/*
========================
 REGISTER (dummy Phase 1)
========================
*/

type RegisterRequest struct {
	VoterID    string `json:"voter_id"`
	Commitment string `json:"commitment"`
}

func handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var req RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	tx, err := core.NewTransaction(core.TxRegister, core.RegisterPayload{
		VoterID:    req.VoterID,
		Commitment: req.Commitment,
		LeafIndex:  uint64(len(bc.GetBlocks())),
	})
	if err != nil {
		http.Error(w, "tx error", http.StatusInternalServerError)
		return
	}

	block, err := bc.AddTransaction(tx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	_ = store.SaveBlockchain(bc)

	json.NewEncoder(w).Encode(block)
}

/*
========================
 VOTE (mock for Phase 1)
========================
*/

type VoteRequest struct {
	Proof         string `json:"proof"`
	NullifierHash string `json:"nullifier_hash"`
	Vote          bool   `json:"vote"`
}

func handleVote(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var req VoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	tx, err := core.NewTransaction(core.TxVote, core.VotePayload{
		Proof:         req.Proof,
		NullifierHash: req.NullifierHash,
		Root:          "demo_root",
		Vote:          req.Vote,
		Depth:         2,
	})
	if err != nil {
		http.Error(w, "tx error", http.StatusInternalServerError)
		return
	}

	block, err := bc.AddTransaction(tx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	_ = store.SaveBlockchain(bc)

	json.NewEncoder(w).Encode(block)
}

// handleReceiveBlock processes blocks received from peer nodes.
//
// Security verification on received blocks:
//   1. SHA-256 hash chain linkage (PrevHash must match)
//   2. SHA-256 block hash verification (recompute and compare)
//   3. RSA signature verification on ADD_VOTER transactions (if configured)
//      — ensures only the legitimate admin created those transactions
func handleReceiveBlock(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var block core.Block
	if err := json.NewDecoder(r.Body).Decode(&block); err != nil {
		http.Error(w, "invalid block", http.StatusBadRequest)
		return
	}

	latest := bc.GetLatestBlock()

	// Validate chain link
	if block.PrevHash != latest.Hash {
		http.Error(w, "invalid prev hash", http.StatusBadRequest)
		return
	}

	// Validate block hash
	if !block.VerifyHash() {
		http.Error(w, "invalid block hash", http.StatusBadRequest)
		return
	}

	// ── RSA Signature Verification ──────────────────────────────────
	// Verify RSA digital signatures on ADD_VOTER transactions.
	// This uses the admin's PUBLIC KEY (asymmetric verification):
	//   - The signature was created with the admin's PRIVATE key
	//   - We verify it with the PUBLIC key
	//   - If verification passes, we know the admin signed this transaction
	//
	// Transactions without signatures are still accepted for backward
	// compatibility with blocks created before RSA was enabled.
	if rsaPublicKey != nil {
		for _, tx := range block.Transactions {
			if tx.Type == core.TxAddVoter && tx.Signature != "" {
				if !security.VerifySignature([]byte(tx.Hash), tx.Signature, rsaPublicKey) {
					http.Error(w, "invalid RSA signature on ADD_VOTER transaction", http.StatusBadRequest)
					return
				}
			}
		}
	}

	// Add block (re-create using transactions)
	_, err := bc.AddBlock(block.Transactions)
	if err != nil {
		http.Error(w, "failed to add block", http.StatusInternalServerError)
		return
	}

	// Save
	_ = store.SaveBlockchain(bc)

	json.NewEncoder(w).Encode(map[string]string{
		"status": "block accepted",
	})
}

func handleSendChain(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(bc.GetBlocks())
}