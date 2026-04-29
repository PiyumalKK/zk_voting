# Custom ZK Voting Blockchain — Development Plan

A purpose-built blockchain in Go for private, Sybil-resistant e-voting using zero-knowledge proofs.

**Why a custom blockchain instead of Ethereum?**

| Ethereum Feature      | Needed? | Reason                                                   |
|-----------------------|---------|----------------------------------------------------------|
| Mining / PoS          | ❌ No   | Election is authority-administered, not decentralized     |
| Gas fees / ETH        | ❌ No   | Voters shouldn't need cryptocurrency to vote              |
| MetaMask / Wallets    | ❌ No   | Adds friction; voters need browser extensions             |
| EVM execution engine  | ❌ No   | Voting logic is simple; no need for Turing-complete VM    |
| Burner wallets        | ❌ No   | Custom API is already identity-free; ZK proof IS the auth |

**What we keep from the existing system:**

- ✅ Noir ZK circuit (`packages/circuits/src/main.nr`) — unchanged
- ✅ Browser proof generation (`noir_js` + `bb.js`) — unchanged  
- ✅ Poseidon commitment scheme — same math, Go implementation
- ✅ Verification key (`vk`) — same artifact from circuit compilation
- ✅ `circuits.json` — same compiled circuit artifact

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                   BROWSER (Next.js)                           │
│                                                               │
│  Unchanged:                                                   │
│  - poseidon2(nullifier, secret) → commitment                 │
│  - noir_js → witness → bb.js UltraHonk → ZK proof           │
│                                                               │
│  Changed (later, during frontend connection):                 │
│  - REST API calls instead of Ethereum RPC                     │
│  - No MetaMask, no wallets, no gas                            │
└───────────────────────┬──────────────────────────────────────┘
                        │  REST API (JSON over HTTP)
                        ▼
┌──────────────────────────────────────────────────────────────┐
│                   GO BLOCKCHAIN NODE                          │
│                                                               │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  REST API    │  │  Blockchain  │  │  Voting State      │  │
│  │  Server      │  │  Engine      │  │  Manager           │  │
│  │             │  │              │  │                    │  │
│  │  POST /vote │  │  Blocks []   │  │  Voter allowlist   │  │
│  │  POST /reg  │  │  Hash chain  │  │  Merkle tree       │  │
│  │  GET /stats │  │  Validation  │  │  Nullifier set     │  │
│  │  POST /admin│  │  Persistence │  │  Vote tallies      │  │
│  └─────────────┘  └──────────────┘  └────────────────────┘  │
│                                                               │
│  ┌──────────────────────┐  ┌──────────────────────────────┐  │
│  │  ZK Verifier         │  │  Poseidon Hasher (Go)        │  │
│  │  (bb verify CLI)     │  │  go-iden3-crypto/poseidon    │  │
│  └──────────────────────┘  └──────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## Development Stages

### Stage 1: Blockchain Foundation ← START HERE
**Goal:** Core data structures, chain management, persistence.

**Deliverables:**
- Block and Transaction data structures with SHA-256 hashing
- Blockchain engine (add blocks, validate chain, query blocks)
- Genesis block creation with voting question
- JSON file persistence (save/load chain)
- Transaction types: `ADD_VOTER`, `REGISTER`, `VOTE`
- Unit tests for chain integrity and tamper detection
- Demo CLI that creates, validates, saves, and loads a chain

**No external dependencies** — only Go standard library.

---

### Stage 2: Cryptography Layer
**Goal:** Poseidon hash, Merkle tree, and hash compatibility verification.

**Deliverables:**
- Poseidon hash integration (`go-iden3-crypto/poseidon`)
- LeanIMT (Lean Incremental Merkle Tree) implementation in Go
- Hash compatibility test suite:
  - Test vectors from the JavaScript `poseidon-lite` library
  - Verify Go produces identical outputs for known inputs
  - Verify Merkle root matches JS `@zk-kit/lean-imt`
- Commitment computation: `poseidon2([nullifier, secret])`
- Nullifier hash computation: `poseidon1([nullifier])`

**Key dependency:** `github.com/iden3/go-iden3-crypto`

**Critical verification:** The hash outputs in Go MUST match:
1. `poseidon-lite` (JavaScript, used in frontend)
2. `std::hash::poseidon::bn254` (Noir, used in circuit)

---

### Stage 3: Voting State Machine
**Goal:** Complete voting logic that mirrors `Voting.sol` behavior.

**Deliverables:**
- Voter allowlist management (add/remove voters)
- Registration logic:
  - Check voter is allowed and hasn't registered
  - Check commitment hasn't been used
  - Insert commitment into Merkle tree
  - Return leaf index
- Vote counting logic:
  - Verify nullifier hash hasn't been used (anti-double-vote)
  - Increment yes/no counters
  - Record nullifier as spent
- State rebuilt from chain replay:
  - On startup, replay all transactions to reconstruct state
  - This makes the state deterministic from the chain data
- State query functions:
  - `GetVotingData()` → question, yesVotes, noVotes, treeRoot, treeDepth
  - `GetVoterData(id)` → isAllowed, hasRegistered

---

### Stage 4: ZK Proof Verification
**Goal:** Integrate `bb verify` CLI for proof validation.

**Deliverables:**
- `bb verify` subprocess wrapper
- Proof file handling (write to temp, verify, cleanup)
- Verification key management (embedded asset)
- Public input extraction and validation
- Integration with vote processing:
  - Extract root from proof → compare with current tree root
  - Extract nullifier hash → check not already used
  - If `bb verify` returns exit code 0 → proof valid → count vote
