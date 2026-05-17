# Security Architecture — ZK Voting Blockchain

> Quick-reference technical document for every security layer in the custom Go blockchain.
> Use this as the single source of truth before making security-related design decisions.

---

## System Security Overview

```
                         ┌──────────────────────────────────────┐
                         │          EXTERNAL CLIENTS            │
                         │   (Admin / Voter / Peer Nodes)       │
                         └──────────────┬───────────────────────┘
                                        │
                    ┌───────────────────[1]─────────────────────┐
                    │       TLS/HTTPS (AES-256-GCM + ECDSA)    │
                    │       Transport encryption for ALL traffic│
                    └───────────────────┬───────────────────────┘
                                        │
                    ┌───────────────────[2]─────────────────────┐
                    │     Rate Limiting (SHA-256 hashed IPs)    │
                    │     DoS / brute-force prevention          │
                    └───────────────────┬───────────────────────┘
                                        │
                    ┌───────────────────[3]─────────────────────┐
                    │  SHA-256 Body Checksum (X-Content-SHA256) │
                    │  End-to-end request integrity             │
                    └───────────────────┬───────────────────────┘
                                        │
                    ┌───────────────────[4]─────────────────────┐
                    │  HMAC-SHA256 Auth (X-HMAC-Signature)      │
                    │  Admin endpoint access control            │
                    └───────────────────┬───────────────────────┘
                                        │
                    ┌───────────────────[5]─────────────────────┐
                    │  RSA-2048 Digital Signatures               │
                    │  Admin transaction non-repudiation         │
                    └───────────────────┬───────────────────────┘
                                        │
                    ┌───────────────────[6]─────────────────────┐
                    │  SHA-256 Hash Chain + Tx Verification      │
                    │  Blockchain immutability & tamper detect   │
                    └───────────────────┬───────────────────────┘
                                        │
                    ┌───────────────────[7]─────────────────────┐
                    │  AES-256-GCM Storage Encryption            │
                    │  Data-at-rest confidentiality              │
                    └────────────────────────────────────────────┘
```

---

## 1 · TLS/HTTPS — Transport Encryption

| Item | Detail |
|------|--------|
| **What** | All HTTP → HTTPS. Self-signed ECDSA P-256 certs auto-generated per node. |
| **Why ECDSA P-256** | 128-bit security equivalent to RSA-3072 but with smaller keys and faster ops. |
| **Cipher suites** | `ECDHE_ECDSA_AES_256_GCM_SHA384`, `ECDHE_RSA_AES_256_GCM_SHA256` (TLS ≥ 1.2 only). |
| **Forward secrecy** | ECDHE key exchange — compromising a long-term key does not expose past sessions. |
| **Env vars** | None (auto-generated). Certs stored in `data_<NODE_ID>/certs/`. |

**Code locations:**

| File | Role |
|------|------|
| `internal/security/tls.go` | `GenerateSelfSignedCert()` — cert generation; `NewServerTLSConfig()` — cipher suite config |
| `internal/api/server.go:84` | `StartServer()` calls `server.ListenAndServeTLS()` |
| `internal/network/client.go` | Shared `secureClient` used by all P2P calls (TLS min 1.2) |
| `internal/network/peers.go` | Peer URLs changed from `http://` → `https://` |
| `cmd/node/main.go:91-107` | Cert generation + TLS config wiring on startup |

```
  Client                            Server
    │── ClientHello ──────────────────▶│
    │◀── ServerHello + Certificate ───│   (ECDSA P-256 public key)
    │── Key Exchange (ECDHE) ────────▶│   (asymmetric)
    │◀════ AES-256-GCM session ══════▶│   (symmetric, fast)
```

**Decision rationale:** TLS is the foundational layer; without it, every other security measure (HMAC, checksums) can be observed and replayed by a network attacker. ECDSA P-256 was chosen over RSA for TLS because it provides equivalent security with significantly smaller certificates, reducing handshake latency between peer nodes.

---

## 2 · Rate Limiting — Availability Protection

| Item | Detail |
|------|--------|
| **What** | IP-based sliding-window rate limiter. IPs hashed with SHA-256 before storage for privacy. |
| **Why SHA-256 IPs** | One-way function — even if memory is dumped, original IPs cannot be recovered. |
| **Limits** | General: 100/min · Admin: 30/min · Voting: 10/min |
| **Response** | `429 Too Many Requests` + `Retry-After` header |

**Code locations:**

