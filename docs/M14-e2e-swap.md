# M14 — E2E suite, swap drill, docs, final gate

Status: pending · Depends: M09, M10, M11, M12, M13 · Packages: all

## Goal
Automated whole-system proof + the operational story: one script demonstrates a complete
election on the custom chain including a real ZK proof; switching backends is drilled both
directions; docs are final.

## Deliverables
1. `packages/blockchain/e2e/election.mjs` — headless full election against a fresh node
   (no UI, viem + bb.js): deploy via `hardhat-deploy` programmatically or shell-out to
   `yarn deploy --network custom` → admin lifecycle via raw txs (owner key) → GN adds a
   voter key → register commitment → build Merkle path (reimport the merkle-path route's
   logic or call the running Next.js API) → **generate a real UltraHonk proof** (reuse the
   proof code path from `packages/nextjs/generate_prover_inputs.mjs` + bb.js as the WebView
   prover does) → vote from unfunded burner → assert vote count, nullifier used, double
   vote rejected → restart node → state intact → `make audit` OK.
   Wire as `make e2e` (starts node, runs, tears down).
2. Swap drill — perform and *time* both directions per MASTER §8; record results in
   README ("swap = N minutes, 0 source files changed"). Include the `deployedContracts.ts`
   dual-entry check.
3. Docs finalization:
   - `packages/blockchain/README.md`: quickstart, single-node + cluster ops, env table,
     backup/restore (`DATA_DIR` copy while stopped), cert rotation, audit runbook,
     troubleshooting matrix (symptom → likely milestone spec section).
   - Root `README.md`: replace the old "Switching Chain Backends" section (MASTER §8 content).
   - `TODO.md`: mark solved items (custom L2/permissioned chain ✅ scoped, admin MetaMask
     removal ✅ custom mode, burner gas ✅ free-gas) with one-line pointers to this plan.
   - Delete now-superseded docs listed in MASTER §11 "historical" (keep
     `docs/CUSTOM_CHAIN_SWAP_PLAN.md` — mark SUPERSEDED at top instead of deleting; it is
     referenced by the FYP report).
4. Optional (do only if all gates green early): GitHub Actions job — `go vet + go test` on
   `packages/blockchain`, plus `hardhat test --network custom` against a node service.

## Final acceptance gate — run every item, record output
```
1. cd packages/blockchain && make reset && make e2e            # full election PASS
2. make run-cluster && node e2e/cluster-test.mjs               # replication PASS
3. Hardhat mode end-to-end manual: yarn chain + deploy → admin (MetaMask) → mobile register/vote
4. Custom mode end-to-end manual: make run + deploy custom → admin (password) → mobile register/vote
5. Swap drill hardhat→custom→hardhat: only env files changed (git status clean)
6. go test ./... ; hardhat test (both networks); yarn next build — all green
```
When all six pass, flip every milestone to `done` in `00-MASTER.md` §5 and write a short
`docs/blockchain-v2/RESULT.md`: measured audit speed, vote tx latency, proof time on the
node, swap time — numbers for the FYP report.