- Concurrency-safe verification (unique temp files per request)
- Timeout handling (kill long-running `bb` processes)

**Prerequisite:** `bb` binary must be available (Linux/WSL)

**Performance:** ~200-500ms per proof verification (acceptable for voting)

---

### Stage 5: REST API Server
**Goal:** HTTP API that the frontend can call.

**Deliverables:**
- HTTP server with proper CORS for browser access
- Admin authentication (simple API key or JWT)
- Endpoints:
  | Method | Path                | Auth   | Description                    |
  |--------|---------------------|--------|--------------------------------|
  | POST   | /api/admin/voters   | Admin  | Add voter(s) to allowlist      |
  | GET    | /api/voters         | None   | List all voters with status    |
  | POST   | /api/register       | Voter  | Submit commitment              |
  | GET    | /api/voting-data    | None   | Get question, votes, tree info |
  | GET    | /api/voter/:id      | None   | Get voter status               |
  | POST   | /api/vote           | None   | Submit ZK proof + vote         |
  | GET    | /api/leaves         | None   | Get all Merkle tree leaves     |
  | GET    | /api/blocks         | None   | List all blocks                |
  | GET    | /api/blocks/:index  | None   | Get specific block             |
  | GET    | /api/circuit        | None   | Serve circuits.json            |
  | GET    | /api/health         | None   | Health check                   |
- Request/response validation
- Error handling with proper HTTP status codes
- Structured JSON error responses

---

### Stage 6: Integration Testing
**Goal:** End-to-end test that simulates a complete election.

**Deliverables:**
- Test script that runs the full voting flow:
  1. Start blockchain node
  2. Admin adds 5 voters
  3. Each voter registers a commitment (using Go Poseidon)
  4. Verify Merkle tree root matches expected value
  5. Generate test proofs (using `bb` in WSL)
  6. Submit votes via API
  7. Verify vote counts
  8. Verify double-vote rejection (same nullifier)
  9. Verify chain integrity
- Load testing with concurrent voters
- Error case testing (invalid proofs, unauthorized, etc.)

---

### Stage 7: Frontend Connection (Later)
**Goal:** Connect the existing Next.js frontend to the Go blockchain.

**NOTE:** This stage modifies `packages/nextjs/`. Do NOT start this
until the team agrees to switch from the Ethereum backend.

**Deliverables:**
- API client utility (`packages/nextjs/utils/api.ts`)
- Replace Scaffold-ETH hooks with custom React hooks
- Remove wagmi/MetaMask dependency
- Remove burner wallet logic
- Add simple admin/voter authentication
- Simple block explorer page
- Update all voting components to use REST API

---

## Project Structure

```
packages/blockchain/
├── PLAN.md                     # This file
├── Makefile                    # Build, test, run commands
├── go.mod                      # Go module definition
├── go.sum                      # Dependency checksums
├── .gitignore                  # Ignore data dir and binaries
│
├── cmd/
│   └── node/
│       └── main.go             # Application entry point
│
├── internal/
│   ├── core/                   # Blockchain engine
│   │   ├── types.go            # Transaction types and payloads
│   │   ├── block.go            # Block structure and hashing
│   │   ├── blockchain.go       # Chain management and validation
│   │   ├── blockchain_test.go  # Unit tests
│   │   └── genesis.go          # Genesis block creation
│   │
│   ├── state/                  # Voting state machine (Stage 3)
│   │   ├── voting.go           # VotingState manager
│   │   ├── merkle.go           # LeanIMT implementation
│   │   └── voting_test.go      # State tests
│   │
│   ├── crypto/                 # Cryptography (Stage 2)
│   │   ├── poseidon.go         # Poseidon hash wrapper
│   │   └── poseidon_test.go    # Hash compatibility tests
│   │
│   ├── verifier/               # ZK proof verification (Stage 4)
│   │   ├── bb.go               # bb CLI subprocess wrapper
│   │   └── bb_test.go          # Verification tests
│   │
│   ├── api/                    # REST API server (Stage 5)
│   │   ├── server.go           # HTTP server setup
│   │   ├── handlers.go         # Route handlers
│   │   ├── middleware.go       # Auth, CORS, logging
│   │   └── responses.go       # Standard response types
│   │
│   └── persistence/            # Data storage
│       └── store.go            # JSON file persistence
│
├── assets/                     # Static assets
│   ├── vk                      # Verification key (from circuit)
│   └── circuits.json           # Compiled circuit (served to browser)
│
└── data/                       # Runtime data (gitignored)
    └── blockchain.json         # Persisted chain
```

---

## Dependencies

| Stage | Package                                | Purpose                      |
|-------|----------------------------------------|------------------------------|
| 1     | Go stdlib only                         | Core blockchain engine       |
| 2     | `github.com/iden3/go-iden3-crypto`     | Poseidon hash over BN254     |
| 4     | Go stdlib `os/exec`                    | bb CLI subprocess            |
| 5     | Go stdlib `net/http`                   | HTTP server                  |

The entire blockchain is built with **minimal external dependencies** —
only `go-iden3-crypto` for the cryptographic hash function.

---

## Current Status

- [x] Stage 1: Blockchain Foundation ← COMPLETED
- [ ] Stage 2: Cryptography Layer
- [ ] Stage 3: Voting State Machine
- [ ] Stage 4: ZK Proof Verification
- [ ] Stage 5: REST API Server
- [ ] Stage 6: Integration Testing
- [ ] Stage 7: Frontend Connection
