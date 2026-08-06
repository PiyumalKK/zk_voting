# M08 — hardhat-deploy integration + contract test suite on the node

Status: **done (2026-08-01)** · Depends: M06, M07 · Packages: `packages/blockchain`, `packages/hardhat`

> **Phase 2 result — `npx hardhat test --network custom` is 55/55 green.**
> The unmodified contract test suite passes against the Go node: 13
> `GNAndRegistry` + 5 `NicRegistry` + 37 `Voting`, in ~6 seconds. "Contract
> changes never touch Go code" (MASTER §1) is now demonstrated, not claimed.
>
> **The bug it found: `eth_estimateGas` under-reported for any call earning
> gas refunds.**
>
> `core.ExecutionResult.UsedGas` is reported *net of refunds* —
> `TransitionDb` applies `st.refundGas()` before computing it — but a
> transaction must be *funded* with the gross amount. EIP-3529 caps the
> refund at `gross/5`, so `gross <= 1.25 * net`, and the estimator returned
> `net * 1.1`. `Voting.resetElection()` clears an array, a string and three
> slots, landing on that cap exactly; ethers uses the estimate as the
> transaction's gas limit, so it ran out of gas. **Out-of-gas produces an
> empty revert**, so all seven failures presented as a bare
> `ProviderError: execution reverted` with no decodable custom error — a
> symptom pointing nowhere near gas estimation.
>
> Fixed by replacing the flat pad with a binary search (geth's and Hardhat's
> approach), since the refund cap is only one way a naive estimate falls
> short — the 63/64 rule for nested calls is another. Regression test
> `TestEstimateGasCoversStorageRefunds` measures a ratio of **1.250**,
> matching the derived worst case, and asserts that a transaction funded with
> *exactly* the estimate succeeds.
>
> M03's note that "nothing in this app depends on a tight estimate" was the
> wrong framing: nothing depends on it being tight, everything depends on it
> being **sufficient**.
>
> **Everything else passed first time**, including all 18
> `revertedWithCustomError` assertions — so revert data reaches ethers and
> hardhat-chai-matchers decodes custom error names correctly, the risk
> flagged before the run.

> **Phase 1 result — `yarn deploy --network custom` is green.** All 9 contracts
> deployed, `deployedContracts.ts` holds `9494` and `31337` side by side with 9
> contracts each, and `deployments/{localhost,custom}/` both exist.
>
> **The headline evidence is the gas figures: every one is byte-identical
> between `hardhat node` and the Go node.**
>
> | Contract | Hardhat | Custom |
> |---|---|---|
> | PoseidonT3 | 3,695,091 | 3,695,091 |
> | LeanIMT | 1,028,221 | 1,028,221 |
> | HonkVerifier | 4,726,613 | 4,726,613 |
> | Voting | 1,992,910 | 1,992,910 |
> | ElectionRegistry | 3,392,544 | 3,392,544 |
> | NicRegistry | 337,595 | 337,595 |
> | Voting_{Kaduwela,Colombo,Gampaha} | 2,086,320 each | 2,086,320 each |
>
> Gas consumption is a function of every opcode executed and every storage slot
> touched. Identical totals across nine contracts — including the 4.7M-gas
> HonkVerifier — means the two EVMs took the same path instruction for
> instruction. Deployed addresses match too, confirming identical
> nonce/CREATE-address derivation.
>
> **Not yet proven:** `ElectionRegistry.createDivision()`, which does
> `new Voting(...)` — a contract deploying another contract from inside a
> transaction (ElectionRegistry.sol:59). MASTER §1 names this as the reason a
> generic EVM is mandatory, but neither the deploy scripts nor the test suite
> call it: `01_deploy_divisions.ts` deploys each division with hardhat-deploy
> and then registers it. The path is currently exercised only by the web admin
> UI, so it will first run against this node in M11/M12. Worth covering
> earlier — see phase 2 notes.

> Split into two phases (user-approved 2026-08-01): deliverables 1-5 and the
> `yarn deploy --network custom` gate first, then `npx hardhat test --network
> custom`. Gate steps: `RUNNING-GATES.md` §5.
>
> **Decisions taken during implementation:**
> - **`evmVersion: "cancun"` is deferred, not applied — and is now known to be
>   unnecessary.** MASTER §3 worried that "solc 0.8.30 may target the `prague`
>   EVM" and that geth might not support it. `yarn compile` settles it
>   empirically: it reports **`evm target: paris`**. Hardhat pins `paris` by
>   default for solc ≥ 0.8.20 rather than following the compiler's own
>   default, so the emitted bytecode is three forks *below* Cancun and well
>   below the Prague this chain activates. There is no opcode this node cannot
>   execute, and pinning `cancun` would be a no-op change that nonetheless
>   rewrote every contract's bytecode. Revisit only if a future Hardhat or
>   solc bump changes that target line.
> - **Test isolation is by `make reset`, not by touching the suite.** Our chain
>   persists where Hardhat's is fresh per run, so a fresh chain is a documented
>   precondition of the gate (MASTER §6 rule 3 forbids adapting the tests).
> - **Deploy order matters and is now a gate step.** See below.
>
> **Two problems found and fixed that the spec did not anticipate:**
> 1. `runHardhatDeployWithPK.ts` skipped its encrypted-key prompt only for
>    `localhost`/`hardhat`, so `yarn deploy --network custom` would have
>    stopped with "You don't have a deployer account". The check is now a
>    named `LOCAL_NETWORKS` set including `custom`; real networks unchanged.
> 2. Deliverable 3's assumption ("likely already correct") is **false in this
>    repo's current state**. `deployedContracts.ts` is committed but generated
>    from the gitignored `deployments/`, which is empty — so a custom-first
>    deploy would emit a `9494`-only file and drop the committed `31337`
>    entry. `generateTsAbis` does iterate every chain folder correctly; the
>    problem is purely that the localhost folder is absent. Resolved by
>    requiring a localhost deploy first (RUNNING-GATES §5.1) rather than by
>    modifying the generator.

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
