# M06 — eth_getLogs

Status: **code complete, gates pending user verification** (2026-08-01) ·
Depends: M05 · Package: `packages/blockchain`

> Same constraint as M04 and M05: this milestone's agent had no Go toolchain
> in-sandbox and no network access to install one (`proxy.golang.org` and
> `go.dev` are both blocked), so `go vet` / `gofmt` / `go test ./...` and the
> live differential run must be executed locally. Step-by-step instructions
> are in `RUNNING-GATES.md`.
>
> **What *was* verified in-sandbox** (four independent passes, all executed,
> none merely reasoned about):
>
> 1. **Bytecode, in a real EVM.** The hand-assembled `logThreeRuntime` fixture
>    was executed under `@ethereumjs/evm` 10.1.2. Confirmed: it emits exactly
>    one LOG3; the topics come out in the order `(t0, t1, t2)` — i.e. the
>    reverse-push stack discipline is right; each topic is the PUSH1 byte
>    right-aligned in a 32-byte word, which is exactly what the Go tests'
>    `topicOf` helper builds; the data word is 32 bytes and right-aligned; and
>    `buildInitCode(logThreeRuntime(…))` returns the runtime byte-identically
>    while emitting no logs of its own. The pre-existing `logRuntime` fixture
>    was re-checked at the same time (3 logs, topics 1/2/3).
> 2. **viem's real wire format.** viem was pointed at a local recording server
>    and driven through the app's five actual `getLogs` call sites
>    (`/api/merkle-path`, `/api/verify-vote`, `app/audit`, `app/gn`,
>    `useContractLogs`) to capture the exact JSON each puts on the wire. Every
>    captured shape decodes cleanly under this milestone's rules. Two findings
>    changed the code — see "Bugs found by the verification pass" below.
> 3. **JSON shapes.** `make shape-check` gained an `eth_getLogs` section and
>    passes 41/41: viem's `parseEventLogs` decodes an array of the exact JSON
>    `RPCLog` marshals to, indexed address *and* uint arguments round-trip,
>    block-scoped `logIndex` survives, and the empty result stays an array.
> 4. **Harness and API surface.** `logs.mjs` passes `node --check` with every
>    viem import resolving against 2.39.0; its hand-built topics match viem's
>    own `encodeEventTopics({args})` byte-for-byte against the committed
>    `Probe.json` ABI. `types.BloomLookup(bin Bloom, topic bytesBacked) bool`
>    was confirmed against the published v1.16.8 API docs. Brace/paren balance
>    and cross-file duplicate-identifier checks are clean in all three
>    packages.
> 5. **Bloom and matcher properties, 30,000 randomized blocks.** The reference
>    Ethereum bloom (`bloomValues` from the yellow paper / geth's `bloom9.go`)
>    was reimplemented over viem's keccak256, and `bloomMatches` + `matchLog`
>    were ported and property-tested against it. **Zero bloom false negatives
>    in 30,000 blocks** — the property that matters, since a false negative
>    silently drops events from the audit page with no error anywhere. The
>    matcher also agrees with an independently written implementation across
>    60,721 log/filter pairs, and the bloom fast path measurably skips 65.5%
>    of blocks (so it is doing real work, not just passing everything
>    through). Nine hand-written edge cases pass alongside.
> 6. **gofmt alignment.** `make fmt` must print nothing, and all of this code
>    was hand-aligned. A column-alignment checker was written that reproduces
>    gofmt's rules for struct fields, const/var blocks and composite-literal
>    values (including the rule that a multi-line cell terminates a column
>    block), **validated against seven files that were already gofmt-clean**
>    before this milestone, and then run over every file M06 touches: clean.

### Bugs found by the verification pass

1. **`"topics": []` was not the shape I assumed.** Capturing viem's real
   output showed the block explorer's address-only query sends
   `topics: []` — an *empty array*, not an omitted field. It decoded
   correctly either way, but only by accident of Go's nil-vs-empty-slice
   rules. `UnmarshalJSON` now normalizes an empty address list and an empty
   topics list to `nil` explicitly, so `LogFilterArgs` has exactly one
   representation for "unconstrained" and the behavior no longer depends on
   an encoding/json subtlety. A test asserting the old empty-but-non-nil
   slice was rewritten (it would have been brittle for the same reason).
2. **`/api/verify-vote` pads the topics array with trailing nulls.** viem
   emits `[sig, nullifierHash, null, null]` — four positions for `VoteCast`'s
   three indexed arguments plus its signature. This works only because
   `matchLog`'s length guard is `len(topics) > len(log.Topics)` and not
   `>=`. That was correct already but entirely untested; a positive test
   case now covers it at both the chain and RPC levels, so a future
   "off-by-one tightening" of that guard fails loudly instead of silently
   breaking vote verification.
3. **Whitespace-tolerant null handling.** `raw.Address` was compared to the
   literal string `"null"` without trimming, while `decodeTopicPosition`
   trimmed. Factored into one `isJSONNull` helper so both paths agree.
4. **An undocumented semantic decision, surfaced by the property test.** The
   randomized matcher comparison disagreed with an independently written
   implementation on 2,210 of 60,721 pairs. Narrowing it produced exactly one
   discriminating input: *a filter with more topic positions than the log has
   topics, where the surplus positions are wildcards.* `matchLog`'s length
   guard runs before the wildcard skip, so it rejects; the other reading
   accepts. `matchLog` is right — that ordering is go-ethereum's, and
   Hardhat-identical behavior is this project's whole point — but the choice
   was accidental rather than deliberate, and entirely undocumented and
   untested.

   It is now: pinned by a chain-level test case, explained in a comment at
   the guard itself, written up in `RPC.md`, and — most importantly —
   **converted from an assumption into a measurement.** `logs.mjs` check (n)
   puts that exact filter to a live Hardhat node and fails the gate if the two
   backends disagree, with a control case asserting that padding to the
   log's *exact* topic count still matches (the `/api/verify-vote` shape).
   If Hardhat turns out to disagree, the gate says so and names both places
   to change.
>
> **Things to watch when running the gates:**
>
> 1. **`gofmt`.** Hand-aligned, not machine-checked. If `make fmt` lists a
>    file, run `gofmt -w .` — cosmetic only.
> 2. **Three receivers under one namespace.** `NewJSONRPCServer` now calls
>    `RegisterName("eth", …)` three times. `TestEthNamespaceMergesAllThreeReceivers`
>    hits a read, a write and a logs method on one server, so a registry that
>    stops merging fails loudly; the one-line fallback is still documented in
>    `server.go`.
> 3. **`NewJSONRPCServer`'s signature changed** from `(seq, chainID)` to
>    `(seq, ServerConfig{...})`. Both call sites (`cmd/node/main.go`,
>    `internal/rpc/testutil_test.go`) are updated. Rationale is in the
>    `ServerConfig` doc comment: M05 needed one scalar, M06 adds a second and
>    M07 will add `DEV_RPC`.
> 4. **`from > to` and unknown-`blockHash` behavior** are deliberate choices,
>    not spec-mandated: an empty range returns `[]`, an unknown blockHash
>    errors. `logs.mjs` check (m) reports what Hardhat does for both as INFO
>    rather than failing — if Hardhat disagrees, that is worth a follow-up,
>    but no consumer in MASTER §2's table produces either shape.

## What was built

| Area | Files |
|---|---|
| Filter engine | `internal/chain/logs.go` (+ `logs_test.go`): `LogFilter`, `FilterLogs`, `resolveLogRange`, `appendBlockLogs`, `bloomMatches`, `matchLog`, `ErrFilterConflict`, `LogRangeError` |
| RPC method | `internal/rpc/eth_logs.go` (+ `eth_logs_test.go`): `EthLogsService`, `LogFilterArgs` with hand-rolled polymorphic `UnmarshalJSON`, `mapFilterError` |
| Server wiring | `internal/rpc/server.go`: `ServerConfig`, third `eth` receiver; `cmd/node/main.go` |
| Config | `internal/config/config.go`: `LOG_RANGE_LIMIT` (default 100,000, must be > 0) + `.env.example` + MASTER §7 row |
| Error codes | `internal/rpc/errors.go`: `invalidParamsCode` (-32602) |
| Test fixtures | `logThreeRuntime` in both packages' `testcontracts_test.go` — a hand-assembled LOG3 emitter, the bytecode shape a Solidity event with two indexed args compiles to |
| Harnesses | `e2e/diff/logs.mjs` (13 check groups), `e2e/shape-check.mjs` `eth_getLogs` section, `Makefile` target `diff-logs`, `e2e/package.json` script `diff:logs` |
| Docs | `RPC.md` "Log filter semantics" section; `RUNNING-GATES.md` |

### Design decisions worth knowing

1. **`toBlock` beyond the head is clamped, not rejected.** Clients routinely
   pass a deliberately huge `toBlock` to mean "as far as you have". Clamping
   is also what makes the range cap meaningful: after clamping, a span can
   never exceed the chain's own height, so the cap can only be tripped by a
   genuinely enormous chain rather than by a client typo.
2. **The range cap is passed into `FilterLogs`, not stored on the
   `Sequencer`.** It is an RPC-surface DoS guard with no effect on execution,
   sealing or state; putting it on the `Sequencer` would place an HTTP-layer
   policy inside the consensus-relevant object. `0` disables it, which is what
   the chain package's own tests use.
3. **go-ethereum's `eth/filters` is not reused.** It is built around a
   bloom-bit index maintained by a background indexer over a full
   `BlockChain` object — machinery this node does not have and does not need
   at an election's scale. Importing it would also break the package-boundary
   rule (`internal/rpc` depends on `internal/chain` plus geth's leaf packages,
   nothing heavier).
4. **The bloom fast path is proven to be *only* a fast path.**
   `TestFilterLogsBloomSkipIsOnlyAnOptimisation` runs every filter shape twice
   — once through `FilterLogs` and once through a brute-force scan that never
   consults the bloom — and requires identical results. Without that test, an
   over-aggressive `bloomMatches` would silently drop events from the audit
   page rather than fail anywhere.

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

Full step-by-step setup (Go toolchain, `npm install`, the stale
`e2e/diff/node_modules` to delete first, which terminal runs what) is in
`RUNNING-GATES.md` §3.

```
cd packages/blockchain

# Phase A — no node needed
make vet && make fmt && make test     # go vet / gofmt -l . / go test ./...
make shape-check                      # 41/41, includes the new eth_getLogs section

# Phase B — both nodes freshly reset and running
make reset && make run &                        # ours on :9545
cd ../hardhat && yarn compile && yarn chain &   # hardhat on :8545
cd ../blockchain

make diff-logs HARDHAT_URL=http://127.0.0.1:8545   # all [PASS], final line PASS
make diff       HARDHAT_URL=http://127.0.0.1:8545  # M04 reads, still green
make diff-write HARDHAT_URL=http://127.0.0.1:8545  # M05 writes, still green
```

`RPC.md` updated (filter semantics + range cap documented) — done.
