# Custom ZK Voting Blockchain — Development Plan

A purpose-built blockchain in Go for private, Sybil-resistant e-voting using zero-knowledge proofs.

**Why a custom blockchain instead of Ethereum?**

| Ethereum Feature      | Needed? | Reason                                                   |
|-----------------------|---------|----------------------------------------------------------|
| Mining / PoS          | ❌ No   | Election is authority-administered, not decentralized     |
| Gas fees / ETH        | ❌ No   | Voters shouldn't need cryptocurrency to vote              |
| MetaMask / Wallets    | ❌ No   | Adds friction; voters need browser extensions             |
| EVM execution engine  | ✅ Yes  | **Embedded (Stateless)**; used to run the voting contract |
| Burner wallets        | ❌ No   | Custom API is already identity-free; ZK proof IS the auth |

**What we keep from the existing system:**

- ✅ Noir ZK circuit (`packages/circuits/src/main.nr`) — unchanged
- ✅ Browser proof generation (`noir_js` + `bb.js`) — unchanged  
- ✅ Solidity Contract (`packages/hardhat/contracts/Voting.sol`) — **Embedded in Go**
- ✅ Poseidon/Merkle logic — same logic, executed via EVM bytecode
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
│  │  REST API    │  │  Blockchain  │  │  Embedded EVM      │  │
│  │  Server      │  │  Engine      │  │  (Stateless Geth)  │  │
│  │             │  │              │  │                    │  │
│  │  POST /vote ├──┤  Blocks []   ├──┤  Voting.sol        │  │
│  │  POST /reg  │  │  Hash chain  │  │  Verifier.sol      │  │
│  │  GET /stats │  │  Persistence │  │  Precompiles (BN)  │  │
│  └─────────────┘  └──────────────┘  └────────────────────┘  │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Verification Flow:                                    │  │
│  │  1. Receive Tx -> 2. Load Contract -> 3. Execute Call  │  │
│  │  4. If EVM returns Success -> 5. Commit Block          │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## Development Stages

### Stage 1: Blockchain Foundation & Production Hardening ✅ COMPLETED
**Goal:** Build a robust, secure foundation that can handle real-world load and attacks.

**1.1 Core Engine**
- Block and Transaction data structures with SHA-256 hashing
- Blockchain engine (add blocks, validate chain, query blocks)
- Genesis block creation with voting question
- Transaction types: `ADD_VOTER`, `REGISTER`, `VOTE`
- `AppendExternalBlock` for peer-received blocks (preserves original hash/index/timestamp)

**1.2 Robust Storage**
- BoltDB (`bbolt`) — ACID-safe, append-only block storage
- Node recovers state instantly from the database on startup

**1.3 API Security & Authentication**
- **Admin Auth**: RSA signature verification for `/add-voter`; non-fatal if key missing (endpoint returns 503 with instructions)
- **Rate Limiting**: Per-IP token-bucket limits on `/vote` and `/register` (1 req/sec, burst 5)
- **CORS**: Configurable via `ALLOWED_ORIGIN` env var (defaults to `http://localhost:3000`)
- **Input validation**: Required fields enforced on all POST endpoints

**1.4 Network Hardening**
- **mTLS**: Mutual TLS for all node-to-node communication
- **Peer discovery**: Peers configured via `PEERS` env var (comma-separated URLs); not hardcoded
- **Block sync**: `handleReceiveBlock` uses `AppendExternalBlock` — peers stay on identical chain
- **Startup ordering**: TLS config loaded → `InitNetworkClient` → `SyncWithPeers` → `StartServer`

> ⚠️ **Known Gap — Live Node Drift (to be addressed in Stage 4)**
>
> `BroadcastBlock` in `broadcast.go` is fire-and-forget (`go func` with no retry or ACK).
> If a peer node is temporarily offline or the POST fails, it silently misses blocks and its
> chain drifts behind. The only recovery today is a full node restart triggering `SyncWithPeers`.
> There is no periodic heartbeat, gap-fill, or divergence detection for live nodes.
>
> **Planned fix:** Add a periodic background sync ticker that calls `SyncWithPeers` on a
> configurable interval (e.g. every 30s). This ensures live nodes self-heal without requiring
> a restart, at the cost of one `/internal/chain` request per peer per interval.

**1.5 Observability**
- **Structured Logging**: `zerolog` with JSON/console output and request latency tracking
- **Request Logging**: Every API call logged with method, path, IP, and duration

---

### Stage 2: Embedded EVM Integration ✅ COMPLETED
**Goal:** Integrate `go-ethereum/core/vm` and configure cryptographic precompiles.

**Deliverables:**
- `go-ethereum v1.13.14` dependency integrated
- EVM configured with Istanbul + Berlin + London hardforks — enables BN254 pairing precompile (`0x08`) required for Noir ZK proof verification
- `NewStateManager()` — ephemeral in-memory state via `rawdb.NewMemoryDatabase()`
- `CreateStatelessEVM()` — spoofed block context, zero gas price, very high gas limit (authority model)
- `ContractCaller.Call()` — call any deployed contract at a given address
- `ContractCaller.Deploy()` — run constructor and install runtime code (used in Stage 3)
- `ContractCaller.InstallRuntimeCode()` — low-level escape hatch for runtime-only bytecode
- `TestEVMPrecompiles` — verifies `0x08` precompile returns correct result under Istanbul config
- EVM wired into `main.go` and passed to `InitServer` (ready for Stage 3 contract calls)

