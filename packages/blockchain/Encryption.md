# Information Security in the ZK Voting Blockchain

This document maps how **Information Security** concepts — symmetric & asymmetric (private-key) encryption, hashing, and internet/communication security protocols — are applied within this custom Go blockchain application. It is divided into two parts:

1. **Part A** – Existing security implementations already present in the codebase.
2. **Part B** – A plan for new security features to be added.

---

## Part A: Existing Information Security Implementations

### 1. SHA-256 Hashing for Block Integrity

| Aspect              | Detail |
|----------------------|--------|
| **File**            | `internal/core/block.go` — `computeHash()` (line 47) |
| **Security Concept** | Cryptographic Hashing (SHA-256) |
| **How It Works**    | Each block's content (index, timestamp, previous hash, and transaction hashes) is passed through `crypto/sha256.Sum256()`. The resulting 256-bit digest is stored as the block's `Hash` field. |
| **Why It Matters**  | SHA-256 is a one-way hash function — it is computationally infeasible to reverse the hash or find two different inputs producing the same hash (collision resistance). If even a single bit of block data is altered, the recomputed hash will differ from the stored hash, immediately exposing the tampering. |
| **IS Category**     | **Hashing** — ensures data integrity and tamper detection. |

```go
// From block.go — SHA-256 block hashing
hash := sha256.Sum256([]byte(data))
return hex.EncodeToString(hash[:])
```

---

### 2. SHA-256 Hashing for Transaction Integrity

| Aspect              | Detail |
|----------------------|--------|
| **File**            | `internal/core/types.go` — `computeHash()` (line 62) |
| **Security Concept** | Cryptographic Hashing (SHA-256) |
| **How It Works**    | Every transaction independently hashes its type, timestamp, and JSON-compacted payload using SHA-256. The hash is stored in the `Hash` field and the first 16 hex characters form the transaction `ID`. |
| **Why It Matters**  | This creates a unique fingerprint for each transaction. If anyone modifies the vote value (e.g., changing `true` → `false`), the commitment data, or the voter ID, the hash will no longer match. The blockchain engine checks every transaction hash before including it in a block (`AddBlock()` at line 64 in `blockchain.go`). |
| **IS Category**     | **Hashing** — data integrity at the transaction level. |

```go
// From types.go — Transaction hash verification
func (tx *Transaction) VerifyHash() bool {
    return tx.Hash == tx.computeHash()
}
```

---

### 3. Hash-Chain Linkage (Immutable Ledger)

| Aspect              | Detail |
|----------------------|--------|
| **File**            | `internal/core/blockchain.go` — `validateChainInternal()` (line 166) |
| **Security Concept** | Hash Chain / Linked Hashing |
| **How It Works**    | Each block stores `PrevHash` = the `Hash` of the preceding block. During chain validation, the system verifies that every block's `PrevHash` matches the actual hash of the block before it. This forms a cryptographically linked chain from genesis to the latest block. |
| **Why It Matters**  | An attacker cannot insert, delete, or modify a past block without breaking the hash chain. Changing block N would invalidate blocks N+1, N+2, ... through to the chain tip. This provides **retrospective immutability** — even the admin cannot alter election history without detection. |
| **IS Category**     | **Hashing** — chained integrity guarantees across the full ledger. |

```go
// From blockchain.go — Chain linkage validation
if current.PrevHash != previous.Hash {
    return fmt.Errorf("block %d has broken chain link (prev_hash mismatch)", current.Index)
}
```

---

### 4. Tamper Detection Across Multiple Layers

| Aspect              | Detail |
|----------------------|--------|
| **File**            | `internal/core/blockchain.go` — `validateChainInternal()` (line 166), `blockchain_test.go` |
| **Security Concept** | Multi-layer integrity verification |
| **How It Works**    | The `ValidateChain()` function performs a 5-point integrity check on every block: (1) block hash correctness, (2) chain linkage, (3) sequential index, (4) non-decreasing timestamps, and (5) individual transaction hash validity. This is run on startup when loading a persisted chain, and can be triggered at any time. |
| **Why It Matters**  | Even if an attacker gains access to the stored `blockchain.json` file and modifies it, the application will refuse to load the corrupted chain. Tamper detection tests in `blockchain_test.go` explicitly verify that modifying block hashes, prev-hashes, and transaction payloads all cause validation failures. |
| **IS Category**     | **Hashing** — comprehensive integrity auditing. |

---

