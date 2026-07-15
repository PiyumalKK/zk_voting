# Custom Blockchain ⇄ Hardhat Swap — Readiness Analysis & Execution Plan

> **STATUS: IMPLEMENTED (2026-07-04).** All four phases below have been executed:
> the backend fixes in §3 are live in `packages/blockchain`, the frontend seam in §4
> exists as `packages/nextjs/services/chain/` (hook facade rather than adapter
> classes — same interface, rules-of-hooks-friendly), the admin proxy is
> `app/api/admin/[action]/route.ts`, and switching backends is a one-env-var change
> (see README → "Switching Chain Backends"). This document remains as the design
> rationale and analysis record.

**Date:** 2026-07-04
**Scope analyzed:** `packages/blockchain` (Go node, Stages 1–6), `packages/nextjs` (all voting UI + scaffold-eth hooks), `packages/hardhat` (contracts + deploy), `packages/circuits` (consumed as artifacts).

---

## 1. Verdict

**The backend is functionally ready to replace Hardhat — the integration test proves the entire
cryptographic flow works over REST** (commitment → register → Merkle root update → real UltraHonk
proof → EVM Honk verification → double-vote rejection via nullifier → state replay after restart).
Semantic parity with Hardhat is guaranteed *by construction*, because the Go node executes the
**same compiled `Voting.sol` / `HonkVerifier.sol` bytecode** inside an embedded EVM instead of
reimplementing the logic.

**But the system is NOT yet plug-and-play**, for two reasons:

1. **Four backend defects block a browser client entirely or corrupt its data** (§3). The most
   severe: the public API requires an mTLS *client certificate*, which no browser can supply —
   the frontend literally cannot open a connection to the node today. The integration test only
   passes because Node.js scripts *can* present client certs (`run.mjs` line ~161).
