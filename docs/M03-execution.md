# M03 — Sequencer: tx validation, EVM execution, block sealing

Status: pending · Depends: M02 · Package: `packages/blockchain`

## Goal
The heart of the node: accept a signed transaction, execute it in the EVM against current
state, seal exactly one block, persist block + receipts + state atomically. Auto-mine,
no mempool, no forks. Also: read-only call/estimate execution for RPC (M04/M05 just wrap this).

## Deliverables — `internal/chain/`
1. `sequencer.go` — `type Sequencer struct` owning: db, chain config, current head,
   `sync.Mutex` (single writer), dev time-offset (M07 uses it).
   - `func (s *Sequencer) SubmitTx(tx *types.Transaction) (*types.Receipt, error)`
   - `func (s *Sequencer) Call(msg CallMsg, blockNr rpc.BlockNumber) ([]byte, error)` — run
     on a throwaway StateDB copy; return revert data in a typed `RevertError{Data []byte}`.
   - `func (s *Sequencer) EstimateGas(msg CallMsg) (uint64, error)` — binary search like geth,
     or simply execute once with block gas limit and return `gasUsed * 1.1` (document choice;
     simple version is fine — nothing in the app depends on tight estimates).
   - `func (s *Sequencer) MineEmptyBlock() (*types.Block, error)` (used by `evm_mine`, M07).
2. `validate.go` — stateless + stateful checks, each with a typed error mapping to the exact
   Hardhat message (differential-verified in M05): decode (legacy/2930/1559 accepted),
   `types.Sender` with `LatestSignerForChainID(chainID)` (wrong chain id ⇒ error), nonce ==
   `state.GetNonce(sender)` (`Nonce too low` / `Nonce too high`), `tx.Gas() <= BlockGasLimit`,
   balance ≥ `value + gasPrice*gas` (with gasPrice 0 this only bites value transfers),
   intrinsic gas check.
3. `execute.go` — build `vm.BlockContext` (Coinbase zero, `BaseFee: 0`, `Random: zero-hash`
   (post-merge PREVRANDAO), `Time/Number` from the header being built, CanTransfer/Transfer
   std, `GetHash` closure reading rawdb) → `core.ApplyMessage` with `vm.Config{}` → produce
   receipt (status, gasUsed, logs with correct `logIndex/txIndex/blockNumber`, bloom,
   `contractAddress` when `to == nil`).
4. `seal.go` — header: `ParentHash`, `Number`, `Time = max(unix_now + devOffset,
   parent.Time + 1)`, `GasLimit = cfg.BlockGasLimit`, `GasUsed`, `BaseFee = 0`,
   `Difficulty = 0`, `MixDigest = zero`, roots (`TxHash`, `ReceiptHash` via
   `types.DeriveSha`, `Root` from `statedb.Commit`, empty `UncleHash`, `Bloom`).
   Persist atomically via rawdb batch: `WriteBlock`, `WriteReceipts`, `WriteCanonicalHash`,
   `WriteHeadBlockHash`/`WriteHeadHeaderHash`, `WriteTxLookupEntries`, then commit triedb.
   Publish a `NewBlockEvent` on an internal channel (M10 subscribes).
5. **Revert policy (critical, MASTER §10.2):** if execution reverts or errors, roll back —
   *no block is produced* — and return `RevertError` with the revert bytes to the caller.

## Spec notes
- One tx per block keeps receipts trivial (`transactionIndex = 0`, `cumulativeGasUsed =
  gasUsed`) and makes the audit story crisp. Do not batch.
- Free gas: when `gasPrice == 0` skip fee deduction entirely (ApplyMessage handles this
  naturally with zero prices — verify no `insufficient funds for gas` path triggers for a
  0-balance sender sending a 0-value, 0-gasPrice tx).
- Head + StateDB root cached in memory; every write goes through the one mutex.

## Tests (go test, table-driven; use small hand-assembled contracts, not the voting ones)
- Deploy (init code) → address correctness, code stored, receipt `contractAddress`.
- Counter contract: write tx increments; `Call` reads back; state persists across reopen.
- Revert with custom error ⇒ no new block, `RevertError.Data` carries the selector.
- Nonce too low/high; wrong chain id; gas cap exceeded.
- 0-balance sender + gasPrice 0 succeeds; value transfer from 0-balance fails.
- Timestamps strictly increase across rapid txs.
- Logs: emit 3 events in one tx ⇒ logIndex 0..2, bloom contains address+topics.

## Acceptance gate
```
cd packages/blockchain && make vet && make test
# coverage sanity: go test ./internal/chain/ -cover   → aim ≥ 80% for this package
```