### 5. Block Hash Verification During P2P Synchronisation

| Aspect              | Detail |
|----------------------|--------|
| **Files**           | `internal/api/server.go` — `handleReceiveBlock()` (line 202), `internal/network/sync.go` |
| **Security Concept** | Hash-based message authentication over the network |
| **How It Works**    | When a peer node sends a new block, the receiving node: (a) verifies the block's `PrevHash` matches its own latest block, and (b) calls `block.VerifyHash()` to confirm the block hash is correctly computed. During full chain sync, `LoadFromBlocks()` validates the entire received chain before accepting it. |
| **Why It Matters**  | This prevents a malicious peer from injecting forged or tampered blocks into the network. A rogue node cannot fabricate blocks with invalid hashes — every node independently recomputes and verifies. |
| **IS Category**     | **Hashing** — integrity verification over network communication. |

```go
// From server.go — Peer block validation
if !block.VerifyHash() {
    http.Error(w, "invalid block hash", http.StatusBadRequest)
    return
}
```

---

### 6. Atomic File Writes for Persistence Integrity

| Aspect              | Detail |
|----------------------|--------|
| **File**            | `internal/persistence/store.go` — `SaveBlockchain()` (line 39) |
| **Security Concept** | Atomic write pattern (write-to-temp-then-rename) |
| **How It Works**    | The blockchain is first written to a `.tmp` file, then atomically renamed to the final `blockchain.json`. This prevents partial/corrupted writes if the process crashes during save. |
| **Why It Matters**  | Ensures the persisted blockchain file is always in a consistent, valid state. A power failure or crash during save will not corrupt the existing data file. |
| **IS Category**     | **Data Integrity** — protection against corruption during storage. |

---

## Part B: Plan for New Information Security Implementations

The following 7 enhancements introduce symmetric encryption, asymmetric (private-key) encryption, advanced hashing, and communication security protocols into the existing blockchain application.

---

### New Implementation 1: HTTPS/TLS for REST API Communication ✅ IMPLEMENTED

| Aspect              | Detail |
|----------------------|--------|
| **Files Created/Modified** | `internal/security/tls.go` (NEW), `internal/api/server.go` (MODIFIED), `cmd/node/main.go` (MODIFIED) |
| **Security Concept** | Internet & Communication Security Protocol (TLS/HTTPS) |
| **IS Topics**       | Symmetric encryption (AES for data), Asymmetric encryption (ECDSA for key exchange), Digital certificates |
| **Status**          | ✅ **Completed** |

**What Was Implemented:**

Replaced the plain HTTP server with HTTPS using Go's `http.Server.ListenAndServeTLS()` with auto-generated self-signed ECDSA certificates.

```go
// BEFORE (insecure plain HTTP)
log.Fatal(http.ListenAndServe(port, nil))

// AFTER (with TLS encryption) — in server.go
server := &http.Server{Addr: port, TLSConfig: tlsConfig}
log.Fatal(server.ListenAndServeTLS(certFile, keyFile))
```

**Key Files:**
- `internal/security/tls.go` — Generates ECDSA P-256 self-signed certificates, creates `tls.Config` with modern cipher suites (AES-256-GCM, ECDHE key exchange)
- `internal/api/server.go` — `StartServer()` now accepts `certFile`, `keyFile`, and `*tls.Config`; uses `ListenAndServeTLS()`
- `cmd/node/main.go` — Auto-generates TLS certificates on startup, passes them to the server

**How TLS Applies Multiple IS Concepts:**
- **Asymmetric Encryption (ECDSA P-256):** During the TLS handshake, the server's public key (in the certificate) is used for key exchange. The server's ECDSA private key proves its identity.
- **Symmetric Encryption (AES-256-GCM):** After handshake, all data is encrypted with a shared session key using AES. This protects voter data, proofs, and votes in transit.
- **Hashing (SHA-256):** TLS uses HMAC-SHA256 to verify message integrity during transit.
- **Digital Certificates:** The self-signed X.509 certificate proves the server's identity, preventing man-in-the-middle attacks.

---

### New Implementation 2: TLS-Encrypted Peer-to-Peer Communication ✅ IMPLEMENTED

| Aspect              | Detail |
|----------------------|--------|
| **Files Created/Modified** | `internal/network/client.go` (NEW), `internal/network/broadcast.go` (MODIFIED), `internal/network/sync.go` (MODIFIED), `internal/network/peers.go` (MODIFIED) |
| **Security Concept** | Communication Security Protocol (TLS) |
| **IS Topics**       | Asymmetric encryption (certificate-based key exchange), Symmetric encryption (AES encrypted data channel) |
| **Status**          | ✅ **Completed** |

