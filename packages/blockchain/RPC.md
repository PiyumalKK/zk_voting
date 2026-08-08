# JSON-RPC method reference

Living document, kept current from M04 on (MASTER §11). Reflects
`internal/rpc` as of **M10** — read methods (M04), the write path (M05),
`eth_getLogs` (M06), the dev/compat namespaces (M07), and replica write
forwarding (M10).

## Server

- HTTP JSON-RPC 2.0 at `POST /` (also accepts batched array requests —
  native to go-ethereum's `rpc.Server`). `GET /health` for liveness.
- Middleware stack (outermost first): request logging (debug level) → CORS
  (`CORS_ORIGINS`) → per-IP token-bucket rate limit (`RPC_RATE_LIMIT_RPS` /
  `RPC_RATE_LIMIT_BURST`, default 100/200; loopback callers exempt).
- Unknown method → JSON-RPC error `-32601`. Malformed/undecodable params →
  `-32602`. Both are go-ethereum's own `rpc.Server` behavior, not
  reimplemented here.

## Implemented methods

| Method | Notes |
|---|---|
| `eth_chainId` | Configured `CHAIN_ID` (default 9494). |
| `eth_blockNumber` | Current head height. |
| `eth_syncing` | Always `false` — single sequencer, nothing to sync. |
| `eth_accounts` | Always `[]` — node holds no private keys. |
| `eth_getBalance` | Block-tag aware (see below). |
| `eth_getCode` | Block-tag aware. |
| `eth_getStorageAt` | Block-tag aware; `position` accepted as a variable-length hex quantity (e.g. `"0x0"`), left-padded internally — not a fixed 32-byte value. |
| `eth_getTransactionCount` | Block-tag aware. `pending` has no distinct meaning (no mempool) — resolves to `latest`, same as `safe`/`finalized`. |
| `eth_getBlockByNumber` | `fullTx` supported. Unresolvable number → JSON `null` result (not an error), per spec. |
| `eth_getBlockByHash` | Same null-on-unknown rule as above. |
| `eth_call` | Reverts return JSON-RPC error `{code: 3, message: "execution reverted[: <reason>]", data: "0x<revert bytes>"}` — the reason is decoded only when the revert payload is a standard `Error(string)`; a custom Solidity error keeps the bare message and relies on `data`. |
| `eth_estimateGas` | Always estimates against the current head (a `blockNumber` param, if sent, is accepted and ignored — nothing in this app needs a historical estimate). Binary-searches for the smallest sufficient gas limit, as geth and Hardhat do. **Not** `usedGas * 1.1`, which it was through M07: `ExecutionResult.UsedGas` is reported *net of gas refunds* while a transaction must be funded with the gross amount, and EIP-3529 lets the refund reach `gross/5` — so any flat pad below 1.25x under-funds storage-clearing calls. That gap broke seven M08 contract tests on `Voting.resetElection()`. Same revert-error shape as `eth_call`. |
| `eth_gasPrice` | Always `0x0` — free-gas policy. |
| `eth_maxPriorityFeePerGas` | Always `0x0`. |
| `eth_feeHistory` | Real array shapes (`oldestBlock`, `baseFeePerGas[]`, `gasUsedRatio[]`, `reward[][]` when percentiles requested); every value is `0`. |
| `net_version` | Decimal string of `CHAIN_ID` (not hex — pre-dates the hex-quantity convention). |
| `net_listening` | Always `true`. |
| `web3_clientVersion` | `"zkchain/v2.0.0"` by default. Set `CLIENT_VERSION_MODE=anvil` to report `"anvil/v1.0.0-zkchain"` instead — an escape hatch for tooling that special-cases client identity, to be used only if something is empirically found to need it (M07). |
| `eth_sendRawTransaction` | Accepts legacy, EIP-2930 and EIP-1559 transactions. **Synchronous:** the transaction is validated, executed and sealed into its own block before the call returns. A transaction that reverts is *rejected here and never mined* — see "Write-path semantics" below. |
| `eth_getTransactionByHash` | Unknown hash → JSON `null`. Never pending: every transaction this chain knows about is mined, so `blockHash`/`blockNumber`/`transactionIndex` are always populated. |
| `eth_getTransactionReceipt` | Unknown hash → JSON `null` result (**not** an error — viem's `waitForTransactionReceipt` polls on exactly this). Carries every field in MASTER §10.5. |
| `eth_getBlockTransactionCountByNumber` | Unresolvable block → JSON `null`, matching `eth_getBlockByNumber`. |
| `eth_getBlockTransactionCountByHash` | Same null-on-unknown rule. |
| `eth_getLogs` | Full filter-object support (address single-or-array, positional topics with `null` wildcards and inner OR-arrays, `fromBlock`/`toBlock` tags or numbers, `blockHash` mode). Empty result is `[]`, never `null`. Range capped by `LOG_RANGE_LIMIT`. See "Log filter semantics" below. |

### Consensus methods — `CONSENSUS_MODE=bft` only

Additive and read-only. Registered only on a validator, so a solo node answers
`-32601` for both exactly as it would for a method that was never written —
the same "gated by not existing" approach `DEV_RPC` uses.

They live in a `zk_` namespace of this chain's own rather than in `eth_`
deliberately: every method in the eth namespace has a shape viem, ethers and
the mobile relay depend on, and putting chain-specific consensus data there
would spend the one thing that namespace is valuable for. **No `eth_*` method
changes shape, gains a field or behaves differently in either mode.**

Neither is forwarded by a replica or a validator — both are reads, answered
from local state.

| Method | Params | Returns | Notes |
|---|---|---|---|
| `zk_getCommitSeals` | `[blockNumberOrTag]` | certificate object, or `null` | The signatures that made a block final: `{number, blockHash, round, quorum, validatorSetSize, seals[]}`, each seal `{validator, address, signature}`. Addresses are **recovered server-side from the signatures**, so a client can verify the quorum without holding `VALIDATOR_SET`. Unknown block, or a block with no recorded certificate → JSON `null` (the same convention `eth_getBlockByNumber` follows, and what makes the method safe to call across a rollout or on pre-consensus history). A certificate that exists but does **not** verify returns an error rather than a truncated list. |
| `zk_consensusStatus` | `[]` | status object | `{mode, self, height, round, proposer, validators[], quorum, synced, faulty[]}`. Exists so "did the proposership rotate when we killed a node?" and "is this validator caught up?" are answerable without reading logs. `faulty` names validators caught equivocating. |

See [`CONSENSUS.md`](CONSENSUS.md) for the protocol and for what the seal
certificate means.

### Dev / compatibility methods (M07) — `DEV_RPC=true` only

These are **not registered at all** unless `DEV_RPC=true`, so on a default
node every one of them answers `-32601` exactly like a method that was never
implemented. There is deliberately no per-method flag check: a production
node has no code path that can mutate state outside a transaction.

| Method | Params | Returns | Notes |
|---|---|---|---|
| `evm_increaseTime` | `[seconds]` | **decimal** string of the new *total* offset, e.g. `"5400"` | Accumulates across calls. Affects every block sealed afterward. The total is **signed** — it is negative whenever a block has been pinned below wall clock, which is legal on a fresh chain since genesis is timestamped 0. |
| `evm_setNextBlockTimestamp` | `[timestamp]` | **decimal** string of that timestamp | Pins the next block exactly. A value at or before the current head is `-32000` — see "Timestamp rules" below. |
| `evm_mine` | `[]` or `[timestamp]` | **decimal** string `"0"` | Seals one empty block. The optional timestamp pins it, as `evm_setNextBlockTimestamp` would. |
| `hardhat_setBalance` | `[address, wei]` | `true` | Overwrites (does not add to) the balance. Sealed as a system-op block — see below. |
| `anvil_setBalance` | `[address, wei]` | `true` | Alias for the above; the same service is registered under both namespace names. **Ours only** — Hardhat does not implement it (`-32004 Method anvil_setBalance is not supported`), so there is no parity requirement here. Kept because MASTER §9 lists both spellings for Anvil-flavoured tooling. |

**All three `evm_` methods return decimal strings, and `*_setBalance`
returns a boolean.** None of them use the hex-quantity convention that
governs the rest of the RPC surface. This was established by running
`make diff-dev` against a live `hardhat node`, not by reading Hardhat's
docs — which describe only `evm_increaseTime` as the exception, while
`evm_mine` in fact returns `"0"` too. That harness remains the authority if
this table and the code ever disagree.

**Absolute offset values differ from Hardhat by a second or so**, because
Hardhat seeds its offset from the last block's timestamp while this chain
seeds from wall clock. Only the *deltas* are required to match, and
`diff-dev` asserts them that way. Nothing in the app reads these values.

**Numeric parameters accept three forms:** a bare JSON number (`3601`), a
decimal string (`"3601"`) and a hex quantity string (`"0xe11"`, any letter
case). This matters concretely: `packages/hardhat/test/Voting.ts` calls
`ethers.provider.send("evm_increaseTime", [REG_DURATION + 1])` with a bare
number, which geth's own `hexutil.Uint64` would reject.

**`evm_increaseTime` is measured against the chain head, not wall clock.**
The offset is *stored* relative to wall clock, but the guarantee is that the
next block lands at least `seconds` past the current head. The two differ
whenever the head is already ahead of wall clock — routine on a persistent
chain, since a run that jumped a day forward leaves the head a day ahead and
a restart resets the in-memory offset while those blocks stay on disk.
Without this, the `parent+1` monotonicity floor silently absorbs the entire
jump. Hardhat has no equivalent because its chain is in-memory and always
starts fresh; `make diff-dev` caught the difference as
`our delta=1s hardhat delta=86400s`.

> **Known limitation (M09 will revisit).** The fix above covers
> `evm_increaseTime`. *Ordinary* blocks sealed after a restart onto a head
> that is ahead of wall clock still advance one second at a time until wall
> clock catches up, because `nextTimestamp` takes `max(now + offset,
> parent + 1)`. Nothing in M07 or M08 depends on this, but restart recovery
> is M09's subject, and the natural fix belongs there: seed `devOffset` from
> the head's timestamp at startup, the way Hardhat seeds from `initialDate`.

**Timestamp rules.** Block timestamps on this chain are strictly increasing
(MASTER §10 pitfall 7 — `Voting.sol`'s phase deadlines depend on it), so a
requested next-block timestamp at or before the current head is rejected
rather than clamped. A pin set by `evm_setNextBlockTimestamp` is consumed by
the next block that is *actually sealed* — a transaction that reverts mines
nothing and therefore leaves the pin in place. Once the pinned block is
sealed, the dev clock continues forward from the pinned time rather than
snapping back to wall clock, matching Hardhat.

**System-op blocks.** `hardhat_setBalance` changes state without a
transaction, which MASTER §10 pitfall 10 forbids doing outside a block: M09's
audit tool replays the block list and verifies every state root, and M10's
replicas re-execute each block and reject any whose root doesn't match.
Neither can see a mutation that isn't in a block. So the write is sealed as a
zero-transaction block whose header `extraData` carries a deterministic
ASCII encoding of the operation and whose state root already reflects it:

```
sysop:setBalance:0x000000000000000000000000000000000000dEaD:0xde0b6b3a7640000
```

Address is EIP-55 checksummed, value is a canonical minimal-width lowercase
hex quantity. Ordinary and empty blocks carry no `extraData` (`"0x"` in JSON);
genesis carries `zkchain-genesis`. `internal/chain.ParseSysOp` /
`ApplySysOp` are the shared decoder and applier — the sequencer, the audit
replay and the replica verifier all use the same pair, which is what makes
their state roots agree. The sequencer refuses to seal a system op whose
encoding does not parse back, so "every sysop block on this chain is
replayable" holds by construction rather than by convention.

### Log filter semantics (M06)

**Filter object.**

| Field | Accepted | Meaning |
|---|---|---|
| `fromBlock` | omitted, `null`, a tag, or a hex number | Defaults to `latest`. `earliest` → 0. |
| `toBlock` | omitted, `null`, a tag, or a hex number | Defaults to `latest`. A number beyond the head is **clamped to the head**, so the common "give me everything" idiom (`toBlock: 0x3b9aca00`) works instead of erroring. |
| `blockHash` | a 32-byte hash | Pins the query to exactly that block. **Mutually exclusive** with `fromBlock`/`toBlock` — sending both is `-32602`. An unknown hash is an *error*, not an empty result. |
| `address` | omitted, `null`, `"0x…"`, or `["0x…", …]` | OR-list. Omitted/null matches any address. |
| `topics` | omitted, `null`, or an array whose elements are `null`, `"0x…"`, or `["0x…", …]` | Positional. `topics[i]` constrains the log's *i*-th topic. `null` (or `[]`, or an array containing `null`) at a position is a wildcard. A log with fewer topics than `topics.length` never matches — see below. |

**The `topics` length rule.** A filter with more positions than the log has
topics never matches, **even when the surplus positions are wildcards**. The
length check runs before any rule is consulted, which is go-ethereum's
`eth/filters` ordering and therefore Hardhat's. The alternative reading —
skip wildcards first, reject only on a real constraint past the end — differs
on exactly one input, and `make diff-logs` check (n) puts that input to a live
Hardhat node and **fails the gate** if the two backends disagree, rather than
leaving the choice to documentation.

Padding to *exactly* the log's topic count does match, and must: viem pads a
`topics` array out to the event's full indexed-argument count with trailing
nulls, which is precisely what `/api/verify-vote` sends for `VoteCast`
(`[signature, nullifierHash, null, null]` against a 4-topic log). Check (n)
carries that as a control case.

**Ordering.** Ascending by `(blockNumber, logIndex)`. `logIndex` is the log's
position within its **block**, not within its transaction.

**Every returned log carries** `address`, `topics`, `data`, `blockNumber`,
`transactionHash`, `transactionIndex`, `blockHash`, `logIndex` and
`removed` — exactly nine fields. `removed` is always `false`: a single
sequencer produces no reorgs, so no log is ever un-emitted.

**`fromBlock > toBlock`** (including a `fromBlock` past the head) returns the
empty array rather than an error — that is a normal polling step ("anything
since the last block I saw"), not a malformed request.

**Range cap.** A query spanning more than `LOG_RANGE_LIMIT` blocks (default
100,000) is rejected with `-32000` and a message naming the limit. The cap is
applied *after* clamping `toBlock` to the head, so it can only be reached by
a chain that is genuinely that long — an election's chain is orders of
magnitude smaller. Set `LOG_RANGE_LIMIT=0` to disable it.

**Implementation.** `internal/chain/logs.go` walks the resolved block range
and uses each header's bloom filter to skip blocks that cannot contain a
match before paying to read their receipts. A bloom match is necessary but
not sufficient, so every admitted block is still matched exactly — the bloom
is only ever an optimisation, a property asserted directly by
`TestFilterLogsBloomSkipIsOnlyAnOptimisation`.

### Write-path semantics (M05)

**Auto-mine, one transaction per block.** There is no mempool. A submitted
transaction is validated, executed and sealed synchronously, so `latest` and
`pending` are always the same state.

**A reverting transaction is never mined.** The revert surfaces from
`eth_sendRawTransaction` itself as `{code: 3, message: "execution
reverted[: <reason>]", data: "0x<revert bytes>"}`, the chain head does not
move, and no receipt is ever created for it. This is Hardhat's behavior and
the app depends on it: mobile and web error handling matches on custom error
names decoded from `data` (MASTER §10 pitfalls 1–2).

**Validation errors** use code `-32000` and reproduce Hardhat's wording,
because the clients substring-match it:

| Condition | Message |
|---|---|
| Nonce below the account's | `Nonce too low. Expected nonce to be N but got M. Note that transactions can't be queued when automining.` |
| Nonce above the account's | `Nonce too high. …` (same shape — there is no mempool to queue it in) |
| Signature/chain-id mismatch | `Trying to send a raw transaction with an invalid chainId. The expected chainId is 9494` |
| `tx.gas` over the block gas limit | `Transaction gas limit is X and exceeds block gas limit of Y` |
| Insufficient funds / intrinsic gas | Hardhat's prefix plus go-ethereum's detail — see `internal/rpc/errors.go`'s `mapSubmitError` for why these two are not reproduced verbatim. Both are effectively unreachable under the free-gas policy. |
| Undecodable transaction bytes | `Invalid transaction: <decode error>` |

**Receipt fields.** `effectiveGasPrice` is always `0x0` (free gas).
`contractAddress` is JSON `null` for a non-creation (not the zero address);
`to` is `null` for a creation. `logs` is always an array, never `null`, and
each log's `logIndex` is its position within the *block*.

### Replica behavior (M10)

A node started with `ROLE=replica` exposes the **same** JSON-RPC surface as
the sequencer. The difference is where each call is answered:

| Calls | Where | Why |
|---|---|---|
| Everything read-only (`eth_call`, `eth_getLogs`, `eth_getBalance`, receipts, blocks, …) | locally, from state the replica re-executed itself | this is the point of having replicas |
| `eth_sendRawTransaction`, `eth_sendTransaction` | forwarded to `PRIMARY_RPC_URL` | only the sequencer extends the chain |
| `evm_*`, `hardhat_*`, `anvil_*` | forwarded to `PRIMARY_RPC_URL` | these mutate state outside a transaction (M07); a replica serving `evm_mine` locally would fork the cluster |

Forwarding is byte-for-byte: the request body is passed through unaltered and
the sequencer's response — including a revert's `{code: 3, data}` object — is
copied back verbatim. Nothing is re-encoded, so a client cannot tell which
node it reached. A batch containing at least one forwarded method is sent
whole, so ordering within a batch is preserved.

If the sequencer cannot be reached, the replica answers with JSON-RPC
`-32603` and a message naming it, rather than an HTTP error page that clients
cannot parse.

`GET /health` on a replica reports replication state as well as liveness:

```json
{"status":"ok","role":"replica","chainId":9494,"height":787,
 "primaryHeight":787,"synced":true}
```

`synced` stays false until the primary has actually been reached, so a fresh
replica that has never contacted the sequencer is distinguishable from one
that is level with it. The two fields are absent entirely on a primary.

The P2P port (`P2P_PORT`, default 9546) is a separate, mTLS-only surface and
is **not** JSON-RPC — see README's topology section. It carries
`POST /p2p/block`, `GET /p2p/blocks?from=&limit=` and `GET /p2p/head`.

### Block-tag handling (all of the above)

`latest` / `pending` / `safe` / `finalized` → current head. `earliest` →
genesis (block 0). An explicit hex number is honored as-is. There is no
mempool and no reorgs on this chain (single sequencer, auto-mine), so
`pending` never differs from `latest` — MASTER §10 pitfall 4.

## Not yet implemented (by milestone)

Nothing outstanding: MASTER §9's compatibility matrix is fully covered as of
M07.

## Explicitly out of scope (MASTER §9 — not planned at all)

- WebSocket subscriptions (`eth_subscribe` family) — every consumer polls
  over HTTP.
- Filter methods (`eth_newFilter` family) — viem's `getLogs` path doesn't
  need them.
- `eth_snapshot` / `evm_snapshot` / `evm_revert` — no `loadFixture` usage in
  this repo's hardhat tests (grep-verified: `test/Voting.ts` drives time with
  `evm_increaseTime` + `evm_mine` directly).
- `hardhat_impersonateAccount` — nothing in the app needs to send as an
  account it has no key for; the relay (M12) holds real keys.
- Tracing/debug namespaces.
- EIP-1898 `{blockHash}` / `{blockNumber}` object-form block parameters —
  every consumer in MASTER §2's table sends a plain tag or hex number.

## Test harnesses

Run `make diff-install` once to install the shared Node dependencies for the
whole `e2e/` tree. Every harness below except `shape-check` expects **freshly
started** nodes (`make reset && make run`, and a restarted `yarn chain`).

| Command | Script | What it proves |
|---|---|---|
| `make shape-check` | `e2e/shape-check.mjs` | The JSON encoding, with **no node running**: viem's own formatters and ABI decoders are run over the exact objects `internal/rpc/convert.go` marshals. Catches MASTER §10 pitfall 5 (a missing receipt field fails silently) in a second rather than only under a live diff. |
| `make diff HARDHAT_URL=…` | `e2e/diff/diff.mjs` | Read methods (M04): identical calls against both backends, normalizing fields that differ by design (chain id, genesis hash/timestamp, client version) and diffing the rest. |
| `make diff-write HARDHAT_URL=…` | `e2e/diff/write.mjs` | Write path (M05): deploys the same compiled `Probe.sol` on both, then diffs receipts field-by-field, asserts viem decodes the **same custom error name** on both for a revert (on `sendRawTransaction`, `eth_call` and `estimateGas`), and compares nonce-too-low error text. |
| `make diff-logs HARDHAT_URL=…` | `e2e/diff/logs.mjs` | `eth_getLogs` (M06): builds an identical `Probe.ValueSet` event sequence on both backends (including one block carrying three logs), then diffs the raw responses field-by-field across address filters, topic filters (signature, indexed address, indexed uint OR-lists, wildcard positions), block-range subsets, `blockHash` mode and the empty result — and asserts viem's `parseEventLogs` output is identical on both. |
| `make diff-dev HARDHAT_URL=…` | `e2e/diff/dev.mjs` | Dev methods (M07): drives `evm_increaseTime` / `evm_setNextBlockTimestamp` / `evm_mine` / `hardhat_setBalance` / `anvil_setBalance` through the identical call sequence on both backends and diffs the **return encodings** (decimal vs hex vs boolean) and observable effects — timestamp deltas, height advance, empty-block shape, balance readback. Requires our node started with `DEV_RPC=true` (`make run-dev`); unlike the other harnesses it does *not* need freshly-reset chains. |
| `make smoke` | `e2e/smoke-deploy.mjs` | The real stack: deploys `PoseidonT3 → LeanIMT (linked) → HonkVerifier → Voting` from `packages/hardhat/artifacts` and drives `setCandidates → addVoters → startRegistration → register`, asserting a non-zero Merkle root. Point `RPC_URL` at hardhat to run the same script there as a control. |

`e2e/diff/contracts/Probe.sol` is compiled once with solc-js and its artifact
(`Probe.json`) is committed, so running the harnesses needs no Solidity
toolchain. Regenerate with `make probe-build` after editing it.

## Response shape notes

`internal/rpc/convert.go` hand-builds the standard `eth_getBlockByNumber`/
`eth_getTransactionByHash` JSON shapes (go-ethereum's own marshaling lives
in `internal/ethapi`, not importable outside the go-ethereum module). Two
fields are flagged there as needing empirical confirmation via `make diff`
rather than being fully certain from spec-reading alone:

- `requestsHash` (EIP-7685/Prague) — this chain's headers always carry it
  (Prague active from genesis), but whether the pinned Hardhat version's
  `eth_getBlockByNumber` response does too, under this exact field name,
  is unconfirmed.
- `withdrawalsRoot` / `withdrawals` / `blobGasUsed` / `excessBlobGas` /
  `parentBeaconBlockRoot` — likely present on a modern Hardhat network
  (Shanghai/Cancun active), but same caveat.

If `make diff` reports a shape mismatch on any of these, trust the diff
output over this document and delete/adjust the offending field in
`convert.go`.
