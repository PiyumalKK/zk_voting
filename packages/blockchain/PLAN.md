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

### Stage 1: Blockchain Foundation & Production Hardening ← IN PROGRESS
**Goal:** Build a robust, secure foundation that can handle real-world load and attacks.

**1.1 Core Engine (COMPLETED)**
- Block and Transaction data structures with SHA-256 hashing
- Blockchain engine (add blocks, validate chain, query blocks)
- Genesis block creation with voting question
- Transaction types: `ADD_VOTER`, `REGISTER`, `VOTE`

**1.2 Robust Storage (UPGRADE)**
- Replace `blockchain.json` with **BoltDB** (`bbolt`)
- Move from "rewrite-the-whole-file" to "append-only-blocks" for ACID safety
- Ensure the node can recover state instantly from the database on startup

**1.3 API Security & Authentication (NEW)**
- **Admin Auth**: Implement RSA signature verification for `/admin` endpoints
- **Rate Limiting**: Add token-bucket limits to prevent DoS on `/vote` and `/register`
- **CORS**: Secure cross-origin settings for the Next.js frontend

**1.4 Network Hardening (NEW)**
- **mTLS**: Implement Mutual TLS for all node-to-node (P2P) communication
- **Identity**: Ensure only nodes with authorized certificates can sync blocks

**1.5 Observability (NEW)**
- **Structured Logging**: Replace `fmt.Println` with `zerolog` for JSON-based logs
- **Request Logging**: Add middleware to track every API call and performance latency

---

### Stage 2: Embedded EVM Integration
**Goal:** Integrate `go-ethereum/core/vm` and configure cryptographic precompiles.

**Deliverables:**
- Geth `core/vm` and `core/state` dependency integration
- EVM Configuration (Setting Hardfork to `Istanbul` to enable BN254 precompiles)
- Stateless execution wrapper:
  - Function to initialize an ephemeral state
  - Function to call a contract at a specific address with calldata
- Precompile verification test:
  - Run a small EVM test that calls the pairing precompile (`0x08`) to ensure ZK math works

**Key dependency:** `github.com/ethereum/go-ethereum`

---

### Stage 3: Contract Bridge & State Replay
**Goal:** "Deploy" `Voting.sol` and reconstruct state from the blockchain.

**Deliverables:**
- Solidity artifacts integration (loading bytecode/ABI into Go)
- Contract "Auto-Deployment":
  - On node startup, the EVM state is initialized with `Voting.sol` at a fixed address
- State reconstruction:
  - Loop through existing blocks and "replay" transactions into the EVM
  - This makes the EVM state deterministic based on the hash chain
- Transaction Mapping:
  - `ADD_VOTER` -> EVM call to `addVoters()`
  - `REGISTER` -> EVM call to `register()`
  - `VOTE` -> EVM call to `vote()`

---

### Stage 4: EVM-Powered API & Queries
**Goal:** Query the current voting stats directly from the EVM state.

**Deliverables:**
- EVM "Read-Only" calls:
  - `GetVotingData()` -> Call contract, parse return values (Yes/No votes, Root)
  - `GetVoterData(address)` -> Check eligibility/registration
- State caching for performance (avoid re-running the whole chain for every query)
- Proper parsing of EVM errors (reverts) into friendly JSON responses

---

### Stage 5: REST API Server
**Goal:** HTTP API that the frontend can call.

**Deliverables:**
- HTTP server with proper CORS
- Admin authentication (simple API key)
- Endpoints:
  | Method | Path                | Auth   | Description                    |
  |--------|---------------------|--------|--------------------------------|
  | POST   | /api/admin/voters   | Admin  | Add voter(s)                   |
  | POST   | /api/register       | Voter  | Submit commitment              |
  | POST   | /api/vote           | None   | Submit ZK proof + vote         |
  | GET    | /api/voting-data    | None   | Get current tally & tree info  |
  | GET    | /api/blocks         | None   | List all blocks                |
  | GET    | /api/health         | None   | Health check                   |

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

- [x] Stage 1: Blockchain Foundation ← COMPLETED
- [ ] Stage 2: Embedded EVM Integration
- [ ] Stage 3: Contract Bridge & State Replay
- [ ] Stage 4: EVM-Powered API & Queries
- [ ] Stage 5: REST API Server
- [ ] Stage 6: Integration Testing
- [ ] Stage 7: Frontend Connection