**Key dependency:** `github.com/ethereum/go-ethereum`

**Stage 3 prerequisite:** Compile `Voting.sol` → `assets/Voting.bin` + `assets/Voting.abi` before starting Stage 3.
Run: `cd packages/hardhat && npx hardhat compile` then copy artifacts to `packages/blockchain/assets/`

---

### Stage 3: Contract Bridge & State Replay ✅ COMPLETED
**Goal:** "Deploy" `Voting.sol` and reconstruct state from the blockchain.

**Deliverables:**
- `artifacts.go` — `loadArtifact()`, `decodedBytecode()`, `decodedLinkedBytecode()` (Hardhat JSON parsing)
- `bridge.go` — `ContractBridge` with typed Go methods for all Solidity functions:
  - `AddVoter(voterID, allowed)` → `addVoters([]address, []bool)`
  - `Register(voterID, commitmentHex)` → `register(uint256)`
  - `Vote(proofHex, nullifierHashHex, rootHex, vote, depth)` → `vote(...)`
  - `GetVotingData()` → returns `VotingData{Question, Owner, YesVotes, NoVotes, TreeSize, Depth, Root}`
    (binary Yes/No shape as of Stage 3 — since superseded by the multi-candidate/phase shape, see the
    "Multi-Candidate & Phased Election Alignment" note near the end of this file)
  - `GetVoterData(voterID)` → returns `VoterData{Allowed, Registered}`
  - `VoterIDToAddress(voterID)` — deterministic keccak256-based address derivation
  - `wrapErr()` — ABI-decodes standard/custom Solidity revert reasons
- 4-step deterministic deployment (nonce 0=HonkVerifier, 1=PoseidonT3, 2=LeanIMT, 3=Voting)
  - Solidity library linking: `__$hash$__` placeholders replaced with deployed addresses
- `replay.go` — `ReplayBlockchain()` replays all persisted transactions into a fresh EVM state
  - Transaction mapping: `ADD_VOTER`→`AddVoter`, `REGISTER`→`Register`, `VOTE`→`Vote`
  - Invalid/rejected transactions are skipped with a warning log (chain not invalidated)
- `bridge_test.go`, `replay_test.go` — full test coverage (20 tests, all passing)

**Key technical fix:** Added `EIP150Block: big.NewInt(0)` to the EVM chain config.  
Without EIP-150, Geth's `callGas()` forwards ALL available gas to DELEGATECALL callees.  
Combined with EIP-2929's cold-account base cost (Berlin), this caused `baseCost + forwardedGas`  
to exceed available gas → OOG before LeanIMT executed a single opcode.  
With EIP-150, the 63/64 gas forwarding rule caps what's forwarded, solving the issue.

---

### Stage 4: EVM-Powered API & Queries ✅ COMPLETED
**Goal:** Query the current voting stats directly from the EVM state.

**Deliverables:**
- [x] EVM "Read-Only" calls:
  - `GetVotingData()` -> Call contract, parse return values (Yes/No votes, Root) — implemented in `bridge.go`, used internally by `Register()` to read back the true leaf index
  - `GetVoterData(address)` -> Check eligibility/registration — implemented in `bridge.go`
- [x] Proper parsing of EVM errors (reverts) into friendly JSON responses — `wrapErr()` decodes `Error(string)`, `Panic(uint256)`, and Voting's custom errors; `handleRegister`/`handleVote` surface the decoded message as the HTTP error body
- [x] `GetVotingData`/`GetVoterData` exposed as `GET /voting-data` and `GET /voter/{voter_id}` HTTP endpoints (`server.go`)
- [x] State caching for performance — `ContractBridge` memoizes the last `VotingData` result and a per-voter `VoterData` map, guarded by the same lock that already serializes EVM calls. `AddVoter`/`Register` invalidate only the touched voter's entry; `Register`/`Vote` invalidate the shared `VotingData` entry (their write touches tree/tally fields); `Register` re-populates it immediately since it needs the fresh tree size anyway.

---

### Stage 5: REST API Server ✅ COMPLETED (core surface); real API-key admin auth intentionally out of scope
**Goal:** HTTP API that the frontend can call.

