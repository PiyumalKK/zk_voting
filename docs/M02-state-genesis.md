# M02 — Storage, chain config, genesis + prefunds

Status: pending · Depends: M01 · Package: `packages/blockchain`

## Goal
Durable geth-native storage (Pebble via `rawdb`) and a deterministic genesis block that
prefunds the 20 Hardhat test accounts. After this milestone the node has a persistent,
reopenable chain of height 0.

## Deliverables
1. `internal/storage/storage.go`
   - `Open(dataDir string) (ethdb.Database, error)` using `rawdb.Open` /
     `rawdb.NewPebbleDBDatabase` (adapt to the v1.16 API — check the geth source in
     `$GOMODCACHE`, don't guess).
   - Clean `Close()`; single-process lock (Pebble provides this — surface a friendly error
     if the dir is already locked).
2. `internal/state/chainconfig.go`
   - `func ChainConfig(chainID uint64) *params.ChainConfig`: all forks active from block 0
     **through Cancun and Prague** (`Shanghai/Cancun/PragueTime = 0`), merge fields set
     (`TerminalTotalDifficulty: 0`). No clique/ethash — we seal blocks ourselves.
3. `internal/state/genesis.go`
   - Hardcoded slice of the 20 Hardhat mnemonic addresses (derive once with
     `node -e` + viem or `cast wallet`, paste, and add a comment with the mnemonic).
     Balance: 10,000 ETH each.
   - `func EnsureGenesis(db ethdb.Database, cfg *Config) (*types.Block, error)`:
     build `core.Genesis{Config, Alloc, GasLimit: cfg.BlockGasLimit, BaseFee: big0,
     Timestamp: 0, ExtraData: []byte("zkchain-genesis")}` and commit via genesis.Commit
     (writes block 0, head pointers, state root). If the DB already has a genesis: verify
     hash matches (mismatch = config drift → fatal error telling the user to `make reset`).
4. `internal/state/statedb.go`
   - `func At(db ethdb.Database, root common.Hash) (*state.StateDB, error)` — StateDB opened
     at a given root (used by reads, execution, replay). Wrap the v1.16 triedb/state API here
     so the rest of the code never imports geth state packages directly.
5. Wire into `cmd/node`: open storage → ensure genesis → log
   `genesis hash=… chainId=… height=…`; `/health` now reports real height.

## Spec notes
- Base fee is **0 at genesis and forever** (M03 keeps it 0 in every header) — this is the
  free-gas foundation; do not use `misc.CalcBaseFee`.
- Everything deterministic: same config ⇒ same genesis hash on every machine. Add the
  genesis hash to the M02 commit message; e2e (M14) asserts it.

## Tests
- Genesis determinism: two fresh temp dirs ⇒ identical genesis hash.
- Reopen: create → close → open ⇒ same head, balances intact
  (`statedb.GetBalance(hardhat[0]) == 10000e18`).
- Config-drift detection: reopen with different `CHAIN_ID` ⇒ error.

## Acceptance gate
```
cd packages/blockchain && make test
make run &  # log shows genesis hash + height 0
curl -s localhost:9545/health   # height 0, then restart → same genesis hash logged
make reset && make run &        # re-creates identical genesis hash
```
