# ZK Voting

A private, Sybil-resistant voting system using zero-knowledge proofs. Voters can prove eligibility and vote exactly once without revealing who they are.

## Architecture

- **packages/circuits** - Noir ZK circuit (proves voter membership privately)
- **packages/hardhat** - Solidity smart contracts (Voting + Verifier)
- **packages/nextjs** - React frontend (register, generate proof, vote)

## Tech Stack

- Noir + Barretenberg (ZK proofs)
- Solidity + Hardhat (smart contracts)
- Next.js + wagmi + viem (frontend)
- LeanIMT (on-chain Merkle tree)
- Poseidon hash (ZK-friendly hashing)

## Getting Started

```
yarn chain     # Start local blockchain
yarn deploy    # Deploy contracts
yarn start     # Start frontend
```

## Tools Required

- Node.js >= 20.18.3
- Yarn v4.13.0
- nargo v1.0.0-beta.3 (WSL on Windows)
- bb v0.82.2 (WSL on Windows)

---

## Development Progress

### Phase 0: Project Scaffold ✅

**Goal:** Set up the monorepo with all required dependencies and tooling.

**What was done:**
1. Scaffolded a fresh project using `npx create-eth@latest` (Scaffold-ETH 2, v2.0.11)
2. Removed the default sample contract (`YourContract.sol`) — we build our own from scratch
3. Created the `packages/circuits` package using `nargo init --name circuits` in WSL
4. Installed ZK dependencies in `packages/hardhat`:
   - `@zk-kit/lean-imt.sol` — on-chain Incremental Merkle Tree for voter commitments
5. Installed ZK dependencies in `packages/nextjs`:
   - `@aztec/bb.js` — Barretenberg proving engine (browser ZK proof generation)
   - `@noir-lang/noir_js` — Noir circuit execution in JavaScript
   - `poseidon-lite` — ZK-friendly Poseidon hash function
   - `@zk-kit/lean-imt` — JS-side Merkle tree (mirrors on-chain tree)
6. Installed `nargo v1.0.0-beta.3` and `bb v0.82.2` in WSL Ubuntu
7. Verified `nargo compile` works on the default circuit
8. Updated `.gitignore` to exclude `packages/circuits/target/`

**How it was verified:**
- `yarn chain` — Local Hardhat blockchain starts on port 8545
- `yarn deploy` — YourContract (sample) deploys successfully
- `yarn start` — Next.js frontend launches and connects to local chain
- `nargo compile` — Noir circuit compiles successfully in WSL

---

### Phase 1: Voting Contract Structure ✅

**Goal:** Replace the sample contract with a Voting contract skeleton containing all the errors, events, state variables, and placeholder functions needed for the ZK voting system.

**What was done:**
1. Created `Voting.sol` — the main voting contract with:
   - **Errors:** `Voting__NotAllowedToVote`, `Voting__CommitmentAlreadyAdded`, `Voting__EmptyTree`, `Voting__InvalidRoot`, `Voting__InvalidProof`, `Voting__NullifierHashAlreadyUsed`
   - **Events:** `VoterAdded`, `NewLeaf` (registration), `VoteCast` (voting)
   - **State:** `s_question`, `s_yesVotes`, `s_noVotes`, `s_voters` (allowlist)
   - **Functions:** `addVoters()` (owner-only allowlist), `register()` (placeholder), `vote()` (placeholder), `getVotingData()`, `getVoterData()`
2. Created `Verifier.sol` — placeholder `HonkVerifier` contract (always returns true). Will be replaced with the real Barretenberg-generated verifier later.
3. Defined `IVerifier` interface with `verify(bytes, bytes32[])` — the standard interface for ZK proof verification on-chain.
4. Updated deploy script to deploy `Voting` with owner address and a question string.
5. Removed old `YourContract.sol`.

**Contract Design Decisions:**
- Uses OpenZeppelin `Ownable` for access control on `addVoters()`
- Uses `@zk-kit/lean-imt.sol` LeanIMT for the Merkle tree (imported, activated when we build registration)
- Constructor takes `_owner` and `_question` (verifier added when we build voting)
- `vote()` accepts proof bytes + 4 public inputs (nullifierHash, root, vote, depth) matching the circuit layout

**How it was verified:**
```
yarn chain     → Hardhat node running on port 8545
yarn deploy    → Voting contract deployed successfully
               → "Do you support this proposal?" confirmed as voting question
               → 534,370 gas used
yarn start     → Frontend at http://localhost:3000
```

**Observed on Debug Contracts page (`localhost:3000/debug`):**