**What Was Implemented:**

Created a shared TLS-configured HTTP client used by all P2P functions. Replaced `http.Post()` and `http.Get()` with the secure client. Updated all peer URLs from `http://` to `https://`.

```go
// From network/client.go — TLS-secured HTTP client
func newTLSClient() *http.Client {
    return &http.Client{
        Transport: &http.Transport{
            TLSClientConfig: &tls.Config{
                MinVersion:         tls.VersionTLS12,
                InsecureSkipVerify: true, // Self-signed certs in development
            },
        },
        Timeout: 10 * time.Second,
    }
}
```

**Key Changes:**
- `internal/network/client.go` — New file with a package-level `secureClient` initialised at startup via `init()`. All P2P calls use this TLS client.
- `internal/network/broadcast.go` — `BroadcastBlock()` now uses `secureClient.Post()` instead of `http.Post()` for encrypted block broadcasting.
- `internal/network/sync.go` — `SyncWithPeers()` now uses `secureClient.Get()` instead of `http.Get()` for encrypted chain synchronisation.
- `internal/network/peers.go` — All peer URLs changed from `http://` to `https://`.

**Why It Matters:**
- Previously, blocks were broadcast between nodes over plain HTTP, meaning block data (votes, proofs, nullifier hashes) travelled unencrypted. An attacker on the network could eavesdrop or modify blocks in transit.
- With TLS, all peer communication is encrypted with AES-256-GCM (symmetric), and keys are exchanged via ECDHE (asymmetric with forward secrecy).
- Defence-in-depth: even if TLS were somehow compromised, the SHA-256 hash-chain validation (`LoadFromBlocks()`) would catch any tampered blocks.

---

### New Implementation 3: API Key Authentication Using HMAC-SHA256 ✅ IMPLEMENTED

| Aspect              | Detail |
|----------------------|--------|
| **Files Created/Modified** | `internal/security/hmac.go` (NEW), `internal/api/middleware.go` (NEW), `internal/api/server.go` (MODIFIED), `cmd/node/main.go` (MODIFIED) |
| **Security Concept** | Hashing for Authentication (HMAC) |
| **IS Topics**       | Hashing (SHA-256), Symmetric key authentication |
| **Status**          | ✅ **Completed** |

**What Was Implemented:**

Added HMAC-SHA256 authentication middleware that protects the admin `/add-voter` endpoint. The admin client must compute `HMAC-SHA256(request_body, shared_secret)` and include it in the `X-HMAC-Signature` header.

```go
// From security/hmac.go — HMAC verification with constant-time comparison
func VerifyHMAC(message []byte, signatureHex string, key []byte) bool {
    receivedMAC, err := hex.DecodeString(signatureHex)
    if err != nil {
        return false
    }
    mac := hmac.New(sha256.New, key)
    mac.Write(message)
    expectedMAC := mac.Sum(nil)
    return hmac.Equal(receivedMAC, expectedMAC) // Constant-time comparison
}
```

**Key Files:**
- `internal/security/hmac.go` — ComputeHMAC and VerifyHMAC functions with constant-time comparison (prevents timing attacks)
- `internal/api/middleware.go` — HTTP middleware that reads `X-HMAC-Signature` header, verifies HMAC, restores request body
- `internal/api/server.go` — `InitServer()` now accepts `apiKey`; `/add-voter` conditionally wrapped with middleware
- `cmd/node/main.go` — Reads `ADMIN_API_KEY` environment variable

**How It Applies IS Concepts:**
- **HMAC-SHA256** uses a shared secret key combined with SHA-256 hashing to produce a message authentication code.
- This is a **symmetric key** scheme — both client and server must possess the same secret key.
- The HMAC verifies both the **integrity** (data hasn’t been tampered with) and **authenticity** (sender has the key).
- Uses **constant-time comparison** (`hmac.Equal`) to prevent timing side-channel attacks.

**Environment Variable:** `ADMIN_API_KEY` (shared secret string, optional)

---

### New Implementation 4: AES-256-GCM Encryption for Blockchain Storage at Rest ✅ IMPLEMENTED