| File | Role |
|------|------|
| `internal/api/ratelimit.go` | `rateLimiter` struct, `isAllowed()`, `cleanup()` goroutine |
| `internal/api/server.go:94-96` | Three limiter instances created per endpoint category |
| `internal/api/server.go:99-130` | Every route wrapped with `rateLimitMiddleware()` |

```
  Request ──▶ SHA-256(IP) ──▶ sliding window check
                                ├─ under limit → PASS
                                └─ over limit  → 429 + Retry-After
```

**Decision rationale:** Rate limiting is placed as the outermost middleware (before auth) so that brute-force attempts consume minimal server resources. SHA-256 hashing of IPs adds GDPR-friendly privacy without losing rate-tracking accuracy. The background cleanup goroutine prevents unbounded memory growth.

---

## 3 · SHA-256 Body Checksum — End-to-End Integrity

| Item | Detail |
|------|--------|
| **What** | Optional `X-Content-SHA256` header. Server recomputes SHA-256 of body and compares. |
| **Why beyond TLS** | Catches corruption introduced by proxies, load balancers, or middleware **after** TLS termination. |
| **Applied to** | `/add-voter`, `/register`, `/vote` |
| **Backward compat** | Header is optional — omitting it skips the check. |

**Code locations:**

| File | Role |
|------|------|
| `internal/api/middleware.go:121-155` | `checksumMiddleware()` |
| `internal/api/server.go:109,123,124` | Applied to sensitive endpoints |

**Decision rationale:** TLS protects data point-to-point, but in multi-hop architectures (reverse proxies, CDNs), data can be silently modified after TLS termination. The checksum provides true end-to-end integrity from client application to handler.

---

## 4 · HMAC-SHA256 — Admin Authentication

| Item | Detail |
|------|--------|
| **What** | Admin sends `X-HMAC-Signature: HMAC-SHA256(body, shared_key)`. Server recomputes and compares. |
| **Why HMAC (not plain hash)** | HMAC uses a secret key — an attacker who can see the hash cannot forge it without the key. Also prevents length-extension attacks that affect raw SHA-256. |
| **Constant-time compare** | `hmac.Equal()` prevents timing side-channel attacks. |
| **Applied to** | `/add-voter` (when `ADMIN_API_KEY` env var is set) |
| **Env var** | `ADMIN_API_KEY` (shared secret, optional) |

**Code locations:**

| File | Role |
|------|------|
| `internal/security/hmac.go` | `ComputeHMAC()` and `VerifyHMAC()` with constant-time comparison |
| `internal/api/middleware.go:49-88` | `hmacAuthMiddleware()` — extracts header, verifies, restores body |
| `internal/api/server.go:110-115` | Conditionally wraps `/add-voter` handler |
| `cmd/node/main.go:53` | Reads `ADMIN_API_KEY` from environment |

```
  Admin Client                                Server
    │  body = '{"voter_id":"v1"}'                │
    │  sig = HMAC-SHA256(body, secret_key)        │
    │── POST /add-voter ─────────────────────────▶│
    │   Header: X-HMAC-Signature: <sig>           │
    │                                             │
    │          Server recomputes HMAC with its     │
    │          copy of secret_key, compares using  │
    │          constant-time hmac.Equal()          │
    │◀── 200 OK or 401 Unauthorized ─────────────│
```

**Decision rationale:** HMAC-SHA256 was chosen over bearer tokens because it simultaneously verifies both the sender's identity (they have the key) and message integrity (body wasn't modified). The constant-time comparison is critical — without it, an attacker could brute-force the HMAC one byte at a time by measuring response latency.

---

## 5 · RSA-2048 Digital Signatures — Non-Repudiation

| Item | Detail |
|------|--------|
| **What** | Admin's `ADD_VOTER` transactions are signed with RSA-2048 private key. Peers verify with public key. |
| **Why RSA (not ECDSA)** | RSA-2048 is more widely understood and verified; ECDSA is already used for TLS certs (separation of concerns). |
| **Signing** | `SHA-256(tx_hash)` → `RSA-PKCS1v15-Sign(hash, private_key)` → hex string stored in `tx.Signature` |
| **Verification** | Peer receives block → verifies each `ADD_VOTER` tx signature with admin's public key |
| **Key storage** | Private: `data_<NODE_ID>/keys/admin_private.pem` (0600) · Public: `admin_public.pem` (0644) |

**Code locations:**