The Debug page auto-generates a UI for the deployed Voting contract. It has two sections:

📖 **Read Section** (query on-chain state, no gas needed):
| Function | Input | Output |
|----------|-------|--------|
| `getVotingData()` | none | `["Do you support this proposal?", 0, 0]` — (question, yesVotes, noVotes) |
| `getVoterData(address)` | any address | `true`/`false` — whether that address is on the allowlist |
| `s_question` | none | `"Do you support this proposal?"` |
| `s_yesVotes` | none | `0` |
| `s_noVotes` | none | `0` |
| `s_voters(address)` | any address | `true`/`false` |
| `owner()` | none | deployer address (first Hardhat account) |

✍️ **Write Section** (sends transactions, costs gas):
| Function | Input | Status |
|----------|-------|--------|
| `addVoters(address[])` | array of addresses | ✅ Working — adds addresses to allowlist |
| `register(uint256)` | commitment value | ❌ Reverts "Not implemented yet" (next phase) |
| `vote(bytes, bytes32, bytes32, bytes32, bytes32)` | proof + public inputs | ❌ Reverts "Not implemented yet" (later phase) |
| `renounceOwnership()` | none | inherited from OpenZeppelin |
| `transferOwnership(address)` | new owner address | inherited from OpenZeppelin |

> Note: Contract address is assigned at deploy time and may change on redeployment. The address shown on the Debug page is always the current deployed instance.

**Try it yourself:**
1. Make sure you're connected as the **owner** (Hardhat Account #0, e.g. `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`). If using MetaMask, import with private key (example): `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`
2. In the **Write** section → `addVoters` → paste (example): `["0x70997970C51812dc3A010C7d01b50e0d17dc79C8"]` → click **Send**
3. In the **Read** section → `s_voters` → paste same address (example): `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` → click **Read**
4. It should now show `true` — that address is on the allowlist

> ⚠️ All addresses above are examples from the default Hardhat accounts. Your actual addresses may differ depending on your setup.

---

### Phase 2: Voter Registration with LeanIMT ✅

**Goal:** Implement the `register()` function so allowlisted voters can submit a cryptographic commitment to the on-chain Merkle tree.

**What was done:**
1. Activated registration state variables in `Voting.sol`:
   - `s_hasRegistered` — tracks whether an address has already registered (prevents double-registration)
   - `s_commitments` — tracks used commitment values (prevents duplicate commitments across addresses)
   - `s_tree` — `LeanIMTData` struct from `@zk-kit/lean-imt.sol` (the on-chain Merkle tree)

2. Implemented `register(uint256 _commitment)`:
   - Checks caller is on the allowlist AND has not already registered
   - Checks commitment has not been used before
   - Marks commitment and address as used
   - Inserts commitment into the Lean Incremental Merkle Tree
   - Emits `NewLeaf(index, commitment)` event

3. Updated `getVotingData()` to also return `treeRoot` and `treeDepth`
4. Updated `getVoterData()` to also return `hasRegistered` status

5. Updated deploy script to deploy the required libraries:
   - `PoseidonT3` — ZK-friendly hash function library (3.7M gas)
   - `LeanIMT` — Merkle tree library linked to PoseidonT3 (1M gas)
   - `Voting` — linked to LeanIMT library (672K gas)

6. Wrote 11 unit tests covering:
   - Successful registration and event emission
   - Tree root/depth updates after registration
   - Multiple registrations with sequential leaf indices
   - Revert when caller not on allowlist
   - Revert when caller already registered
   - Revert when commitment already used
   - View function returns before/after registration

**How it was verified:**
```
npx hardhat compile    → Compiles successfully (warnings only for unimplemented vote())
npx hardhat test       → 11 passing (741ms)
```

**Test output with gas report:**

![Phase 2 Test Gas Report](docs/images/phase2-test-gas-report.png)

**Gas costs (from test report):**
| Operation | Gas |
|-----------|-----|
| `addVoters()` | ~72,412 |
| `register()` (first leaf) | ~142,660 |
| `register()` (second leaf) | ~181,833 |

**Observed on Debug Contracts page (`localhost:3000/debug`):**

📖 **Read Section** — updated returns:
| Function | Output |
|----------|--------|
| `getVotingData()` | `["Do you support this proposal?", 0, 0, <treeRoot>, <treeDepth>]` |
| `getVoterData(address)` | `[true/false, true/false]` — (isAllowed, hasRegistered) |

✍️ **Write Section** — `register(uint256)` now works:
| Function | Input | Effect |
|----------|-------|--------|
| `register(uint256)` | any uint256 commitment | Inserts into Merkle tree, marks voter as registered |