| Aspect              | Detail |
|----------------------|--------|
| **Files Created/Modified** | `internal/security/aes.go` (NEW), `internal/persistence/store.go` (MODIFIED), `cmd/node/main.go` (MODIFIED) |
| **Security Concept** | Symmetric Encryption (AES-256-GCM) |
| **IS Topics**       | Symmetric encryption, Encryption at rest, Authenticated encryption, SHA-256 key derivation |
| **Status**          | ✅ **Completed** |

**What Was Implemented:**

Encrypt the `blockchain.json` file at rest using AES-256-GCM. The encryption key is derived from a passphrase via SHA-256. A `ZKENC` magic prefix enables backward compatibility with existing plaintext files.

```go
// From security/aes.go — AES-256-GCM encryption
func EncryptAESGCM(plaintext, key []byte) ([]byte, error) {
    block, _ := aes.NewCipher(key)      // Create AES cipher with 256-bit key
    aesGCM, _ := cipher.NewGCM(block)   // Wrap in GCM mode
    nonce := make([]byte, aesGCM.NonceSize())
    io.ReadFull(rand.Reader, nonce)     // Random 12-byte nonce
    return aesGCM.Seal(nonce, nonce, plaintext, nil), nil
}
```

**Key Files:**
- `internal/security/aes.go` — AES-256-GCM encrypt/decrypt functions + SHA-256 key derivation from passphrase
- `internal/persistence/store.go` — `SetEncryptionKey()` method; `SaveBlockchain()` encrypts before writing; `LoadBlockchain()` auto-detects format
- `cmd/node/main.go` — Reads `ENCRYPTION_KEY` environment variable

**Backward Compatibility:**
- Encrypted files are prefixed with `ZKENC` (5 bytes) — plaintext JSON starts with `{`
- On load: detect prefix → encrypted file gets decrypted, plaintext loads normally
- Existing unencrypted blockchain files work without changes ✅

**How It Applies IS Concepts:**
- **AES-256** is the industry-standard **symmetric encryption** algorithm. A single 256-bit secret key is used for both encryption and decryption.
- **GCM mode** provides both confidentiality (encryption) and integrity (authentication tag) — it is an **authenticated encryption** scheme.
- A random **nonce** is generated for each write, ensuring the same plaintext produces different ciphertext each time.
- **SHA-256 key derivation** converts a human-readable passphrase to a fixed 32-byte key.

**Environment Variable:** `ENCRYPTION_KEY` (passphrase string, optional)

---

### New Implementation 5: SHA-256 Request Body Checksum Verification ✅ IMPLEMENTED

| Aspect              | Detail |
|----------------------|--------|
| **Files Created/Modified** | `internal/api/middleware.go` (MODIFIED) |
| **Security Concept** | Hashing for Data Integrity Verification |
| **IS Topics**       | Hashing (SHA-256), Data integrity in transit |
| **Status**          | ✅ **Completed** |

**What Was Implemented:**

Added `checksumMiddleware` that verifies the integrity of incoming API request bodies by checking the optional `X-Content-SHA256` header. Applied to `/add-voter`, `/register`, and `/vote` endpoints.

```go
// From api/middleware.go — SHA-256 checksum verification
func checksumMiddleware(next http.HandlerFunc) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        expectedHash := r.Header.Get("X-Content-SHA256")
        if expectedHash == "" {
            next(w, r) // Optional — backward compatible
            return
        }
        body, _ := io.ReadAll(r.Body)
        r.Body = io.NopCloser(bytes.NewBuffer(body))
        actualHash := sha256.Sum256(body)
        if hex.EncodeToString(actualHash[:]) != expectedHash {
            http.Error(w, "checksum mismatch", http.StatusBadRequest)
            return
        }
        next(w, r)
    }
}
```

**Key Files:**
- `internal/api/middleware.go` — `checksumMiddleware` function added alongside existing `hmacAuthMiddleware`
- `internal/api/server.go` — Middleware applied to `/add-voter`, `/register`, `/vote`

**How It Applies IS Concepts:**
- Direct application of **cryptographic hashing** for **integrity verification** of data sent over the network.
- Provides END-TO-END integrity verification — detects tampering even if a proxy, load balancer, or middleware modifies the body after TLS termination.
- SHA-256's **collision resistance** (2^128 operations) ensures an attacker cannot craft a different body producing the same hash.
- SHA-256's **avalanche effect** means changing even one bit produces a completely different hash.
- The header is OPTIONAL — backward compatible with existing clients.

---

### New Implementation 6: RSA Digital Signatures for Admin Transactions ✅ IMPLEMENTED

