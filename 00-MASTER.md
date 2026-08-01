# Custom Blockchain v2 — Master Implementation Plan

> **Audience:** the implementing AI agent (Sonnet 5) and its subagents. Read this file fully
> before any milestone. Each milestone file (M01–M14) is self-contained; this file holds the
> shared context, rules, and reference tables.
> **Author:** planning pass 2026-07-29. Supersedes `packages/blockchain/PLAN.md` and
> `docs/CUSTOM_CHAIN_SWAP_PLAN.md` (both describe the obsolete v1 REST/typed-bridge node).

---

## 1. Mission

Rebuild `packages/blockchain` as a **generic, production-ready, permissioned EVM chain that
speaks the Ethereum JSON-RPC subset this app uses**, so that:

1. **Contract changes never touch Go code.** Contracts are deployed with the same
   `hardhat-deploy` scripts, pointed at the Go node's RPC. The node knows nothing about
   `Voting.sol`, `ElectionRegistry.sol`, `NicRegistry.sol`, or `HonkVerifier.sol` — it just
   executes EVM bytecode. This is mandatory: `ElectionRegistry.createDivision()` deploys new
   `Voting` contracts at runtime; only a generic EVM can support that.
2. **Swapping Hardhat ⇄ custom chain is an env-var change only.** No source edits in
   `nextjs`, `mobile`, or `hardhat` when switching. Both directions, repeatably.
3. **The problems that motivated the custom chain are solved:**
   - *Gas fees:* the node accepts `gasPrice = 0` transactions (free-gas policy). Burner
     wallets need no funding; no paymaster/relayer needed for voters.
   - *Wallet connections:* in custom-chain mode, admin and GN officers log in with
     credentials (no MetaMask); a server-side relay signs their transactions. Voters already
     use invisible in-app keys (mobile keystore + burners) — unchanged. See `01-AUTH-DESIGN.md`.
   - *Hardhat is a dev tool:* v2 adds durable storage, restart recovery, replication across
     3 nodes, and an independent audit-replay tool — a defensible "blockchain" story.

**Locked decisions (user-approved 2026-07-29):**

| Decision | Choice |
|---|---|
| Architecture | Generic EVM node + Ethereum JSON-RPC (not REST/typed bridge) |
| Old v1 code | Rewrite in place in `packages/blockchain`; salvage where useful; delete the rest |
| Topology | 3 nodes: 1 sequencer (primary) + 2 read replicas (count is config, not code) |
| No-wallet auth | **Custom-chain mode only.** Hardhat mode keeps MetaMask exactly as today |

---

## 2. Context snapshot (verified 2026-07-29)

The app is a multi-division Sri Lankan election system. Everything already speaks JSON-RPC:

| Consumer | How it talks to the chain | Key files |
|---|---|---|
| Mobile voter app (Expo) | viem `publicClient` + hand-built **legacy** raw txs (`eth_getTransactionCount`, `eth_gasPrice`, `eth_sendRawTransaction`, `eth_getTransactionReceipt`) | `packages/mobile/src/services/chain.ts`, `config.ts` |
| Next.js API routes (serve mobile + observers) | server-side viem reads: `readContract` (`eth_call`), `getLogs` | `packages/nextjs/app/api/{election,merkle-path,verify-vote}/route.ts` |
| Dev faucet | plain ETH transfer signed with Hardhat account #0 | `packages/nextjs/app/api/faucet/route.ts` |
| Web admin + GN portal | wagmi/viem `walletClient.writeContract` via MetaMask | `app/voting/admin/page.tsx`, `app/gn/**`, `hooks/useDivisions.ts` |
| Audit / results pages | viem `getLogs` + `readContract` | `app/audit/page.tsx`, `app/results/page.tsx` |
| Deployment | `hardhat-deploy` (`yarn deploy`), regenerates `contracts/deployedContracts.ts` via `scripts/generateTsAbis.ts` | `packages/hardhat/deploy/00_*.ts`, `01_deploy_divisions.ts` |
| Block explorer | scaffold-eth explorer over RPC | `app/blockexplorer/**` |

**Obsolete v1 leftovers** (from the July REST-node era; removal inventory in M11):
`packages/blockchain/*` (v1 node), `packages/nextjs/services/chain/` (REST seam),
`app/api/admin/[action]/route.ts` (RSA-signing proxy), `app/chain-explorer/` (REST explorer),
`packages/evm-sandbox/` (scratch experiment).