| File | Role |
|------|------|
| `internal/security/rsa.go` | `GenerateRSAKeyPair()`, `SignData()`, `VerifySignature()` |
| `internal/core/types.go` | `Signature string` field added to `Transaction` struct (`omitempty`) |
| `internal/api/server.go:225-232` | Signs transaction in `handleAddVoter()` |
| `internal/api/server.go:379-388` | Verifies signatures in `handleReceiveBlock()` |
| `cmd/node/main.go:72-77` | RSA key generation/loading on startup |

```
  Admin Node                         Peer Node
    │ tx.Hash ────────────────┐       │
    │ SHA-256(tx.Hash) ──┐    │       │
    │ RSA-Sign(hash, d) ─┤    │       │
    │ tx.Signature = sig  │    │       │
    │─── broadcast block ─┼────────▶ │
    │                      │    │     │ RSA-Verify(sig, hash, e)
    │                      │    │     │  ├─ valid   → accept block
    │                      │    │     │  └─ invalid → reject (400)
```

**Decision rationale:** RSA provides non-repudiation — the admin cannot deny authorizing a voter because only their private key can produce a matching signature. The `omitempty` tag on the `Signature` field ensures backward compatibility with pre-RSA transactions.

---

## 6 · SHA-256 Hash Chain — Blockchain Integrity

This is the **foundational** security layer of the blockchain itself.

### 6a · Block Hashing
| File | Function | What |
|------|----------|------|
| `internal/core/block.go:47` | `computeHash()` | SHA-256 of (index + timestamp + prevHash + txHashes) |

### 6b · Transaction Hashing
| File | Function | What |
|------|----------|------|
| `internal/core/types.go:62` | `computeHash()` | SHA-256 of (type + timestamp + payload JSON) |
| `internal/core/types.go` | `VerifyHash()` | Recomputes and compares |

### 6c · Hash-Chain Linkage
| File | Function | What |
|------|----------|------|
| `internal/core/blockchain.go:166` | `validateChainInternal()` | 5-point validation: block hash, prev-hash link, sequential index, timestamp order, tx hash |

### 6d · P2P Block Verification
| File | Function | What |
|------|----------|------|
| `internal/api/server.go:365` | `handleReceiveBlock()` | `block.VerifyHash()` on incoming peer blocks |
| `internal/network/sync.go` | `SyncWithPeers()` | `LoadFromBlocks()` validates full chain from peers |

```
  ┌─────────┐    prevHash    ┌─────────┐    prevHash    ┌─────────┐
  │ Block 0 │◄──────────────│ Block 1 │◄──────────────│ Block 2 │
  │ (Genesis)│               │         │               │         │
  │ Hash: a1 │               │ Hash: b2│               │ Hash: c3│
  │ Txs: [h] │               │ Txs:[h] │               │ Txs:[h] │
  └─────────┘               └─────────┘               └─────────┘
       ▲                         ▲                         ▲
   SHA-256(data)             SHA-256(data)             SHA-256(data)

  Modify Block 1 data → Hash changes → Block 2 prevHash mismatch → DETECTED
```

**Decision rationale:** SHA-256 hashing at both block and transaction levels creates a two-tier tamper detection system. Even if an attacker bypasses TLS and gains filesystem access, they cannot alter historical records without breaking the hash chain, which is validated on every load and peer sync.

---

## 7 · AES-256-GCM — Storage Encryption (At Rest)

| Item | Detail |
|------|--------|
| **What** | `blockchain.json` encrypted with AES-256-GCM before writing to disk. |
| **Key derivation** | `SHA-256(passphrase)` → 32-byte AES key |
| **Nonce** | Random 12 bytes per write (from `crypto/rand` CSPRNG). Same data → different ciphertext each save. |
| **Auth tag** | GCM appends 16-byte GMAC tag — detects file tampering on disk. |
| **File format** | `ZKENC` (5 bytes) + nonce (12) + ciphertext + tag (16) |
| **Backward compat** | Load detects prefix: `ZKENC` → decrypt, `{` → parse as JSON |
| **Env var** | `ENCRYPTION_KEY` (passphrase, optional) |

**Code locations:**

| File | Role |
|------|------|
| `internal/security/aes.go` | `DeriveKey()`, `EncryptAESGCM()`, `DecryptAESGCM()` |
| `internal/persistence/store.go:61-64` | `SetEncryptionKey()` — derives and stores AES key |
| `internal/persistence/store.go:82-139` | `SaveBlockchain()` — encrypt-then-write with atomic rename |
| `internal/persistence/store.go:158-216` | `LoadBlockchain()` — auto-detect format, decrypt if needed |
| `cmd/node/main.go:39-42` | Reads `ENCRYPTION_KEY` env and sets on store |