**Try it yourself:**
1. `addVoters` with an address (e.g. `["0x70997970C51812dc3A010C7d01b50e0d17dc79C8"]`)
2. Switch to that account in MetaMask
3. Call `register` with any number (e.g. `42`) — in the real flow this will be a Poseidon hash
4. Call `getVoterData` with that address → should show `[true, true]`
5. Call `getVotingData` → tree root is now non-zero, depth reflects the number of leaves

> ⚠️ All addresses above are examples. Commitment values in production will be Poseidon hashes of (nullifier, secret).

> ⚠️ If you get `OwnableUnauthorizedAccount` error, you're not connected as the owner. Only the deployer (Account #0) can call `addVoters`.

---

### Phase 3: ZK Circuit — Commitment Scheme ✅

**Goal:** Write the Noir circuit that proves knowledge of a secret commitment without revealing the underlying values.

**What was done:**
1. Replaced the default placeholder circuit in `packages/circuits/src/main.nr` with the commitment scheme circuit:
   - **Public input:** `nullifier_hash` — the value that will be stored on-chain to prevent double-voting
   - **Private inputs:** `nullifier`, `secret` — known only to the voter
   - **Constraints:**
     - Recomputes `hash_1([nullifier])` and asserts it equals the public `nullifier_hash`
     - Computes `commitment = hash_2([nullifier, secret])` — this is the leaf value registered in the Merkle tree

2. Uses Noir's built-in Poseidon hash functions from `std::hash::poseidon::bn254`:
   - `hash_1` — single-element Poseidon hash (for nullifier → nullifier_hash)
   - `hash_2` — two-element Poseidon hash (for nullifier + secret → commitment)

**Circuit Design:**
```
┌─────────────────────────────────────┐
│           ZK Circuit                │
│                                     │
│  Private: nullifier, secret         │
│  Public:  nullifier_hash            │
│                                     │
│  assert hash_1(nullifier)           │
│         == nullifier_hash  ✓        │
│                                     │
│  commitment = hash_2(nullifier,     │
│                       secret)       │
│  (used for Merkle root in Phase 4)  │
└─────────────────────────────────────┘
```

**Why this matters:**
- The nullifier_hash is stored on-chain when voting — if someone tries to vote twice, the contract detects the duplicate nullifier_hash
- The secret ensures that even if nullifier is leaked, no one else can forge the commitment
- The circuit proves the voter knows the preimage of their commitment without revealing it

**How it was verified:**
```
nargo compile    → Compiles successfully (no errors)
                 → Produces target/circuits.json artifact
```

**What `target/circuits.json` contains:**

| Field | Description |
|-------|-------------|
| `noir_version` | Compiler version that produced the artifact (e.g. `1.0.0-beta.3`) |
| `hash` | Unique identifier for this specific circuit compilation |
| `abi` | Circuit interface — lists all parameters with their names, types (`field`), and visibility (`public`/`private`). Also includes `return_type` and `error_types` |
| `bytecode` | Base64-encoded gzipped ACIR (Abstract Circuit Intermediate Representation) — the compiled constraint system |

This JSON is used by:
- `noir_js` in the browser to execute the circuit and compute a witness
- `bb` (Barretenberg) to generate and verify proofs
- The Solidity verifier generator to produce an on-chain verification contract

**Next:** Phase 4 will extend this circuit to also prove that the commitment exists in the on-chain Merkle tree (membership proof).

---

### Phase 4: ZK Circuit — Merkle Root Verification ✅

**Goal:** Extend the circuit to prove the voter's commitment is actually in the on-chain Merkle tree (membership proof).

**What was done:**
1. Added `binary_merkle_root` dependency from zk-kit.noir to `Nargo.toml`:
   ```toml
   binary_merkle_root = { git = "https://github.com/privacy-scaling-explorations/zk-kit.noir", tag = "binary-merkle-root-v0.0.1", directory = "packages/binary-merkle-root" }
   ```

