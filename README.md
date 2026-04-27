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
   - `permissionless` — ERC-4337 smart account abstraction for gasless voting
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
   - Commented-out sections for Merkle tree state and verifier + nullifiers — ready to uncomment later
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