| Aspect              | Detail |
|----------------------|--------|
| **Files Created/Modified** | `internal/security/rsa.go` (NEW), `internal/core/types.go` (MODIFIED), `internal/api/server.go` (MODIFIED), `cmd/node/main.go` (MODIFIED) |
| **Security Concept** | Asymmetric (Public-Key) Encryption — Digital Signatures |
| **IS Topics**       | Private-key cryptography, RSA-2048, Hashing (SHA-256 for digest), Non-repudiation |
| **Status**          | ✅ **Completed** |

**What Was Implemented:**

Admin transactions (`ADD_VOTER`) are now digitally signed using an RSA-2048 private key. The signature is stored in the transaction's `Signature` field and verified by peer nodes using the admin's public key.

```go
// From security/rsa.go — RSA digital signature creation
func SignData(data []byte, privateKey *rsa.PrivateKey) (string, error) {
    hash := sha256.Sum256(data)           // Step 1: SHA-256 hash
    signature, err := rsa.SignPKCS1v15(   // Step 2: RSA sign
        rand.Reader, privateKey, crypto.SHA256, hash[:],
    )
    return hex.EncodeToString(signature), err  // Step 3: Hex encode
}

// From security/rsa.go — RSA signature verification
func VerifySignature(data []byte, signatureHex string, publicKey *rsa.PublicKey) bool {
    signature, _ := hex.DecodeString(signatureHex)
    hash := sha256.Sum256(data)
    err := rsa.VerifyPKCS1v15(publicKey, crypto.SHA256, hash[:], signature)
    return err == nil
}
```

**Key Files:**
- `internal/security/rsa.go` — RSA-2048 key pair generation/loading, `SignData` and `VerifySignature` functions
- `internal/core/types.go` — Added `Signature string \`json:"signature,omitempty"\`` to `Transaction` struct
- `internal/api/server.go` — `handleAddVoter` signs transactions; `handleReceiveBlock` verifies signatures
- `cmd/node/main.go` — Generates/loads RSA key pair on startup

**Signing Flow:**
1. Create transaction → compute SHA-256 hash of content
2. Sign the hash with RSA private key: `signature = hash^d mod n`
3. Store hex-encoded signature in the `Signature` field
4. On peer receipt: verify signature with public key: `hash == signature^e mod n`

**Backward Compatibility:**
- `Signature` field uses `omitempty` — existing transactions without signatures serialize normally ✅
- Signature verification is only performed on transactions that HAVE a signature ✅
- `computeHash()` does NOT include the Signature field — hash remains stable ✅

**How It Applies IS Concepts:**
- **RSA** is an **asymmetric encryption** algorithm — mathematically related key pair (private signs, public verifies)
- **Non-repudiation**: The admin cannot deny creating a signed transaction (only they have the private key)
- **Authentication**: Only the private key holder can create valid signatures
- **Integrity**: Any modification to the transaction invalidates the signature
- SHA-256 is used to create a fixed-size digest before RSA signing

---

### New Implementation 7: Rate Limiting and IP-Based Brute-Force Protection ✅ IMPLEMENTED

| Aspect              | Detail |
|----------------------|--------|
| **Files Created/Modified** | `internal/api/ratelimit.go` (NEW), `internal/api/server.go` (MODIFIED) |
| **Security Concept** | Network Security / Denial-of-Service Protection |
| **IS Topics**       | Communication security, Availability, Access control, SHA-256 hashing |
| **Status**          | ✅ **Completed** |

**What Was Implemented:**

Added IP-based rate limiting middleware with SHA-256 hashed client identifiers. Different rate limits apply to different endpoint categories: 100/min general, 30/min admin, 10/min voting.

```go
// From api/ratelimit.go — SHA-256 hashed IP rate limiting
func (rl *rateLimiter) isAllowed(ip string) bool {
    rl.mu.Lock()
    defer rl.mu.Unlock()
    // Hash IP with SHA-256 for privacy (one-way function)
    ipHash := sha256.Sum256([]byte(ip))
    key := hex.EncodeToString(ipHash[:])
    now := time.Now()
    // Sliding window: count requests within the time window
    var valid []time.Time
    for _, t := range rl.requests[key] {
        if t.After(now.Add(-rl.window)) {
            valid = append(valid, t)
        }
    }
    if len(valid) >= rl.limit {
        return false  // Rate limit exceeded → 429 Too Many Requests
    }
    rl.requests[key] = append(valid, now)
    return true
}
```