2. Extended `main.nr` with new inputs and Merkle root logic:
   - **New public inputs:** `root` (on-chain tree root), `vote` (yes/no choice), `depth` (tree depth)
   - **New private inputs:** `index` (leaf position), `siblings[16]` (path hashes)
   - **New constraints:**
     - Count non-zero siblings to determine actual path length
     - Assert depth ≤ 16 (max array length safety bound)
     - Convert `index` to 16 little-endian bits (determines left/right at each level)
     - Compute Merkle root using `binary_merkle_root(hash_2, commitment, siblings_num, index_bits, siblings)`
     - Assert computed root equals public `root` input
     - Bind vote to proof: `vote_field² == vote_field` (ensures it's 0 or 1 and prevents compiler warning)

**Full Circuit ABI (after compilation):**

| Parameter | Type | Visibility | Purpose |
|-----------|------|------------|---------|
| `nullifier_hash` | Field | public | On-chain nullifier (prevents double-voting) |
| `nullifier` | Field | private | Secret value hashed to produce nullifier_hash |
| `secret` | Field | private | Combined with nullifier to form commitment |
| `root` | Field | public | On-chain Merkle tree root to verify against |
| `vote` | bool | public | Voter's choice (bound to proof) |
| `depth` | u32 | public | Current tree depth |
| `index` | Field | private | Leaf position in tree (hidden for privacy) |
| `siblings` | [Field; 16] | private | Merkle path hashes (supports up to 65,536 voters) |

**Circuit Flow:**
```
┌──────────────────────────────────────────────────────┐
│                    ZK Circuit                         │
│                                                      │
│  1. Verify nullifier:                                │
│     assert hash_1(nullifier) == nullifier_hash  ✓    │
│                                                      │
│  2. Compute commitment:                              │
│     commitment = hash_2(nullifier, secret)           │
│                                                      │
│  3. Verify Merkle membership:                        │
│     Walk from commitment up the tree using           │
│     index_bits + siblings → computed_root            │
│     assert computed_root == root  ✓                  │
│                                                      │
│  4. Bind vote:                                       │
│     assert vote² == vote  ✓                          │
└──────────────────────────────────────────────────────┘
```

**Why the index is private:**
If the index were public, anyone could see which leaf (registration) is voting — breaking anonymity. Keeping it private means the proof only reveals "I'm in the tree" without showing where.

**Why vote is bound to the proof:**
Without binding, an attacker could intercept a valid proof and resubmit it with a different vote choice. Since `vote` is a public input baked into the proof, the proof is only valid for that specific vote.

**How it was verified:**
```
nargo compile    → Compiles successfully (no errors)
                 → Artifact size: ~792KB (vs ~58KB in Phase 3 — Merkle logic adds constraints)
                 → ABI confirms 4 public + 4 private inputs
```

**What `nargo compile` generates (`target/circuits.json`):**

The compilation produces a single JSON artifact that acts as the circuit's "binary". It contains everything needed to generate proofs and verify them:

| Field | Content | Used By |
|-------|---------|---------|
| `noir_version` | Compiler version (e.g. `1.0.0-beta.3`) | Compatibility checks |
| `hash` | Unique fingerprint of this circuit build | Cache invalidation |
| `abi` | Full interface — parameter names, types, visibility (`public`/`private`), return type | `noir_js` (to know what inputs to expect), frontend (to format inputs correctly) |
| `bytecode` | Base64-encoded gzipped ACIR (Abstract Circuit Intermediate Representation) | Everything below |

**How the artifact is used downstream:**

1. **`noir_js` (browser)** — Loads `circuits.json`, takes user inputs, and executes the circuit to produce a **witness** (the full set of variable assignments satisfying all constraints)
2. **`bb` (Barretenberg)** — Takes the bytecode + witness and generates a cryptographic **proof** (a compact object that proves the witness exists without revealing private inputs)
3. **`bb write_vk`** — Extracts a **verification key** from the bytecode (a compact summary of the circuit's constraints, generated once per circuit)
4. **`bb write_solidity_verifier`** — Takes the vk and generates a **Solidity contract** (`Verifier.sol`) that can verify proofs on-chain
5. **On-chain verifier** — The deployed contract calls `verify(proof, publicInputs)` and returns `true`/`false`

```
circuits.json (bytecode + ABI)
    │
    ├─→ noir_js.execute(inputs) → witness
    │       │
    │       └─→ bb.prove(bytecode, witness) → proof
    │
    ├─→ bb.write_vk(bytecode) → verification key (vk)
    │       │
    │       ├─→ bb.verify(vk, proof) → true/false (off-chain check)
    │       │
    │       └─→ bb.write_solidity_verifier(vk) → Verifier.sol
    │               │
    │               └─→ deployed on-chain → verify(proof, publicInputs) → true/false
    │
    └─→ Frontend loads ABI to format inputs correctly
```

**Next:** Phase 5 will generate the Solidity verifier contract from this circuit using Barretenberg (`bb`).

---

### Phase 5: Generate Solidity Verifier Contract ✅

**Goal:** Use Barretenberg (`bb`) to generate a real on-chain ZK proof verifier from the compiled circuit.

**What was done:**
1. Generated the verification key (vk) from the circuit bytecode:
   ```bash
   bb write_vk --oracle_hash keccak -b ./target/circuits.json -o ./target/
   ```
   - `--oracle_hash keccak` ensures hashing matches Ethereum's Keccak256 standard
   - Output: `target/vk` (1,760 bytes) — a compact summary of the circuit's constraints

2. Generated the Solidity verifier contract from the vk:
   ```bash
   bb write_solidity_verifier -k ./target/vk -o ./target/Verifier.sol
   ```
   - Output: `target/Verifier.sol` (1,883 lines) — full on-chain verifier using UltraHonk proving scheme

3. Replaced the placeholder `Verifier.sol` in `packages/hardhat/contracts/` with the real generated contract

4. Verified:
   - Hardhat compiles successfully
   - All 11 existing tests still pass
   - `NUMBER_OF_PUBLIC_INPUTS = 4` matches our circuit (nullifier_hash, root, vote, depth)

**Key properties of the generated verifier:**

| Property | Value |
|----------|-------|
| Circuit size | 32,768 gates (N) |
| Log circuit size | 15 (LOG_N) |
| Public inputs | 4 |
| Proving scheme | UltraHonk |
| Deployment gas | ~4,727,047 (~7.9% of block limit) |
| Verifier interface | `verify(bytes calldata _proof, bytes32[] calldata _publicInputs) → bool` |

**How the pipeline worked:**
```
main.nr → nargo compile → circuits.json (ACIR bytecode)
                              ↓
              bb write_vk → vk (verification key, 1.7KB)
                              ↓
              bb write_solidity_verifier → Verifier.sol (1,883 lines)
                              ↓
              Replaces placeholder in hardhat/contracts/
                              ↓
              Hardhat compile → HonkVerifier deployed on-chain
```

**Important notes:**
- The vk is embedded directly in the contract — no external data needed at verification time
- Every time the circuit changes, you must regenerate: compile → vk → Verifier.sol
- The `IVerifier` interface in the generated contract matches what `Voting.sol` expects
- The generated contract uses `pragma solidity >=0.8.21` (compatible with our hardhat config)

**How it was verified:**
```
bb write_vk          → VK saved (scheme: ultra_honk, circuit size: 19,278)
bb write_solidity    → Verifier.sol (1,883 lines)
hardhat compile      → 2 Solidity files compiled successfully
hardhat test         → 11 passing
```

**Next:** Phase 6 will implement the `vote()` function in Voting.sol, wiring proof verification with the real verifier contract.

---

### Phase 6: Implement vote() Function + End-to-End Proof Verification ✅

**Goal:** Implement the `vote()` function in Voting.sol and verify the entire ZK pipeline works end-to-end — from generating witness inputs, through proof generation, to off-chain verification.

**What was done:**

#### 1. Implemented `vote()` in `Voting.sol`

The core voting function that accepts a ZK proof and records a vote:

```solidity
function vote(
    bytes calldata _proof,
    bytes32 _nullifierHash,
    bytes32 _root,
    bytes32 _vote,
    bytes32 _depth
) external
```

**Logic flow:**
1. **Root validation:** Ensures root is non-zero (`Voting__EmptyTree`) and matches the current on-chain tree root (`Voting__InvalidRoot`)
2. **Proof verification:** Assembles `publicInputs[4]` array and calls `i_verifier.verify(proof, publicInputs)` — reverts with `Voting__InvalidProof` if invalid
3. **Nullifier check:** Ensures the nullifier hash has not been used before (`Voting__NullifierHashAlreadyUsed`) — prevents double-voting
4. **Vote counting:** Increments `s_yesVotes` or `s_noVotes` based on the vote input
5. **Event emission:** Emits `VoteCast(nullifierHash, voter, voteChoice, timestamp, yesVotes, noVotes)`

#### 2. Created `generate_prover_inputs.mjs` — Dummy Witness Generation

A Node.js script (`packages/nextjs/generate_prover_inputs.mjs`) that generates valid circuit inputs using the same Poseidon hash functions as the Noir circuit:

```bash
node packages/nextjs/generate_prover_inputs.mjs
```

**What it does:**
- Picks arbitrary private values (nullifier=42, secret=123)
- Computes `nullifier_hash = poseidon1([nullifier])`
- Computes `commitment = poseidon2([nullifier, secret])`
- Builds a depth-3 dummy Merkle tree with the commitment at index 2
- Walks up the tree computing intermediate nodes with `poseidon2`
- Outputs a valid `Prover.toml` with all inputs correctly computed

**Output:**
```
nullifier_hash = 12326503012965816391338144612242952408728683609716147019497703475006801258307
commitment     = 13354932457729771147254927911602504548850183657014898888488396374653942452945
root           = 14323779011469951618447924429445439226819608782236079685175267553238899867272
```

#### 3. Verified the Full ZK Pipeline End-to-End

Using the generated `Prover.toml`, ran the complete proof lifecycle:

```bash
# Step 1: Execute circuit → produce witness
nargo execute
# → Circuit witness successfully solved

# Step 2: Generate ZK proof from witness
bb prove --oracle_hash keccak -b ./target/circuits.json -w ./target/circuits.gz -o ./target/proof_output
# → Proof saved (scheme: ultra_honk, circuit size: 19,278)

# Step 3: Verify proof against verification key
bb verify --oracle_hash keccak -k ./target/vk -p ./target/proof_output/proof
# → Proof verified successfully ✅
```

**This confirms:**
- The Noir circuit constraints are satisfiable with real Poseidon hashes
- The commitment scheme (`hash_2(nullifier, secret)`) produces correct leaves
- The Merkle root computation matches between JS (poseidon-lite) and Noir (std::hash::poseidon::bn254)
- The generated `Verifier.sol` (Phase 5) is compatible with proofs produced by `bb`
- The full chain works: JS inputs → nargo witness → bb proof → bb verify

**vote() Function Flow:**
```
┌─────────────────────────────────────────────────────────┐
│                    vote() Function                        │
│                                                          │
│  1. Check root != bytes32(0)                             │
│     → Voting__EmptyTree                                  │
│                                                          │
│  2. Check root == s_tree.root()                          │
│     → Voting__InvalidRoot                                │
│                                                          │
│  3. Build publicInputs[4] from:                          │
│     [nullifierHash, root, vote, depth]                   │
│                                                          │
│  4. Call i_verifier.verify(proof, publicInputs)          │
│     → Voting__InvalidProof                               │
│                                                          │
│  5. Check nullifier not already used                     │
│     → Voting__NullifierHashAlreadyUsed                   │
│                                                          │
│  6. Store nullifier: s_nullifierHashes[nullifier] = true │
│                                                          │
│  7. Increment s_yesVotes or s_noVotes                    │
│                                                          │
│  8. Emit VoteCast(...)                                   │
└─────────────────────────────────────────────────────────┘
```

**How it was verified:**
```
hardhat compile  → Compiles successfully
hardhat test     → 11 passing (registration tests)
nargo execute    → Witness solved from generated Prover.toml
bb prove         → Real UltraHonk proof generated (14KB)
bb verify        → Proof verified successfully ✅
```

**Files added/modified:**
| File | Action |
|------|--------|
| `packages/hardhat/contracts/Voting.sol` | Implemented `vote()` function |
| `packages/nextjs/generate_prover_inputs.mjs` | Created — generates valid dummy witness inputs |
| `packages/circuits/Prover.toml` | Created — circuit inputs for proof generation |

**Next:** Phase 7 will build the frontend commitment creation component (generate nullifier + secret, compute Poseidon hash, call `register()`).

---

### Phase 7: Frontend — Voting UI & Commitment Registration ✅

**Goal:** Build the complete frontend voting interface that connects to the deployed smart contracts, allowing voters to register (create commitment + insert into Merkle tree), select their vote, and prepare for proof generation.

**What was done:**

#### 1. Created the Voting Page Layout (`app/voting/page.tsx`)

The main voting page orchestrates all components in a sequential flow:
1. Show/Add Voters (admin) → 2. View Stats → 3. Register → 4. Choose Vote → 5. Generate Proof → 6. Vote

#### 2. Created Voting Components (`app/voting/_components/`)

| Component | Purpose |
|-----------|---------|
| `VotingStats.tsx` | Reads on-chain state via `getVotingData()` — displays question, owner, contract address, yes/no vote counts with live progress bar |
| `VoteChoice.tsx` | Yes/No selector using Zustand store (`challengeStore`) — choice is bound to the ZK proof later |
| `ShowVotersButton.tsx` | Reads `VoterAdded` events, displays all registered voter addresses with status (allowed/revoked, registered/not) |
| `AddVotersModal.tsx` | Owner-only UI to batch-add voter addresses to the allowlist via `addVoters()` contract call |
| `LogStorageButton.tsx` | Debug utility — logs localStorage state (commitment, proof, burner wallet) to console |
| `ClearStorageButton.tsx` | Clears all stored commitment/proof data from localStorage |

#### 3. Created Challenge Components (`app/voting/_challengeComponents/`)

| Component | Purpose | Status |
|-----------|---------|--------|
| `CreateCommitment.tsx` | **Core Phase 7** — generates nullifier + secret using `Fr.random()`, computes Poseidon2 commitment, calls `register()` on-chain | ✅ Complete |

#### 4. Created Supporting Infrastructure

| File | Purpose |
|------|---------|
| `services/store/challengeStore.ts` | Zustand state store — holds `commitmentData`, `proofData`, `voteChoice` across components |
| `utils/proofStorage.ts` | localStorage utilities — save/load commitment, proof, burner wallet, and transaction result per contract+user |
| `app/api/circuit/route.ts` | Next.js API route — serves `circuits.json` to the browser for client-side proof generation |
| `contracts/deployedContracts.ts` | Regenerated ABI — includes full `getVotingData` with all 7 return fields (question, owner, yesVotes, noVotes, nullCount, treeDepth, treeRoot) |

#### 5. UI/UX Redesign — FYP Branding

Transformed the default Scaffold-ETH theme into a modern FYP-branded interface:

| File | Changes |
|------|---------|
| `styles/globals.css` | Custom DaisyUI theme (indigo/purple/cyan gradient palette), glass morphism, hover-lift animations, gradient text utilities |
| `app/page.tsx` | FYP landing page with university + faculty logos, project title, team members, feature cards, tech stack |
| `components/Header.tsx` | Custom ZK Voting SVG logo, gradient branding, removed Faucet button |
| `components/Footer.tsx` | GitHub link, removed Faucet/BuidlGuidl/price display, kept Block Explorer |
| `app/debug/page.tsx` | Removed Scaffold-ETH description banner |
| `utils/scaffold-eth/getMetadata.ts` | Updated title/favicon to "ZK Voting" branding |
| `public/zk-logo.svg` + `public/favicon.svg` | Custom shield+checkmark logo (gradient, modern, no text) |
| `public/uni_logo.png` | University of Ruhuna logo |
| `public/engineering_logo.png` | Faculty of Engineering logo |

---

#### How Frontend Connects to Blockchain

The frontend communicates with deployed smart contracts through Scaffold-ETH 2's hook system, which wraps wagmi/viem under the hood:

```
┌─────────────────────────────────────────────────────────────────┐
│                     FRONTEND (Next.js)                           │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Scaffold-ETH Hooks (wagmi + viem wrappers)             │    │
│  │                                                          │    │
│  │  useScaffoldReadContract()  → reads on-chain state       │    │
│  │  useScaffoldWriteContract() → sends transactions         │    │
│  │  useScaffoldEventHistory()  → listens to past events     │    │
│  │  useDeployedContractInfo()  → gets ABI + address         │    │
│  └──────────────────────┬──────────────────────────────────┘    │
│                         │                                        │
│  ┌──────────────────────▼──────────────────────────────────┐    │
│  │  deployedContracts.ts (Generated ABI + addresses)        │    │
│  │  - Contains full contract ABI (function signatures)      │    │
│  │  - Contains deployed address per chain ID                │    │
│  │  - Auto-generated by `yarn deploy`                       │    │
│  └──────────────────────┬──────────────────────────────────┘    │
│                         │                                        │
└─────────────────────────┼────────────────────────────────────────┘
                          │ JSON-RPC (HTTP/WebSocket)
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                 BLOCKCHAIN (Hardhat / Sepolia)                    │
│                                                                  │
│  ┌─────────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │  Voting.sol      │  │  HonkVerifier.sol │  │  PoseidonT3   │  │
│  │  - addVoters()   │  │  - verify()       │  │  - poseidon() │  │
│  │  - register()    │  │                    │  │               │  │
│  │  - vote()        │  └──────────────────┘  └───────────────┘  │
│  │  - getVotingData │                                            │
│  │  - getVoterData  │  ┌──────────────────┐                     │
│  └─────────────────┘  │  LeanIMT          │                     │
│                        │  - _insert()      │                     │
│                        │  - _root()        │                     │
│                        └──────────────────┘                     │
└─────────────────────────────────────────────────────────────────┘
```

**Data flow for voter registration (CreateCommitment.tsx):**
```
1. Fr.random() → nullifier (cryptographically random field element)
2. Fr.random() → secret   (cryptographically random field element)
3. poseidon2([nullifier, secret]) → commitment (hash)
4. writeContractAsync("register", [commitment]) → TX sent to blockchain
5. Blockchain: Voting.register(commitment) → inserts into LeanIMT
6. Event: NewLeaf(index, commitment) emitted
7. Frontend: saves {nullifier, secret, commitment, index} to localStorage
```

**Key connection points:**

| Frontend Hook | Contract Function | What it does |
|--------------|-------------------|--------------|
| `useScaffoldReadContract("getVotingData")` | `Voting.getVotingData()` | Reads question, owner, votes, tree root/depth |
| `useScaffoldReadContract("getVoterData")` | `Voting.getVoterData(addr)` | Checks if address is voter + has registered |
| `useScaffoldWriteContract("register")` | `Voting.register(commitment)` | Inserts commitment into Merkle tree |
| `useScaffoldWriteContract("addVoters")` | `Voting.addVoters(addrs, statuses)` | Owner adds voters to allowlist |
| `useScaffoldEventHistory("NewLeaf")` | `event NewLeaf(index, commitment)` | Tracks all tree insertions (for Merkle proof) |
| `useScaffoldEventHistory("VoterAdded")` | `event VoterAdded(voter)` | Lists all added voters |

**Why `deployedContracts.ts` is critical:**
- Generated by `yarn deploy` — contains the ABI and deployed address
- Without the correct ABI, hooks can't encode/decode function calls
- Must be regenerated after any contract change (`yarn deploy --reset`)

---

#### CreateCommitment.tsx — The Core Phase 7 Logic

This is the most important component. It implements the cryptographic registration flow:

```typescript
// 1. Generate random field elements (cryptographically secure)
const nullifier = BigInt(Fr.random().toString());
const secret = BigInt(Fr.random().toString());

// 2. Compute Poseidon2 hash (same as Noir circuit uses)
const commitment = poseidon2([nullifier, secret]);

// 3. Convert to hex for Solidity
const commitmentHex = toHex(commitment, { size: 32 });

// 4. Send to blockchain
await writeContractAsync({
  functionName: "register",
  args: [BigInt(commitmentHex)],
});

// 5. Save to localStorage for proof generation later
saveCommitmentToLocalStorage({ commitment, nullifier, secret, index });
```

**Why Fr.random():**
- `Fr` is Barretenberg's finite field element class
- Generates a random value in the BN254 scalar field (the same field Noir uses)
- Ensures the values are valid circuit inputs (< field modulus)

**Why Poseidon2:**
- Same hash function used in the Noir circuit (`hash_2`)
- `poseidon-lite` library produces identical outputs to Noir's `std::hash::poseidon::bn254::hash_2`
- This ensures the commitment computed in the browser matches what the circuit will verify

**Why localStorage:**
- The nullifier and secret are needed later for proof generation (Phase 8)
- They cannot be recovered from the on-chain commitment (one-way hash)
- If lost, the voter cannot prove their membership — they cannot vote

---

#### Critical Files Summary

| File | Role | Why it matters |
|------|------|----------------|
| `app/voting/page.tsx` | Page orchestrator | Composes all voting components in correct order |
| `_challengeComponents/CreateCommitment.tsx` | Registration logic | Fr.random() + poseidon2 + register() — the ZK commitment scheme |
| `_challengeComponents/GenerateProof.tsx` | Proof generation scaffold | Will use noir_js + bb.js to generate ZK proof in browser |
| `_components/VotingStats.tsx` | Live stats display | Reads getVotingData() — shows votes, root, depth |
| `_components/VoteChoice.tsx` | Vote selector | Stores choice in Zustand — bound to proof |
| `services/store/challengeStore.ts` | Cross-component state | Shares commitment/proof/vote data between steps |
| `utils/proofStorage.ts` | Persistence layer | localStorage for commitment/proof survival across page reloads |
| `contracts/deployedContracts.ts` | ABI bridge | Auto-generated — connects frontend hooks to contract functions |
| `app/api/circuit/route.ts` | Circuit delivery | Serves circuits.json for browser proof generation |
| `styles/globals.css` | Theme/branding | Custom DaisyUI theme with modern FYP aesthetic |

**How it was verified:**
- Frontend compiles and serves at `localhost:3000`
- Voting page renders all components correctly
- Connected wallet shows voter status
- Owner can add voters via the AddVotersModal
- CreateCommitment button is enabled when wallet is allowlisted + not yet registered
- After registration, button shows "✓ Already registered for this vote"
- VotingStats updates live with tree root/depth after registration
- localStorage correctly persists commitment data

**Next:** Phase 8 will implement browser-side ZK proof generation using `noir_js` + `@aztec/bb.js` (UltraHonkBackend).