**Deliverables:**
- [x] HTTP server with proper CORS — `CORSMiddleware` in `middleware.go`, origin configurable via `ALLOWED_ORIGIN`
- [x] Admin authentication — RSA signature (`X-Admin-Signature` header), not a simple API key as originally scoped, but functionally equivalent and already implemented in Stage 1
- [x] Endpoints implemented (paths differ slightly from the original sketch below — no `/api` prefix):
  | Method | Path                  | Auth               | Description                                  |
  |--------|-----------------------|--------------------|-----------------------------------------------|
  | POST   | /add-voter            | Admin (RSA sig)    | Add/revoke a voter's eligibility               |
  | POST   | /register             | Rate-limited        | Submit commitment; EVM-validated before commit |
  | POST   | /vote                 | Rate-limited        | Submit ZK proof + vote; EVM-verified before commit |
  | GET    | /voting-data          | None               | Current tally, tree size/depth/root (Stage 4)  |
  | GET    | /voter/{voter_id}     | None               | Voter's allowed/registered status (Stage 4)    |
  | GET    | /chain                | None               | Full chain + length                            |
  | GET    | /blocks               | None               | List all blocks                                |
  | GET    | /health               | None               | Health check                                   |
- [ ] No dedicated `GET /voting-data` endpoint yet (tally/tree info) — this is the main remaining Stage 5 gap once Stage 4's read endpoints are added

---

### Stage 6: Integration Testing
**Goal:** End-to-end test that simulates a complete election.

**Deliverables:**
- Test script:
  1. Start Go node (Embedded EVM)
  2. Register voters via API
  3. Verify EVM state updates (check root)
  4. Submit valid/invalid ZK proofs
  5. Verify EVM rejects invalid proofs and double-votes
  6. Stop/Start node and verify state is perfectly reconstructed from blocks

---

### Stage 7: Frontend Connection (Later)
**Goal:** Connect the existing Next.js frontend.

**Deliverables:**
- API client utility (`packages/nextjs/utils/api.ts`)
- Replace Scaffold-ETH hooks with custom REST hooks
- Simple block explorer page

---

## Project Structure

```
packages/blockchain/
├── PLAN.md                     # This file
├── Makefile                    # Build, test, run commands
├── go.mod                      # Go module definition
│
├── cmd/
│   └── node/
│       └── main.go             # Application entry point
│
├── internal/
│   ├── core/                   # Blockchain engine
│   │   ├── types.go            # Transaction types
│   │   ├── block.go            # Block structure
│   │   └── blockchain.go       # Chain management
│   │
│   ├── evm/                    # Embedded EVM (Stage 2)
│   │   ├── vm.go               # Geth VM wrapper
│   │   ├── state.go            # StateDB management
│   │   └── contract.go         # Voting.sol interaction
│   │
│   ├── api/                    # REST API server (Stage 5)
│   │   └── server.go           # HTTP server setup
│   │
│   └── persistence/            # Data storage
│       └── store.go            # Block storage (JSON)
│
└── assets/                     # Static assets
    ├── Voting.bin              # Compiled bytecode of Voting.sol
    └── Voting.abi              # ABI for query parsing
```

---

## Dependencies

| Stage | Package                                | Purpose                      |
|-------|----------------------------------------|------------------------------|
| 1     | Go stdlib only                         | Core blockchain engine       |
| 2     | `github.com/ethereum/go-ethereum`      | Embedded EVM & Precompiles   |
| 5     | Go stdlib `net/http`                   | HTTP server                  |

---

## Current Status

- [x] Stage 1: Blockchain Foundation
- [x] Stage 2: Embedded EVM Integration
- [x] Stage 3: Contract Bridge & State Replay
- [x] Stage 4: EVM-Powered API & Queries — read calls, error decoding, dedicated read endpoints (`GET /voting-data`, `GET /voter/{voter_id}`), and per-request caching all done
  - [ ] **[Network Fix]** Periodic background sync ticker to detect and recover live node drift (see Stage 1.4 Known Gap)
- [x] Stage 5: REST API Server — CORS, admin auth, and the full read/write endpoint set are live
- [ ] Stage 6: Integration Testing  ← NEXT
- [ ] Stage 7: Frontend Connection

> **Post-Stage-3 hardening (2026-07-01):** a review of the Stage 3 diff found and fixed one critical
> and two moderate/minor issues in the contract-bridge wiring. See
> [`BLOCKCHAIN_OVERVIEW.md` → "Stage 3 Hardening Pass"](./BLOCKCHAIN_OVERVIEW.md) for full details:
> a missing mutex around the shared EVM state (data races across concurrent `/vote`, `/register`,
> `/add-voter`, and P2P block replay), a `LeafIndex` that could drift from the real Merkle index,
> and a silent Stage 1/2 fallback with no way to make it a hard startup failure.

> **Multi-candidate & phased-election parity (2026-07-01):** `packages/hardhat/contracts/Voting.sol`
> was independently rewritten (commit `37634cf "Multi Candidate system"`, merged into `main` before
> this branch existed) from a binary Yes/No referendum into an arbitrary-candidate, admin-phased
> election (`Setup → Registration → Voting → Ended`). `packages/blockchain` had never been updated to
> match — it was still deploying and testing against a stale compiled artifact of the old contract
> shape. This has been fixed: the compiled artifacts were refreshed, and the Go bridge/types/API were
> rewritten to mirror the current contract (and the admin UI that drives it,
> `packages/nextjs/app/voting/admin/page.tsx`) exactly. See
> [`BLOCKCHAIN_OVERVIEW.md` → "Multi-Candidate & Phased Election Alignment"](./BLOCKCHAIN_OVERVIEW.md)
> for the full breakdown.