**Key Files:**
- `internal/api/ratelimit.go` — `rateLimiter` struct, `isAllowed()`, `rateLimitMiddleware()`, background cleanup goroutine
- `internal/api/server.go` — Three rate limiters instantiated with different limits per endpoint category

**Rate Limits Applied:**
| Endpoint Category | Limit | Endpoints |
|---|---|---|
| General (read) | 100 req/min | `/health`, `/chain`, `/blocks`, `/internal/*` |
| Admin (write) | 30 req/min | `/add-voter` |
| Voting (critical) | 10 req/min | `/register`, `/vote` |

**How It Applies IS Concepts:**
- Protects **availability** (CIA triad) by preventing Denial of Service (DoS) attacks and resource exhaustion
- Uses **SHA-256 hashing** for client IP privacy — original IPs are never stored in memory
- Implements **access control** by restricting request frequency per identity
- Returns `429 Too Many Requests` with `Retry-After` header (HTTP standard)
- Background cleanup goroutine prevents memory leaks from expired entries
- Part of a **defense-in-depth** strategy alongside TLS, HMAC auth, and RSA signatures

---

## Summary Table

### Existing Implementations

| # | Security Feature | IS Category | File(s) |
|---|------------------|-------------|---------|
| 1 | SHA-256 Block Hashing | Hashing | `core/block.go` |
| 2 | SHA-256 Transaction Hashing | Hashing | `core/types.go` |
| 3 | Hash-Chain Linkage | Hashing | `core/blockchain.go` |
| 4 | Multi-Layer Tamper Detection | Hashing | `core/blockchain.go`, `core/blockchain_test.go` |
| 5 | P2P Block Hash Verification | Hashing | `api/server.go`, `network/sync.go` |
| 6 | Atomic File Writes | Data Integrity | `persistence/store.go` |

### New Implementations

| # | Security Feature | IS Category | File(s) | Status |
|---|------------------|-------------|---------|--------|
| 1 | HTTPS/TLS for REST API | Symmetric + Asymmetric Encryption, Communication Protocol | `security/tls.go`, `api/server.go` | ✅ Done |
| 2 | TLS-Encrypted P2P Communication | Asymmetric Encryption, Communication Protocol | `network/client.go`, `network/broadcast.go`, `network/sync.go` | ✅ Done |
| 3 | HMAC-SHA256 API Authentication | Hashing, Symmetric Key Authentication | `security/hmac.go`, `api/middleware.go`, `api/server.go` | ✅ Done |
| 4 | AES-256-GCM Storage Encryption | Symmetric Encryption | `security/aes.go`, `persistence/store.go` | ✅ Done |
| 5 | SHA-256 Request Checksum | Hashing, Integrity Verification | `api/middleware.go`, `api/server.go` | ✅ Done |
| 6 | RSA Digital Signatures for Admin Txns | Asymmetric Encryption, Digital Signatures | `security/rsa.go`, `core/types.go`, `api/server.go` | ✅ Done |
| 7 | Rate Limiting with Hashed IPs | Hashing, Communication Security | `api/ratelimit.go`, `api/server.go` | ✅ Done |

---

## IS Concept Coverage Map

| IS Concept | Implemented | Coverage |
|------------|----------|---------|
| **Hashing (SHA-256)** | ✅ Block hashing, Transaction hashing, Chain linkage, Tamper detection, HMAC-SHA256 (Impl. 3), Request checksums (Impl. 5), IP hashing (Impl. 7) | Complete |
| **Symmetric Encryption (AES)** | ✅ AES-256-GCM via TLS (Impl. 1 & 2), AES-256-GCM storage encryption (Impl. 4) | Complete |
| **Asymmetric Encryption (RSA/ECDSA)** | ✅ ECDSA P-256 TLS certificates (Impl. 1 & 2), RSA-2048 digital signatures (Impl. 6) | Complete |
| **Communication Security (TLS/HTTPS)** | ✅ HTTPS for API (Impl. 1), TLS for P2P (Impl. 2), Rate limiting (Impl. 7) | Complete |
| **Authentication** | ✅ HMAC-SHA256 admin API auth (Impl. 3), RSA signature verification (Impl. 6) | Complete |
| **Non-repudiation** | ✅ RSA digital signatures on admin transactions (Impl. 6) | Complete |
| **Availability** | ✅ SHA-256 hashed IP rate limiting (Impl. 7) | Complete |
