# zk_voting REST API Specification

The REST API served by the Go blockchain node (`cmd/node`). This document is
the contract the Next.js frontend codes against — it describes the server as
implemented in `internal/api/server.go`, not an aspirational design.

## Listeners

| Listener | Default | TLS | Purpose |
|---|---|---|---|
| Public API | `http://localhost:3001` (`NODE_ID` env sets the port) | Plain HTTP by default; `API_TLS=true` serves HTTPS **without** client-cert requirements | Everything below |
| P2P | `:4001` (`P2P_PORT`, default `NODE_ID + 1000`) | mTLS, client certs **required** | `/internal/block`, `/internal/chain` — node-to-node only, never called by the frontend |

The P2P listener only starts when TLS certificates exist in
`data_<NODE_ID>/certs/`. Without them the node runs standalone (P2P disabled) —
certificates are NOT needed for local frontend development.

## Conventions

- All bodies are JSON. CORS allows the origin in `ALLOWED_ORIGIN`
  (default `http://localhost:3000`), methods GET/POST/OPTIONS, and the
  `X-Admin-Signature` header.
- **Big numbers are strings.** Any value that can exceed JavaScript's 2^53
  integer limit is a string: `root` is a `0x`-hex string; `election_id` and
  `votes` are decimal strings. `tree_size`, `depth`, `phase`, timestamps, and
  block indices are plain JSON numbers (always < 2^53).
- Errors are plain-text bodies with a 4xx/5xx status. EVM rejections come back
  ABI-decoded — the body contains the Solidity error name, e.g.
  `vote rejected: vote reverted: Voting__NullifierHashAlreadyUsed(0x...)`.
  Clients match on the error-name substring (`NullifierHashAlreadyUsed`,
  `InvalidRoot`, `InvalidProof`, `WrongPhase`, `InvalidCandidate`, `EmptyTree`,
  `AddressNotAllowlisted`, `CommitmentAlreadyAdded`, `AddressAlreadyRegistered`).
- Accepted writes return:

  ```json
  { "tx_id": "0f8a…", "block_index": 7 }
  ```

## Authentication

- **Public endpoints** — none.
- **Voter endpoints** (`/register`, `/vote`) — none, but rate-limited per IP
  (1 req/sec sustained, burst 5 → `429 Too Many Requests`).
- **Admin endpoints** — RSA signature of `"<unix-seconds>\n<path>\n<body>"`
  with the admin private key, sent base64-encoded in `X-Admin-Signature`
  alongside the signed timestamp in `X-Admin-Timestamp` (unix seconds).
  RSA-SHA256 / PKCS#1 v1.5; verified against
  `data_<NODE_ID>/keys/admin_public.pem`. Binding the path and timestamp into
  the signature prevents a captured signature from being replayed against a
  different endpoint or outside a ±5-minute window. `503` if the node has no
  admin key configured, `401` if a header is missing, `403` on a bad signature
  or stale timestamp.
  The Next.js server-side proxy (`app/api/admin/[action]/route.ts`) does this
  signing — the browser never holds the key.

---

## 1. Read endpoints (public, no auth)

### GET /voting-data
Current election state, read live from the embedded EVM at the current wall
clock (time-expired phases report as `Ended` automatically).

```json
{
  "question": "Who should lead the student council?",
  "owner": "0x0000000000000000000000000000000000001337",
  "phase": 1,
  "phase_label": "Registration",
  "registration_end_time": 1751630000,
  "voting_end_time": 0,
  "tree_size": 2,
  "depth": 1,
  "root": "0xa80a87ebb5ee7d573cfce8ba5523fa9c3c85049430f63ac5e0a621ec7332496",
  "candidate_count": 2,
  "election_id": "0"
}
```
`phase`: 0 Setup, 1 Registration, 2 Voting, 3 Ended. Timestamps are unix
seconds. `503` if the node is running without the EVM bridge.

### GET /candidates
`["Alice", "Bob"]` — index order matches `candidate_index` in `/vote` and the
order of `/vote-counts`.

### GET /vote-counts
```json
[ { "candidate": "Alice", "votes": "12" }, { "candidate": "Bob", "votes": "4" } ]
```

