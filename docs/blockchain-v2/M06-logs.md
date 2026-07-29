# M06 — eth_getLogs

Status: pending · Depends: M05 · Package: `packages/blockchain`

## Goal
Event queries powering the audit page, `/api/verify-vote`, `/api/merkle-path` (NewLeaf
history) and the block explorer.

## Deliverables — `internal/rpc/eth_logs.go`
1. `eth_getLogs(filter)` supporting: `fromBlock`/`toBlock` (hex or tags; default latest),
   `blockHash` (exclusive with range), `address` (single or array), `topics` (positional;
   `null` wildcard; inner array = OR) — full spec semantics, viem exercises all of these.
2. Implementation: iterate the block range, load receipts via rawdb, use each header's
   **bloom filter to skip** non-matching blocks (cheap and already stored), then match
   precisely. Range cap: `LOG_RANGE_LIMIT` env, default 100,000 blocks (an election is far
   smaller; the cap is DoS protection) → spec-style error when exceeded.
3. Derived log fields must be populated exactly: `address, topics, data, blockNumber,
   transactionHash, transactionIndex, blockHash, logIndex, removed:false`.

## Tests
- Go: contract emitting distinct events across many blocks → filter by address; by topic0;
  topic0 OR-list; topic1 (indexed arg); range subsets; blockHash mode; empty result is `[]`
  not `null`; range-cap error.
- Differential (`e2e/diff/logs.mjs`): same event sequence on both nodes; also replicate the
  app's real query patterns (grep-sourced):
  - `getLogs({address, event: NewLeaf, fromBlock: 0n})` — merkle-path route
  - `VoteCast` topic filter — verify-vote + audit page
  - `DivisionCreated/DivisionAdded` from the registry — useDivisions/admin
  Assert viem's `parseEventLogs` output is identical on both.

## Acceptance gate
```
cd packages/blockchain && make test
node e2e/diff/logs.mjs      # PASS
```
`RPC.md` updated (filter semantics + range cap documented).
