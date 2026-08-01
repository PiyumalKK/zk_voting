# M09 — Restart recovery + audit replay tool

Status: **done** (gates passed 2026-08-01) · Depends: M08 · Package: `packages/blockchain`

## Gate results (2026-08-01)

Run against the data directory M08's gate left behind — the real Voting
stack, three runtime-deployed division contracts, and `yarn test:custom`'s
55 passing tests.

```
make vet / make fmt / make test          all clean, all tests passing

bin\zk-blockchain-audit.exe -data-dir data
  AUDIT OK height=787 stateRoot=0x8ce1fd46…f219
  blocks=787 txs=774 gas=1410021337 elapsed=419ms (1878.5 blocks/s)

bin\zk-blockchain-audit.exe -data-dir data -from 400     (incremental)
  AUDIT OK height=787 blocks=388 txs=386 gas=694536781 elapsed=139ms

bin\zk-blockchain-audit.exe -data-dir data -json         ok:true, 3242 blocks/s

make run-dev                                             (restart recovery)
  INF chain head recovered height=787 stateRoot=0x8ce1fd46…f219
  WRN chain head is ahead of wall clock; dev clock seeded … devOffsetSeconds=10582
  INF listening addr=:9545
  eth_blockNumber -> "0x313"  (787, unchanged across the restart)
```

Notes: the incremental run reaches the same head state root while replaying
half the chain, which is what proves the overlay reads historical trie nodes
out of the audited database rather than recomputing them. The 10,582-second
(~2h56m) dev offset is the accumulated `evm_increaseTime` from
`yarn test:custom`, correctly recovered from the head instead of being lost
to the restart.

## One bug the gate found

The first audit run failed at block 1 with
`field=receipt[0].type` reporting 2 against 0. `receipt.Type` is *derived*, not
stored — go-ethereum's `ReceiptForStorage` is only
`{PostStateOrStatus, CumulativeGasUsed, Logs}` — so a hardhat-deploy EIP-1559
deployment recomputes as type 2 against a structural zero. The comparison was
removed (the transaction's type is covered by the transactionsRoot check
instead).

The unit tests missed it because the fixture chain signed only legacy
transactions, where every derived receipt field equals its zero value and so
is indistinguishable from a stored one. Fixed at the root: the fixture now
includes EIP-1559 and EIP-2930 transactions, and
`TestAuditFixtureCoversEveryTransactionType` keeps it that way.

## What was built (2026-08-01)

| Deliverable | Where |
|---|---|
| Read-only chain open + copy-on-write replay overlay | `internal/storage/{storage,overlay}.go` |
| Genesis verification that never writes | `internal/state/genesis.go` (`VerifyGenesis`) |
| Boot-time head + state integrity check | `internal/state/head.go` (`HeadHeader`, `VerifyHead`), wired in `cmd/node/main.go` |
| Dev-clock seeding from the head on restart | `internal/chain/sequencer.go` (`seedDevClockFromHead`, called from `New`) |
| Crash-ordering rationale | `internal/chain/seal.go` (`persist` doc comment) |
| Replay engine (state/tx/receipt roots, bloom, gas, linkage, timestamps, stored receipts) | `internal/chain/replay.go` |
| Audit CLI (`-data-dir`, `-from`, `-to`, `-json`) | `cmd/audit/main.go`, `make audit` |
| Ops documentation | `packages/blockchain/README.md`, `RUNNING-GATES.md` §6 |

Notes on decisions taken while implementing:

- **Crash consistency was already stronger than the spec asked for.** M03's
  `persist` writes block, receipts, canonical hash and both head pointers in a
  single atomic rawdb batch, so "head pointers written last" is subsumed:
  after a crash the batch either landed whole or not at all. The ordering that
  does matter is between the trie commit and that batch, and it is already
  correct (state durable first). Both are now documented at `persist`, and
  `TestChainRecoversFromAPartialWrite` exercises the orphaned-block case.
- **M07's `replayChain` test helper was deleted**, and
  `TestChainWithSysOpBlocksReplaysToIdenticalRoot` now drives the production
  `Replayer`. A second replay implementation could only drift from the one
  that ships.
- **The audit runs against a read-only source.** Replay's trie nodes go to an
  in-memory overlay layered over the audited database; reads fall through.
  This is safe because trie nodes are content-addressed, so reading through
  cannot smuggle in corrupt state.

## Goal
Prove durability and verifiability: the node resumes exactly where it stopped, and an
independent tool re-derives the entire state from the block list — the "anyone can recheck
the election" property for the FYP report.

## Deliverables
1. Restart hardening in `cmd/node` + `internal/chain`:
   - On boot: read head pointers, open StateDB at head root — **fail fast** if the root is
     missing/corrupt with a message pointing to `cmd/audit`.
   - **Seed the dev clock from the head's timestamp on boot** (carried over from M07).
     `nextTimestamp` takes `max(now + devOffset, parent + 1)`, and `devOffset` resets to
     zero on restart — so a data directory whose head is ahead of wall clock (any chain
     that used `evm_increaseTime`, or an election whose phase deadlines were set in
     jumped-forward time) advances one second per block until wall clock catches up.
     M07 fixed the `evm_increaseTime` case specifically by flooring the offset against the
     head; the general fix is to set `devOffset = head.Time - now` at startup when the head
     is ahead, which is how Hardhat seeds from `initialDate`. Add a test: build a chain with
     a far-future head, reopen, assert the next block lands near the head rather than at
     `head + 1`.
   - Crash-consistency: the rawdb batch + triedb commit ordering from M03 must guarantee
     head pointers are written last (a crash mid-write leaves the previous head valid).
     Add a test simulating partial write (commit block data, skip head update, reopen).
2. `cmd/audit/main.go` — standalone CLI (`make audit`):
   - Opens `DATA_DIR` read-only, replays every block from genesis on a fresh in-memory
     StateDB: re-execute txs (and `extraData` sysops from M07), rebuild receipts.
   - Verifies per block: state root, receipt root, tx root, bloom, gasUsed, parent linkage,
     timestamp monotonicity.
   - Output: per-1000-blocks progress, final `AUDIT OK height=N stateRoot=0x…` or first
     mismatch with block number + field. Exit code 0/1.
   - Flag `--from N` (incremental audits), `--json` (machine-readable summary).
3. Note in `README.md` ops section: audit duration is dominated by Honk proof verification
   (~15M gas/vote); document measured blocks/sec from the gate run.

## Tests
- Go: build a 50-block chain (deploys, writes, reverts-not-mined, sysop block, empty block)
  → close → audit passes; corrupt one receipt byte in the DB → audit reports that block;
  partial-write simulation → node reopens at previous head.
- End-to-end: after the M08 gate ran deploy + tests against the node, run audit on that
  real data directory (it now contains the full Voting stack history incl. ZK verifier
  deploys) → OK.

## Acceptance gate
```
cd packages/blockchain
make test
# using the data dir left by M08's gate:
make audit          # → AUDIT OK height=N ... exit 0
make run &          # node reopens, eth_blockNumber == N, /api-style reads still correct
```
