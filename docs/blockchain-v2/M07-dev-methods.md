# M07 — Dev/compat methods

Status: pending · Depends: M05 · Package: `packages/blockchain`

## Goal
The small set of non-standard methods needed for (a) the Hardhat contract test suite to run
against the node (M08 gate) and (b) faucet/tooling parity. All gated behind `DEV_RPC=true`
**except where noted**; when disabled they return method-not-found.

## Deliverables — `internal/rpc/dev.go`
1. `evm_increaseTime(seconds)` — adds to the sequencer's `devOffset` (affects every later
   block's timestamp; MASTER §10.7). Returns the offset (mirror Hardhat's return).
2. `evm_setNextBlockTimestamp(ts)` — pins the next block's time (then falls back to offset
   logic).
3. `evm_mine()` — seal an empty block via `Sequencer.MineEmptyBlock`.
4. `hardhat_setBalance(addr, hexBalance)` + alias `anvil_setBalance`.
   **State may only change inside blocks** (MASTER §10.10): implement as a *system-op
   block* — an empty block whose header `extraData` = `sysop:setBalance:<addr>:<hex>`;
   the sequencer applies the op during sealing. Replicas and the M09 audit tool parse
   `extraData` and apply the same op when re-executing, keeping state roots reproducible.
5. `web3_clientVersion` compat check: run `npx hardhat test --network custom` (see M08)
   once; if `@nomicfoundation/hardhat-network-helpers` or any plugin refuses the node,
   switch the reported string to `anvil/v1.0.0-zkchain` (env `CLIENT_VERSION_MODE=anvil`).
   Current evidence (grep): tests call `evm_increaseTime`/`evm_mine` directly via
   `ethers.provider.send`, no `loadFixture` — so the plain string should work. Verify.
6. **Not implemented** (return method-not-found, document in RPC.md): `evm_snapshot`/
   `evm_revert` (nothing uses them), `hardhat_impersonateAccount`, `debug_*`, `trace_*`.

## Tests
- Go: increaseTime affects next block timestamp; setNextBlockTimestamp exact; mine advances
  height with 0 txs; setBalance visible via `eth_getBalance` and encoded in `extraData`;
  all methods 404 when `DEV_RPC=false`.
- Determinism: build a chain containing sysop blocks, close, replay all blocks against a
  fresh StateDB (test-local replay — precursor of M09) ⇒ identical final state root.

## Acceptance gate
```
cd packages/blockchain && make test
DEV_RPC=true make run &
curl -s -X POST localhost:9545 -d '{"jsonrpc":"2.0","id":1,"method":"evm_increaseTime","params":[3600]}' -H 'content-type: application/json'
curl -s -X POST localhost:9545 -d '{"jsonrpc":"2.0","id":1,"method":"hardhat_setBalance","params":["0x000000000000000000000000000000000000dEaD","0xDE0B6B3A7640000"]}' -H 'content-type: application/json'
# eth_getBalance(dead) → 0xde0b6b3a7640000
```