### GET /voter/{voter_id}
`voter_id` is the same opaque string used with `/add-voter` and `/register`
(hashed internally to an EVM address).
```json
{ "allowed": true, "registered": false }
```
Unknown voters return `{ "allowed": false, "registered": false }` (200).

### GET /commitments
All registered commitments **of the current election** in insertion order
(entries before the most recent reset are excluded) — this is the Merkle-leaf
list the browser rebuilds the tree from (the REST replacement for Solidity's
`NewLeaf` event logs). Oldest-first; no reversal needed.
```json
[ "0x1234…", "0x2" ]
```

### GET /voters
The current election's allowlist, derived from the chain's `ADD_VOTER` log
(insertion order, last write per voter wins, reset-scoped like `/commitments`) —
the REST replacement for Hardhat's `VoterAdded` event history.
```json
[ { "voter_id": "alice@example.com", "allowed": true } ]
```

### GET /chain
`{ "length": 8, "blocks": [ …full blocks… ] }`

### GET /blocks
Full block list. Optional pagination: `?page=1&limit=20` (1-based, newest
last); omitted → all blocks.

### GET /health
`{ "status": "ok" }`

---

## 2. Voter endpoints (rate-limited)

### POST /register
```json
{ "voter_id": "alice@example.com", "commitment": "0x…poseidon2(nullifier, secret)…" }
```
The EVM validates BEFORE anything is committed (allowlisted, unique
commitment, not already registered, Registration phase). **201**:
```json
{ "tx_id": "…", "block_index": 3, "leaf_index": 0, "election_id": "0" }
```
`leaf_index` + `election_id` belong in the voter's downloaded Voter Pass.
`400` with the decoded reason on rejection.

### POST /vote
No identity — the ZK proof is the authentication.
```json
{
  "proof": "0x…raw UltraHonk proof bytes (keccak flavor)…",
  "nullifier_hash": "0x…",
  "root": "0x…root the proof was generated against…",
  "candidate_index": 0,
  "depth": 1
}
```
The EVM runs the real HonkVerifier (BN254 pairing precompile) BEFORE the block
is committed. **200** `{ "tx_id": "…", "block_index": 5 }`; `400` with the
decoded reason (invalid proof, `NullifierHashAlreadyUsed` double-vote, stale
`InvalidRoot`, `WrongPhase`, …).

---

## 3. Admin endpoints (X-Admin-Signature)

All are POST; all return `{ "tx_id", "block_index" }` on success and `400`
with the decoded EVM reason on phase-gating rejections. Each mirrors one
control on the admin page.

| Path | Body | Contract call | Valid phase |
|---|---|---|---|
| `/add-voter` | `{ "voter_id": "alice@example.com", "allowed": true }` (`allowed` optional, default true; `false` revokes) | `addVoters([addr],[allowed])` | Setup |
| `/set-question` | `{ "question": "…" }` | `setQuestion` | Setup |
| `/set-candidates` | `{ "candidates": ["A","B"] }` | `setCandidates` | Setup |
| `/start-registration` | `{ "duration_sec": 3600 }` | `startRegistration` | Setup → Registration |
| `/start-voting` | `{ "duration_sec": 3600 }` | `startVoting` | Registration → Voting |
| `/end-election` | `{}` | `endElection` | Registration/Voting → Ended |
| `/reset-election` | `{}` | `resetElection` (bumps `election_id`, clears everything) | any |

---

## 4. Environment variables (node)

| Var | Default | Meaning |
|---|---|---|
| `NODE_ID` | `3001` | Public API port; also names `data_<NODE_ID>/` |
| `P2P_PORT` | `NODE_ID + 1000` | mTLS peer listener port |
| `API_TLS` | unset | `true` → public API serves HTTPS (no client certs) |
| `ALLOWED_ORIGIN` | `http://localhost:3000` | CORS origin |
| `PEERS` | empty | Comma-separated peer P2P base URLs (`https://host:4002`) |
| `SYNC_INTERVAL_SEC` | `30` | Periodic peer re-sync interval |
| `ASSETS_DIR` | `assets` | Compiled contract artifacts (see `make sync-artifacts`) |
| `ALLOW_STORAGE_ONLY` | unset | `true` → permit startup without the EVM bridge (**no ZK verification** — dev only). Default: missing artifacts are a fatal startup error |
