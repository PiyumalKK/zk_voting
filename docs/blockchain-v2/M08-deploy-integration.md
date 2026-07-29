# M08 — hardhat-deploy integration + contract test suite on the node

Status: pending · Depends: M06, M07 · Packages: `packages/blockchain`, `packages/hardhat`

## Goal
The flagship EVM-compat gate: the unmodified deploy scripts and the whole Hardhat contract
test suite run **against our node**. After this, "contract changes never touch Go" is proven,
not claimed.

## Deliverables
1. `packages/hardhat/hardhat.config.ts` — two edits only:
   - network `custom`:
     ```ts
     custom: {
       url: process.env.CUSTOM_RPC_URL || "http://127.0.0.1:9545",
       chainId: Number(process.env.CUSTOM_CHAIN_ID || 9494),
       accounts: { mnemonic: "test test test test test test test test test test test junk" },
     },
     ```
     (HD mnemonic → all 20 signers exist; deploy scripts use signers #0–#3.)
   - `solidity.settings.evmVersion: "cancun"` pinned explicitly (MASTER §3 rationale).
     Recompile; confirm hardhat-mode tests still pass after the pin.
2. Verify `scripts/runHardhatDeployWithPK.ts` forwards `--network custom` (yarn
   `deploy --network custom`); fix arg passthrough if it doesn't — behavior for the default
   network must not change.
3. Confirm `scripts/generateTsAbis.ts` emits a `9494` entry into
   `packages/nextjs/contracts/deployedContracts.ts` alongside `31337`. If it only emits the
   deployed network, verify switching back and forth preserves both entries (hardhat-deploy
   keeps per-network folders in `deployments/` — likely already correct; prove it).
4. `packages/hardhat/deployments/custom/` added to `.gitignore` (local chain data-dependent).
5. Node-side guard: in `e2e/smoke-deploy.mjs` (from M05) add an assertion that every
   deployed contract's code size ≤ 24,576 bytes and specifically log HonkVerifier's size
   (MASTER §10.8).

## Acceptance gate (run in order, paste outputs in commit)
```
cd packages/blockchain && make reset && make run &          # fresh chain, DEV_RPC=true
cd packages/hardhat
yarn deploy --network custom                                 # 00_* and 01_* both green:
                                                             # registry + 3 divisions deployed
npx hardhat test --network custom                            # ALL tests green (49 at last count)
git diff --stat packages/nextjs/contracts/deployedContracts.ts  # shows 9494 entries added
# regression: yarn chain & yarn deploy & yarn test           # hardhat mode still green
```
Troubleshooting order when a test fails: (1) diff the failing RPC exchange against
`hardhat node` with the M04 harness; (2) check revert-error text expectations; (3) check
`evm_increaseTime` interaction with monotonic timestamps; (4) only then consider a spec bug.
The **node** gets fixed, never the tests/contracts.
