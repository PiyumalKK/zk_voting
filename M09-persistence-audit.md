# M09 — Restart recovery + audit replay tool

Status: pending · Depends: M08 · Package: `packages/blockchain`

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