2. **The frontend has no abstraction seam.** All 10 voting components call
   `useScaffoldReadContract` / `useScaffoldWriteContract` / `useScaffoldEventHistory` / raw viem
   clients directly. There is no interface to plug a second backend into — Stage 7 ("Frontend
   Connection") was deferred, and it *is* the swap work. Until it exists, "swapping" means
   rewriting every component, which is the opposite of plug-and-play.

Also, one correction to your assumption (§5): **Hardhat is the evolution-resistant side, not the
brittle one.** Scaffold-ETH regenerates `deployedContracts.ts` from the ABI on every deploy and its
hooks are generic over the ABI, so contract changes flow to the frontend automatically. It is the
**Go node that is hardcoded** to the current contract shape (typed bridge methods, tx types, replay
switch, one handler per Solidity function). That's a maintainability cost, not a blocker — §5 has
the mitigation.

---

## 2. What is already correct (no changes needed)

| Concern | Status |
|---|---|
| Same `Voting.sol`, `HonkVerifier.sol`, PoseidonT3, LeanIMT bytecode executed | ✅ Artifacts refreshed after the multi-candidate rewrite; deployed at fixed nonces in the embedded EVM |
| ZK verification (BN254 pairing precompile, UltraHonk keccak flavor) | ✅ Proven by integration test with a real proof |
| Double-vote prevention (nullifier), stale-root rejection, phase gating | ✅ Same contract logic; EVM called **before** block commit so rejected txs never pollute the chain |
| Frontend privacy split (nullifier/secret never leave the browser) | ✅ Node only ever sees commitment / proof + public inputs; integration test structured to prove this |
| Merkle leaves without event logs | ✅ `GET /commitments` returns insertion-ordered commitments, correctly scoped to the current election (reset-aware) |
| Error compatibility | ✅ `wrapErr()` decodes the same custom Solidity errors (`Voting__NullifierHashAlreadyUsed`, `Voting__WrongPhase`, …) into the response body; the frontend's `.includes("NullifierHashAlreadyUsed")` matching keeps working |
| Admin lifecycle parity | ✅ All six admin actions from `admin/page.tsx` have REST equivalents (`/set-question`, `/set-candidates`, `/start-registration`, `/start-voting`, `/end-election`, `/reset-election`) |
| State durability | ✅ BoltDB persistence + deterministic replay verified across restart |
| Multi-node consistency | ✅ mTLS P2P, broadcast + periodic re-sync with in-place chain replacement |

---

## 3. Backend blockers (must fix before any frontend work)

### 3.1 CRITICAL — mTLS on the public API makes browser connection impossible

`security.LoadTLSConfig` sets `ClientAuth: tls.RequireAndVerifyClientCert` and
`api.StartServer` uses that config for the **entire** server — public voter endpoints included
(`internal/security/tls.go:31`, `internal/api/server.go:84-98`). Browsers cannot present a client
certificate signed by the node's self-signed cert, so every `fetch()` from Next.js will fail during
the TLS handshake. (Self-signed server certs are a second, separate browser problem.)

**Fix — split the listeners:**
- **Public API listener** (default `:3001`): plain HTTP in dev (`API_TLS=false`), optional standard
  TLS (no `ClientAuth`) for production behind a real cert.
- **P2P listener** (e.g. `:4001`, `P2P_PORT` env): keeps the existing mTLS config; move
  `/internal/block` and `/internal/chain` here exclusively, and remove them from the public mux.
- `network` package peers URLs point at the P2P port; nothing else changes.

This is ~40 lines in `server.go`/`main.go` and preserves all the Stage 1 hardening for
node-to-node traffic.

### 3.2 CRITICAL — `*big.Int` fields serialized as bare JSON numbers

`VotingData.Root` (a BN254 field element, ~254 bits) is marshaled as a raw JSON number
(`internal/evm/bridge.go:99-110`). `JSON.parse` in the browser silently truncates anything past
2^53 — the root becomes garbage and every generated proof fails root comparison. The integration
test *works around this with a regex* (`bigField()` in `run.mjs`), which is an admission the API is
broken for JS clients.

**Fix:** marshal field-element values as `0x`-prefixed hex strings. Add a custom JSON type
(e.g. `type HexBig big.Int` with `MarshalJSON`) and apply to: `VotingData.Root`, and the
`votes` values in `/vote-counts` (counts are small today, but be consistent). `tree_size`,
`depth`, timestamps can stay numeric (safely < 2^53). Update `run.mjs` to parse hex instead of
regexing.

### 3.3 HIGH — No election-ID exposure

The frontend scopes the Voter Pass file and all localStorage keys by `getCurrentElectionId()`
(`CreateCommitment.tsx`, `GenerateProof.tsx`, `VoteWithBurner*.tsx`). The contract has it, but the
bridge never calls it and no endpoint serves it. Without it, a voter pass from election N would be
indistinguishable from election N+1 after a `/reset-election`.

**Fix:** add `bridge.GetCurrentElectionId()` and include `"election_id"` in the `GET /voting-data`
response (hex or decimal string per §3.2).

### 3.4 HIGH — Write endpoints return raw blocks instead of a client contract

`/register` and `/vote` respond with the full `core.Block` JSON; the client must dig
`transactions[0].payload.leaf_index` out of it (exactly what `run.mjs` does). This couples the
frontend to the chain's internal block format — the thing an API exists to hide.

**Fix:** return purpose-built responses:
- `POST /register` → `201 {"tx_id": "...", "block_index": N, "leaf_index": N, "election_id": "..."}`
- `POST /vote` → `200 {"tx_id": "...", "block_index": N}`
- Admin lifecycle endpoints → `200 {"tx_id": "...", "block_index": N}`

### 3.5 HIGH — Admin auth cannot be driven from the browser admin page

Admin endpoints require an RSA-PKCS1v15 signature of the exact request body
(`X-Admin-Signature`). The admin page runs in the browser; shipping `admin_private.pem` to the
browser defeats the scheme.

**Fix (recommended):** a Next.js **server-side proxy**: route handlers under
`packages/nextjs/app/api/admin/[action]/route.ts` that read `ADMIN_PRIVATE_KEY_PEM` (server env,
never `NEXT_PUBLIC_`), sign the body with Node `crypto`, and forward to the Go node. Protect the
proxy itself with a simple session/password (`ADMIN_DASHBOARD_PASSWORD`) — for an FYP this is
adequate; note it as the production-hardening seam. The Go node keeps its signature scheme
unchanged.

### 3.6 HIGH (confirmed) — EVM block timestamp is frozen at 1, so phase deadlines are dead

`CreateStatelessEVM` spoofs `BlockContext{ Time: 1 }` (`internal/evm/vm.go:52`) and never advances
it. But `Voting.sol` *depends* on real time: `startRegistration` sets
`s_registrationEndTime = block.timestamp + duration` (line 187) and auto-transitions to `Ended`
when `block.timestamp >= endTime` (lines 296–317). Consequences on the custom chain:

- Registration/voting windows **never expire** — only manual admin transitions work (which is why
  the integration test passes: it always transitions manually).
- `registration_end_time` comes back as `1 + duration` (e.g. `3601`), which the frontend compares
  against wall-clock epoch seconds → countdown UI is nonsense.

**Fix (must stay deterministic for replay):** stamp EVM time from the **block being executed**,
not the wall clock at call time:
- Write path: when committing a new transaction, set the EVM's `BlockContext.Time` to the new
  block's timestamp (which is persisted).
- Replay path (`ReplayBlockchain`, peer-block replay): set it to the *stored* block's timestamp —
  replays then reproduce identical state regardless of when they run.
- Read path (`GetVotingData` etc.): set it to current wall clock so the contract's
  "auto-ended" view logic (line 314) reports expired phases correctly.

Mechanically: add `bridge`/`caller` support for setting `Time` per call (recreate the
`vm.BlockContext` or rebuild the EVM per call — it's cheap), and increment `BlockNumber` alongside
if desired. Add an integration-test step: start registration with a 2-second duration, wait, and
assert `/voting-data` reports phase `Ended`.

### 3.7 MEDIUM — `API.md` documents an API that does not exist

`API.md` says `/api/...` prefixes, `X-Admin-Key`, `{"leaves": [...]}`, pagination on `/blocks`,
`{tx_hash, leaf_index}` responses, `/api/circuit` served by the node. Reality (`server.go`): no
prefix, RSA signature header, bare array from `/commitments`, no pagination, block-shaped
responses, circuit served by **Next.js** (`app/api/circuit/route.ts` — correct place; keep it
there). The frontend will be built against this document — rewrite it to match the real server
(after §3.1–§3.4 land), including the standard error body format.

### 3.8 LOW — Operational polish

- **`REQUIRE_EVM` should default to true** once the frontend depends on the node: silent Stage 1/2
  fallback (`/vote` accepted with *no* verification) is a foot-gun. Invert to an opt-out
  (`ALLOW_STORAGE_ONLY=true`).
- **Rate limiting**: 1 req/s + burst 5 per IP is fine for dev; note that a campus NAT would share
  one bucket in a real deployment.
- **`GET /blocks` pagination** (`?page&limit`) — needed only for the block-explorer-lite page
  (Phase 4); trivial to add.
- Genesis question/candidates are duplicated in `packages/hardhat/deploy/00_deploy_your_contract.ts`
  and `core.NewBlockchain(...)` in `main.go` — keep them in sync or read both from one config.

---

## 4. Frontend plan — the actual plug-and-play seam (Stage 7)

### 4.1 Design: a `ChainAdapter` interface

Create `packages/nextjs/services/chain/`:

```
services/chain/
├── types.ts          # ChainAdapter interface + normalized data types
├── evmAdapter.ts     # wraps wagmi/viem/scaffold-eth (current behavior)
├── restAdapter.ts    # wraps the Go node's REST API
├── ChainProvider.tsx # React context; picks adapter from config
└── hooks.ts          # useVotingData(), useLeaves(), useVoterStatus(), ... built on the adapter
```

```ts
// types.ts — the whole swap contract lives here
export interface VotingData {
  question: string;
  phase: 0 | 1 | 2 | 3;
  registrationEndTime: number;
  votingEndTime: number;
  treeSize: number;
  depth: number;
  root: bigint;
  electionId: string;
}

export interface ChainAdapter {
  // reads (poll or subscribe — adapter's choice; hooks expose `watch`)
  getVotingData(): Promise<VotingData>;
  getCandidates(): Promise<string[]>;
  getVoteCounts(): Promise<bigint[]>;
  getVoterStatus(voterId: string): Promise<{ allowed: boolean; registered: boolean }>;
  getLeaves(): Promise<bigint[]>;              // ALWAYS oldest-first, current election only

  // voter writes
  register(voterId: string, commitmentHex: `0x${string}`): Promise<{ leafIndex: number }>;
  vote(v: { proofHex: `0x${string}`; nullifierHashHex: `0x${string}`;
            rootHex: `0x${string}`; candidateIndex: number; depth: number }): Promise<void>;

  // admin writes
  setQuestion(q: string): Promise<void>;
  setCandidates(c: string[]): Promise<void>;
  addVoters(ids: string[]): Promise<void>;
  startRegistration(durationSec: number): Promise<void>;
  startVoting(durationSec: number): Promise<void>;
  endElection(): Promise<void>;
  resetElection(): Promise<void>;
}
```

Key normalizations the interface enforces (today these leak into components):

| Concern | EVM adapter | REST adapter |
|---|---|---|
| Leaves source | `NewLeaf` event history (newest-first) → reverse + slice to `treeSize` (logic currently split across `page.tsx` and `GenerateProof.tsx`) | `GET /commitments` (already oldest-first + reset-scoped) → `BigInt()` map |
| Leaf index after register | decode `NewLeaf` from tx receipt (current `CreateCommitment.tsx` logic) | `leaf_index` from `POST /register` response (§3.4) |
| `getVotingData` shape | tuple indices `[0],[2],[3],[4],[5],[6],[7]` → named fields | JSON keys `question/phase/…/root` (hex → `BigInt`) |
| Vote submission | burner wallet + `testClient.setBalance` + `vote(proof, pi0..pi3)` — the whole `VoteWithBurnerHardhat` machinery moves *into* `evmAdapter.vote()` | plain `POST /vote` — no wallet, no gas, no burner |
| "Already voted" | `VoteCast` events for burner address | map HTTP 400 containing `NullifierHashAlreadyUsed`; also remember locally |
| Live updates (`watch:`) | wagmi event/block subscriptions | polling (3–5 s interval or SWR `refreshInterval`) |
| Errors | revert-string matching (existing table in `VoteWithBurnerHardhat.tsx`) | same substrings appear in error bodies via `wrapErr()` — reuse one shared `mapChainError()` |

### 4.2 Backend selection — the actual "plug"

- `scaffold.config.ts`: add `chainBackend: process.env.NEXT_PUBLIC_CHAIN_BACKEND ?? "hardhat"`
  (`"hardhat" | "custom"`) and `chainApiUrl: process.env.NEXT_PUBLIC_CHAIN_API_URL ?? "http://localhost:3001"`.
- `ChainProvider` instantiates the matching adapter once; `useChain()` exposes it.
- In `custom` mode: hide wallet UI (RainbowKit connect button, burner components, faucet), skip
  wagmi requirements. In `hardhat` mode: identical behavior to today.

**Definition of plug-and-play met:** switching backends = editing one env var + starting the other
chain (`yarn chain` + `yarn deploy` vs `make run` in `packages/blockchain`). No component edits.

### 4.3 Identity model — the one real product decision

Hardhat mode identifies voters by **wallet address** (`useAccount()`); the Go node uses an
**opaque `voter_id` string** (e.g. email) hashed to an address (`VoterIDToAddress`). These are both
"strings the admin allowlists", so the adapter interface takes `voterId: string` — but *where the
frontend gets it from* differs:

- **EVM adapter:** `voterId = connected wallet address` (unchanged).
- **REST adapter:** voter enters their registered ID (the same value the admin added — email/index
  number) in a small "Your voter ID" field, kept in localStorage. No wallet, no login server.

This matches your anonymous-credential story: the ID only gates *registration* (allowlist +
commitment); voting remains fully anonymous (proof only). Flag: if you later want verified
identity (e.g. email OTP), it slots in behind `getVoterId()` without touching anything else.

### 4.4 Component refactor inventory

| File | Change |
|---|---|
| `app/voting/page.tsx` | Replace event-history + tuple reads with `useVotingData()` / `useLeaves()`; delete slice/reverse logic |
| `_components/VotingStats.tsx` | Tuple indices → named fields; candidates/counts via hooks |
| `_components/CreateCommitment.tsx` | Keep commitment generation + voter-pass download **unchanged**; replace `writeContractAsync("register")` + receipt decoding with `adapter.register()`; scope storage by `electionId` from `useVotingData()` |
| `_components/GenerateProof.tsx` | Keep the entire proof pipeline (LeanIMT rebuild, circuit-index correction, sibling padding, Noir/UltraHonk) **unchanged** — it consumes `leaves: bigint[]` + `root`/`depth` from hooks instead of raw events |
| `_components/VoteWithBurnerHardhat.tsx` / `Sepolia.tsx` | Logic moves into `evmAdapter.vote()`; components collapse into one `<CastVoteButton>` that calls `adapter.vote()` |
| `app/voting/admin/page.tsx` | All 7 `writeContractAsync` calls → adapter admin methods; owner check: `useIsVotingOwner()` (EVM) vs admin-session check (REST, via the §3.5 proxy) |
| `_components/AddVotersModal.tsx`, `ShowVotersButton.tsx` | Address inputs → generic voter-ID inputs (validation differs per backend) |
| `app/blockexplorer/*` | Hardhat mode only (it's RPC-based). Optional Phase 4: a minimal `/chain-explorer` page over `GET /blocks` |
| `app/api/circuit/route.ts` | Unchanged — circuit serving stays in Next.js for both backends |

Proof generation, poseidon hashing, voter-pass files, and `proofStorage.ts` are backend-agnostic
already — **zero crypto changes needed**. That part of your design was right.

---

## 5. Contract & circuit evolvability — correcting the premise

Your concern was that Hardhat "has no resistance" to contract/circuit changes. It's the opposite:

- **Hardhat/scaffold-eth**: `yarn deploy` regenerates `deployedContracts.ts` (ABI + address);
  `useScaffoldReadContract("newFunction")` just works. Only components referencing changed
  functions need edits.
- **Go node**: a contract change touches **six hardcoded places**: `assets/*.json` artifacts,
  typed methods in `bridge.go`, tx types in `core/types.go`, the replay switch in `replay.go`,
  handlers/routes in `server.go`, and `API.md` (+ integration test). The multi-candidate rewrite
  already demonstrated this — the Go side silently ran a stale contract until the 2026-07-01
  alignment pass.

A **circuit** change is symmetric for both stacks: recompile circuit → regenerate `Verifier.sol` →
recompile contracts → (custom chain only) recopy artifacts → replace `public/circuits.json`. The
frontend's fixed constants (16 siblings, 4 public inputs) live in `GenerateProof.tsx` and the
contract — same blast radius either way.

**Mitigations to include (don't over-engineer past these):**
1. `make sync-artifacts` in `packages/blockchain/Makefile`: runs `hardhat compile` and copies the 4
   artifact JSONs. One command kills the stale-artifact failure mode.
2. A `CONTRACT_CHANGE_CHECKLIST.md` in `packages/blockchain` enumerating the six touchpoints.
3. Startup guard: node logs the keccak hash of the deployed `Voting` runtime bytecode; the
   integration test asserts it matches the hardhat artifact — stale assets fail loudly.
4. Accept the typed bridge (it's what gives you decoded errors, caching, and pre-commit
   validation). Full ABI-generic dispatch would sacrifice those for generality you don't need.

The `ChainAdapter` interface (§4.1) is the evolvability seam for the *frontend*: new contract
features become new interface methods implemented twice, and no component knows which chain it's
talking to.

---

## 6. Execution plan (ordered, hand to Claude phase by phase)

### Phase 0 — Truth sync (small)
1. Rewrite `API.md` to match `server.go` as it will be after Phase 1 (paths, auth header, response
   shapes, error format). This becomes the frontend contract.
2. Add `make sync-artifacts` + `CONTRACT_CHANGE_CHECKLIST.md` (§5).

**Accept:** docs match implementation; `make sync-artifacts` produces byte-identical current assets.

### Phase 1 — Backend API fixes (`packages/blockchain`)
1. **TLS split** (§3.1): public listener without client-cert requirement (`API_TLS=false` plain
   HTTP default for dev); P2P endpoints moved to an mTLS-only listener on `P2P_PORT`.
2. **Hex encoding for field elements** (§3.2): `root` (and vote counts) as `0x…` strings; fix
   `run.mjs` to stop regex-parsing.
3. **`election_id` in `/voting-data`** via new `bridge.GetCurrentElectionId()` (§3.3).
4. **Clean write responses** (§3.4) for `/register`, `/vote`, and admin lifecycle endpoints.
5. **EVM time stamping** (§3.6): block-timestamp-driven `BlockContext.Time` for writes/replay,
   wall clock for reads; integration-test step proving a 2-second registration window auto-ends.
6. Flip fallback default: refuse to start without the EVM bridge unless `ALLOW_STORAGE_ONLY=true` (§3.8).
7. Update `server_test.go` + integration test for all of the above.

**Accept:** `go test ./...` green; `node integration-test/run.mjs` green over **plain HTTP** with
no client cert and no `bigField()` regex; `curl http://localhost:3001/voting-data` from a browser
shows hex root + election_id.

### Phase 2 — Frontend adapter layer, EVM implementation first (`packages/nextjs`)
1. Create `services/chain/` (§4.1): types, `ChainProvider`, hooks.
2. Implement `evmAdapter` by *moving* existing logic (event-history leaves, receipt decoding,
   burner-wallet vote) out of components into the adapter.
3. Refactor all components in §4.4 to consume the hooks. **No REST yet.**

**Accept:** with `NEXT_PUBLIC_CHAIN_BACKEND=hardhat`, the full flow (admin setup → register →
proof → burner vote → results) behaves exactly as today against `yarn chain`.

### Phase 3 — REST adapter + admin proxy
1. Implement `restAdapter` against the Phase 1 API (fetch + polling, shared `mapChainError()`).
2. Admin signing proxy: `app/api/admin/[action]/route.ts` holding `ADMIN_PRIVATE_KEY_PEM`
   server-side, password-gated (§3.5); REST adapter's admin methods call the proxy.
3. Voter-ID input for custom mode (§4.3); hide wallet UI in custom mode.

**Accept:** with `NEXT_PUBLIC_CHAIN_BACKEND=custom` and the Go node running (`REQUIRE_EVM`
enforced), the complete election lifecycle works in the browser with **no MetaMask, no burner, no
gas**; a second vote attempt shows the friendly "already voted" message; voter pass survives a
node restart and still proves/votes correctly.

### Phase 4 — Polish & dual-mode verification
1. Block-explorer-lite page over `GET /blocks` (+ pagination) for custom mode; keep the existing
   explorer for hardhat mode.
2. Bytecode-hash startup guard (§5.3).
3. A README section: "Switching chains" — the two-line env change + start commands.
4. Run both modes end-to-end back-to-back as the final gate; ideally script the custom-mode e2e as
   a Playwright test reusing `run.mjs` proof code.

**Accept:** switching backends requires only editing `NEXT_PUBLIC_CHAIN_BACKEND` (+ URL) and
starting the corresponding chain — zero source edits. That is the plug-and-play criterion.

---

## 7. Risk notes

- **CORS**: single-origin allowlist already exists (`ALLOWED_ORIGIN`); the Next.js admin proxy
  calls the node server-to-server (no CORS). Browser calls go direct for public endpoints — keep
  `http://localhost:3000` default.
- **Do not** try to make the Go node speak Ethereum JSON-RPC to reuse wagmi unchanged. It looks
  like less work; it is dramatically more (tx signing, receipts, log bloom, subscriptions). The
  REST adapter is the right cut.
- LocalStorage keys currently embed the contract address (`deployedContractData.address`) — REST
  adapter should substitute a stable namespace like `custom:<chainApiUrl>` so passes don't collide.