**Facts the plan depends on** (re-verify if contracts changed):
- `HonkVerifier` deployed bytecode = **21,635 bytes** → under the 24,576 EIP-170 limit. Guarded by a test in M08.
- Solidity **0.8.30**, optimizer on; hardhat tests use `evm_increaseTime` / `evm_mine` (no `loadFixture`).
- Vote tx gas: mobile uses fixed **15,000,000** limit → block gas limit must exceed it.
- Hardhat test accounts = default mnemonic `test test ... junk` (20 accounts); deploy scripts use signers #0–#3.

---

## 3. Architecture

```
                    ┌──────────────────────── packages/blockchain (Go) ────────────────────────┐
 viem / wagmi /     │  JSON-RPC server (eth_, net_, web3_, evm_, hardhat_)   [internal/rpc]    │
 hardhat-deploy ───▶│        │                                                                 │
 (HTTP :9545)       │  Sequencer: validate tx → execute in EVM → seal 1-tx block → persist     │
                    │        │                                  [internal/chain]               │
                    │  go-ethereum: vm.EVM, state.StateDB, types.*   [internal/state]          │
                    │        │                                                                 │
                    │  Pebble KV via geth rawdb: blocks, receipts, tx-lookup, state trie       │
                    │        │                                  [internal/storage]             │
                    │  P2P (mTLS, :9546): primary pushes sealed blocks → replicas re-execute,  │
                    │  verify state root, serve read RPC, forward writes     [internal/p2p]    │
                    └──────────────────────────────────────────────────────────────────────────┘
```

Core properties:

- **Auto-mine, one tx per block** (Hardhat-like). A tx that reverts is **not mined**; the RPC
  returns an execution-revert error carrying the revert `data` so viem decodes custom errors
  (`Voting__NullifierHashAlreadyUsed`, …) exactly as with Hardhat.
- **Free gas:** `eth_gasPrice`/`eth_maxPriorityFeePerGas` → `0x0`; base fee 0; txs with
  `gasPrice = 0` cost nothing, so zero-balance burners can vote. Nonces still enforced.
- **Genesis prefunds** the 20 Hardhat mnemonic accounts (10,000 ETH each) → `yarn deploy`
  and the dev faucet work unchanged.
- **Deterministic, auditable history:** state is a pure function of the block list. The
  `audit` tool replays from genesis and verifies every state root (M09).
- **Single sequencer ⇒ no forks.** Replicas are trust-but-verify followers: they re-execute
  every block and refuse any block whose state root doesn't match (M10).
- **Chain ID 9494** (distinct from Hardhat's 31337 so `deployedContracts.ts` can hold both
  deployments side-by-side; configurable via env).

Go module: keep `zk-blockchain`, Go ≥ 1.25. **Upgrade `go-ethereum` to current stable v1.16.x**
(M01): solc 0.8.30 may target the `prague` EVM; geth v1.13 lacks Prague. Belt-and-braces:
M08 also pins `evmVersion: "cancun"` in `hardhat.config.ts`.

Salvage guide (v1 → v2): `internal/security/tls.go` (mTLS) → `internal/p2p`; concepts from
`internal/evm/vm.go` (EVM construction) → `internal/state`; everything else (REST server,
794-line typed bridge, custom tx types, replay switch, BoltDB store) is deleted in M01.

---

## 4. Target repository layout

```
packages/blockchain/
├── cmd/node/main.go            # wiring: config → storage → chain → rpc → p2p
├── cmd/audit/main.go           # replay-verify CLI (M09)
├── internal/config/            # env parsing, validation (M01)
├── internal/storage/           # pebble + geth rawdb open/close (M02); read-only open
│                               #   + copy-on-write replay overlay for the auditor (M09)
├── internal/state/             # genesis, StateDB lifecycle, chain config (M02)
├── internal/chain/             # sequencer: tx validation, execution, sealing, reorg-free head mgmt (M03)
├── internal/rpc/               # JSON-RPC services + HTTP server + CORS (M04–M07)
├── internal/p2p/               # mTLS block push/pull, replica verification (M10)
├── e2e/                        # Node.js full-election e2e incl. real ZK proof (M14)
├── Makefile                    # build, test, run, run-cluster, reset, gen-certs
├── RPC.md                      # implemented method matrix (kept current from M04 on)
└── README.md                   # ops runbook (M14)
```

---

## 5. Milestones