```
  Save:  JSON ──▶ AES-256-GCM(key, random_nonce) ──▶ "ZKENC" + ciphertext ──▶ disk
  Load:  disk ──▶ detect "ZKENC" prefix ──▶ AES-256-GCM-decrypt(key) ──▶ JSON ──▶ validate chain
```

**Decision rationale:** AES-256-GCM was chosen because it provides authenticated encryption — both confidentiality and integrity in a single operation. The `ZKENC` magic prefix enables zero-migration backward compatibility; nodes can upgrade without reformatting existing data. Random nonces per write prevent ciphertext analysis across saves.

---

## 8 · Atomic File Writes — Persistence Integrity

| Item | Detail |
|------|--------|
| **What** | Write to `.tmp` file, then `os.Rename()` to final path. |
| **Why** | Prevents partial/corrupted blockchain files if the process crashes mid-write. |
| **File** | `internal/persistence/store.go:125-136` |

**Decision rationale:** Rename is an atomic filesystem operation on most OS — the file is either the old version or the new version, never a partial write. This is especially important because the blockchain file contains the entire election state.

---

## Security Layer per Endpoint

| Endpoint | TLS | Rate Limit | Checksum | HMAC Auth | RSA Sign |
|----------|-----|-----------|----------|-----------|----------|
| `/health` | ✅ | 100/min | — | — | — |
| `/chain` | ✅ | 100/min | — | — | — |
| `/blocks` | ✅ | 100/min | — | — | — |
| `/add-voter` | ✅ | 30/min | ✅ | ✅ (if key set) | ✅ (tx signed) |
| `/register` | ✅ | 10/min | ✅ | — | — |
| `/vote` | ✅ | 10/min | ✅ | — | — |
| `/internal/block` | ✅ | 100/min | — | — | RSA verified |
| `/internal/chain` | ✅ | 100/min | — | — | — |

---

## Environment Variables

| Variable | Purpose | Required | Default |
|----------|---------|----------|---------|
| `NODE_ID` | Node port / data directory suffix | No | `3001` |
| `ADMIN_API_KEY` | HMAC-SHA256 shared secret for admin auth | No | Disabled |
| `ENCRYPTION_KEY` | AES-256-GCM passphrase for storage encryption | No | Disabled |

---

## CIA Triad Coverage

| Pillar | Implementations |
|--------|----------------|
| **Confidentiality** | TLS (transit), AES-256-GCM (at rest), SHA-256 hashed IPs (privacy) |
| **Integrity** | SHA-256 block/tx hashing, hash chain, checksum middleware, GCM auth tags, HMAC, atomic writes |
| **Availability** | Rate limiting (3 tiers), background cleanup, connection timeouts |

---

## File Map

```
packages/blockchain/
├── cmd/node/main.go                   # Startup wiring: TLS + AES + HMAC + RSA
├── internal/
│   ├── security/
│   │   ├── tls.go                     # ECDSA cert gen + TLS config
│   │   ├── aes.go                     # AES-256-GCM encrypt/decrypt + key derivation
│   │   ├── hmac.go                    # HMAC-SHA256 compute/verify
│   │   └── rsa.go                     # RSA-2048 keygen/sign/verify
│   ├── api/
│   │   ├── server.go                  # HTTPS server + security layer composition
│   │   ├── middleware.go              # HMAC auth + SHA-256 checksum middlewares
│   │   └── ratelimit.go              # IP-based rate limiter (SHA-256 hashed)
│   ├── core/
│   │   ├── block.go                   # Block SHA-256 hashing
│   │   ├── types.go                   # Transaction hashing + Signature field
│   │   └── blockchain.go             # Chain validation (5-point integrity check)
│   ├── network/
│   │   ├── client.go                  # TLS-configured P2P HTTP client
│   │   ├── peers.go                   # Peer URLs (https://)
│   │   ├── broadcast.go              # TLS-encrypted block broadcasting
│   │   └── sync.go                    # TLS-encrypted chain synchronisation
│   └── persistence/
│       └── store.go                   # AES-256-GCM storage + atomic writes
└── data_<NODE_ID>/
    ├── certs/
    │   ├── server.crt                 # ECDSA X.509 certificate (public)
    │   └── server.key                 # ECDSA private key (0600)
    ├── keys/
    │   ├── admin_private.pem          # RSA-2048 private key (0600)
    │   └── admin_public.pem           # RSA-2048 public key (0644)
    └── blockchain.json                # Optionally AES-256-GCM encrypted
```