Execute strictly in order; each has its own file with spec + acceptance gates.

| # | File | Title | Depends | Status |
|---|---|---|---|---|
| M01 | `M01-skeleton.md` | Teardown, module layout, config, logging, health | — | **done** |
| M02 | `M02-state-genesis.md` | Pebble/rawdb storage, chain config, genesis + prefunds | M01 | **done** |
| M03 | `M03-execution.md` | Tx validation, EVM execution, block sealing, receipts | M02 | **done** |
| M04 | `M04-rpc-read.md` | JSON-RPC server + read methods | M03 | **done** |
| M05 | `M05-rpc-write.md` | `eth_sendRawTransaction` + tx/receipt queries + revert errors | M04 | code complete, gates pending |
| M06 | `M06-logs.md` | `eth_getLogs` (address/topics/range filters) | M05 | code complete, gates pending |
| M07 | `M07-dev-methods.md` | `evm_increaseTime/mine`, `*_setBalance`, clientVersion compat | M05 | **done** |
| M08 | `M08-deploy-integration.md` | `yarn deploy --network custom`; hardhat test suite green on node | M06, M07 | **done** |
| M09 | `M09-persistence-audit.md` | Restart recovery + `cmd/audit` replay verification | M08 | **done** |
| M10 | `M10-replication.md` | Primary + 2 replicas over mTLS; write forwarding | M09 | pending |
| M11 | `M11-frontend-switch.md` | Next.js env plumbing; v1 leftovers deleted; read paths green | M08 | pending |
| M12 | `M12-no-wallet-auth.md` | Login + server relay for admin/GN (custom mode only) | M11 | pending |
| M13 | `M13-mobile.md` | Mobile app on custom chain (env only), gasless vote | M11 (full flow also needs M12's GN portal) | pending |
| M14 | `M14-e2e-swap.md` | Full e2e suite, swap drill, docs, final dual-mode gate | M09–M13 | pending |
M10 can run in parallel with M11–M13 (different packages).

---

## 6. Agent operating rules

1. **One milestone at a time.** Do not start Mn+1 until Mn's acceptance gate passes. Run the
   gate commands literally; paste outputs into the commit message body.
2. **Definition of done** per milestone: code + tests written, `go vet ./...` and
   `gofmt -l .` clean, `go test ./...` green, gate commands green, `RPC.md` updated if RPC
   surface changed, milestone status flipped in §5 table (edit this file).
3. **Do not touch:** `packages/circuits/`, `packages/hardhat/contracts/` (except the single
   `evmVersion` pin in M08), the proof pipeline (`packages/nextjs/app/prover`,
   `packages/mobile/src/services/*prover*`, `zkproof.ts`), deploy script logic. The chain
   adapts to the app — never the reverse.
4. **Hardhat-mode regression rule:** after every Next.js/mobile change, hardhat mode must
   still work (`yarn chain` + `yarn deploy` + admin page with MetaMask). M11/M12/M13 gates
   include this explicitly.
5. **Testing style:** Go table-driven unit tests beside the code; cross-implementation
   parity is proven by *differential tests* — run the same viem calls against `hardhat node`
   and against our node, diff the responses (harness built in M04, reused after).
6. **Commits:** one commit per milestone minimum, message `blockchain-v2(Mnn): <summary>`.
7. **When blocked** (dependency API mismatch, ambiguous behavior): prefer *empirical* answers —
   run `hardhat node`, issue the RPC call with `curl`, copy the observed shape. Only ask the
   human for product decisions, not for Ethereum semantics.
8. **Security defaults:** no secrets in git; new env vars documented in §7 and in
   `.env.example` files; dev-only RPC methods gated behind `DEV_RPC=true`.

---

## 7. Environment variable reference

**Go node** (all optional with defaults):

| Var | Default | Meaning |
|---|---|---|
| `CHAIN_ID` | `9494` | EVM chain id |
| `RPC_PORT` | `9545` | Public JSON-RPC HTTP port |
| `P2P_PORT` | `9546` | mTLS block-sync port (M10) |
| `DATA_DIR` | `./data` | Pebble database directory |
| `ROLE` | `primary` | `primary` \| `replica` |
| `PRIMARY_RPC_URL` | — | Replica only: where to forward `eth_sendRawTransaction` |
| `PEERS` | — | Primary: comma-separated replica push URLs `https://host:9546` |
| `REPLICA_PULL_URL` | — | Replica: primary's P2P base URL for catch-up sync |
| `BLOCK_GAS_LIMIT` | `60000000` | Must stay > 15M (vote tx) |
| `DEV_RPC` | `false` | Enables `evm_*`, `hardhat_setBalance`, `anvil_setBalance` |
| `CORS_ORIGINS` | `*` | RPC CORS allowlist |
| `RPC_RATE_LIMIT_RPS` | `100` | Per-IP token-bucket steady-state rate (req/s). Added in M04, not in the original table. |
| `RPC_RATE_LIMIT_BURST` | `200` | Per-IP token-bucket burst capacity. Added in M04, not in the original table. |
| `LOG_RANGE_LIMIT` | `100000` | Max blocks one `eth_getLogs` query may span (inclusive). DoS protection. Added in M06, not in the original table. |
| `CLIENT_VERSION_MODE` | `zkchain` | `zkchain` → `web3_clientVersion` reports `zkchain/v2.0.0`; `anvil` → `anvil/v1.0.0-zkchain`. Escape hatch for tooling that special-cases client identity (§10 pitfall 6). Added in M07, not in the original table. |
| `TLS_CERT` / `TLS_KEY` / `TLS_CA` | `./certs/…` | P2P mTLS material (M10; `make gen-certs`) |
| `LOG_LEVEL` | `info` | zerolog level |
| `LOG_FORMAT` | `console` | `console` (human-readable, dev) \| `json` (prod/replica log aggregation). Added in M01, not in the original table. |

**packages/hardhat:** `CUSTOM_RPC_URL` (default `http://127.0.0.1:9545`), `CUSTOM_CHAIN_ID` (default `9494`).

**packages/nextjs** (`.env.local`) — the swap switch:

| Var | Hardhat mode | Custom mode |
|---|---|---|
| `NEXT_PUBLIC_CHAIN_BACKEND` | `hardhat` (or unset) | `custom` |
| `NEXT_PUBLIC_CHAIN_ID` | `31337` | `9494` |
| `NEXT_PUBLIC_RPC_URL` / `RPC_URL` | `http://127.0.0.1:8545` | `http://127.0.0.1:9545` |
| `SESSION_SECRET` | — | 32+ byte random (M12) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` | — | bcrypt hash (M12) |
| `ADMIN_RELAY_PRIVATE_KEY` | — | key of the contracts' owner account (M12) |
| `GN_KEY_ENCRYPTION_KEY` | — | AES-256 key for GN keystore at rest (M12) |
| `FAUCET_CHAIN_IDS` | `31337` (implicit) | `31337,9494` — chains the dev faucet serves (M11) |

**packages/mobile:** `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_RPC_URL`, `EXPO_PUBLIC_CHAIN_ID` (already exist; values change per mode).

---

## 8. The swap procedure (target UX — verified in M14)

```
Hardhat → Custom:
  1. cd packages/blockchain && make run            # or make run-cluster for 3 nodes
  2. cd packages/hardhat && yarn deploy --network custom   # once, or after contract changes
  3. Set the "Custom mode" env column (§7) in nextjs/.env.local and mobile env; restart apps.
Custom → Hardhat:
  1. yarn chain && yarn deploy
  2. Restore the "Hardhat mode" env column; restart apps.
```

Zero source edits in either direction. `deployedContracts.ts` retains both chains' entries
(keyed 31337 / 9494), so switching does not require redeploying the *other* side.

---

## 9. JSON-RPC compatibility matrix

Methods the app provably uses (grep-verified) — all must behave Hardhat-identically:

| Method | Consumers | Milestone |
|---|---|---|
| `eth_chainId`, `net_version`, `web3_clientVersion` | viem/wagmi/hardhat startup | M04 |
| `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getBlockByHash` | explorer, viem receipts wait, audit timestamps | M04 |
| `eth_getBalance`, `eth_getCode`, `eth_getTransactionCount`, `eth_getStorageAt` | faucet, explorer, mobile nonce | M04 |
| `eth_call` | every `readContract` (election, divisions, merkle root, results) | M04 |
| `eth_estimateGas`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_feeHistory` | viem fee logic, hardhat-deploy, faucet | M04 |
| `eth_sendRawTransaction` | mobile register/vote, faucet, relay, hardhat-deploy | M05 |
| `eth_getTransactionByHash`, `eth_getTransactionReceipt` | all writers | M05 |
| `eth_getLogs` | audit page, verify-vote, merkle-path (NewLeaf), explorer | M06 |
| `eth_syncing`, `eth_accounts`, `net_listening` | tooling probes (trivial stubs) | M04 |
| `evm_increaseTime`, `evm_mine`, `evm_setNextBlockTimestamp` | hardhat test suite (M08 gate) | M07 |
| `hardhat_setBalance` / `anvil_setBalance` | parity/dev tooling | M07 |

Explicitly **not** implemented (document in `RPC.md`): WebSocket subscriptions
(`eth_subscribe`) — all consumers poll over HTTP; filter methods (`eth_newFilter` family) —
viem's `getLogs` path doesn't need them; `eth_snapshot`/`evm_snapshot` — no `loadFixture`
usage; tracing/debug namespaces.

---

## 10. Known pitfalls (read before M03–M08)

1. **Revert error shape:** viem decodes custom errors from the `data` field of the JSON-RPC
   error. Use code `3`, message `execution reverted`, `data: "0x<revert bytes>"`. Verify by
   diffing against `hardhat node` behavior for `Voting__WrongPhase` (differential harness).
2. **Reverting txs are rejected at submission** (Hardhat auto-mine behavior): return the
   revert error from `eth_sendRawTransaction` itself; do not mine the tx. Mobile/web error
   handling substring-matches custom error names — preserve that.
3. **Zero gas price + London active:** keep EIP-1559 fork enabled but force `baseFee = 0`
   in every header; accept legacy, 2930 and 1559 txs. Mobile sends **legacy** txs (Hermes
   workaround) — never break legacy support. ethers v6 (hardhat-deploy) may send 1559 txs
   with fees taken from `eth_feeHistory`/`eth_gasPrice` → zeros make cost 0.
4. **`eth_getTransactionCount` with `pending` tag:** map `pending`/`safe`/`finalized` →
   `latest` (no mempool exists; auto-mine means latest == pending).
5. **Receipt fields viem awaits:** `status`, `blockHash`, `blockNumber`, `transactionHash`,
   `transactionIndex`, `logs[]` (with `logIndex`, `blockNumber`, `address`, `topics`,
   `data`), `contractAddress` (creates), `effectiveGasPrice` (`0x0`), `type`, `gasUsed`,
   `cumulativeGasUsed`, `logsBloom`. Missing/malformed fields fail silently in odd places —
   copy shapes from a real Hardhat response (differential harness).
6. **`web3_clientVersion`:** some tooling special-cases Hardhat/Anvil. Report
   `anvil/v1.0.0-zkchain` only if empirically required (M07); otherwise `zkchain/v2.0.0`.
7. **Block timestamps must be strictly increasing** (`max(now + devOffset, parent+1)`) —
   `Voting.sol` phase deadlines depend on `block.timestamp`; replicas re-execute with the
   header's stored timestamp, keeping replay deterministic.
8. **EIP-170:** HonkVerifier fits (21,635 B) — add a deploy-time size assertion in M08 so a
   future verifier regeneration that exceeds 24,576 B fails loudly, not mysteriously.
9. **hardhat-deploy nonce/`from` handling:** it signs locally using the network `accounts`
   config (HD mnemonic) and only needs standard RPC. If it probes an unexpected method, log
   shows `method not found` — implement the stub, don't hack the deploy script.
10. **State must only mutate inside blocks.** Dev `setBalance` is recorded as a system-op
    block (header `extraData`), so audit replay and replicas stay consistent (M07 spec).

---

## 11. Related docs

- `01-AUTH-DESIGN.md` — roles, login, relay, key custody, voter identity & verification
  chain, threat model. **Read before M12; summarize in the FYP report.**
- `RUNNING-GATES.md` — how to run each milestone's acceptance gates locally
  (Go toolchain setup, terminals, expected output, troubleshooting). Every
  milestone agent so far has lacked a Go toolchain in-sandbox, so the gates
  are run by the human.
- `packages/blockchain/RPC.md` — living method reference (created in M04).
- `packages/blockchain/README.md` — ops runbook: restart recovery, the audit
  tool, measured audit throughput (started in M09, expanded in M14).
- Historical (do not follow): `packages/blockchain/{PLAN,API,BLOCKCHAIN_OVERVIEW}.md`,
  `docs/CUSTOM_CHAIN_SWAP_PLAN.md`, `MIGRATION.md` (pre-dates this plan).
