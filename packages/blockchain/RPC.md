# JSON-RPC method reference

Living document, kept current from M04 on (MASTER §11). Reflects
`internal/rpc` as of **M05** — read methods (M04) plus the write path (M05).

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
| `eth_estimateGas` | Always estimates against the current head (a `blockNumber` param, if sent, is accepted and ignored — nothing in this app needs a historical estimate). Returns `usedGas * 1.1` (simple padding, not geth's binary-search estimator — see `internal/chain/sequencer.go`'s `EstimateGas` doc comment). Same revert-error shape as `eth_call`. |
| `eth_gasPrice` | Always `0x0` — free-gas policy. |
| `eth_maxPriorityFeePerGas` | Always `0x0`. |
| `eth_feeHistory` | Real array shapes (`oldestBlock`, `baseFeePerGas[]`, `gasUsedRatio[]`, `reward[][]` when percentiles requested); every value is `0`. |
| `net_version` | Decimal string of `CHAIN_ID` (not hex — pre-dates the hex-quantity convention). |
| `net_listening` | Always `true`. |
| `web3_clientVersion` | `"zkchain/v2.0.0"`. Revisit only if some consumer's tooling is empirically found to special-case client identity (M07). |
| `eth_sendRawTransaction` | Accepts legacy, EIP-2930 and EIP-1559 transactions. **Synchronous:** the transaction is validated, executed and sealed into its own block before the call returns. A transaction that reverts is *rejected here and never mined* — see "Write-path semantics" below. |
| `eth_getTransactionByHash` | Unknown hash → JSON `null`. Never pending: every transaction this chain knows about is mined, so `blockHash`/`blockNumber`/`transactionIndex` are always populated. |
| `eth_getTransactionReceipt` | Unknown hash → JSON `null` result (**not** an error — viem's `waitForTransactionReceipt` polls on exactly this). Carries every field in MASTER §10.5. |
| `eth_getBlockTransactionCountByNumber` | Unresolvable block → JSON `null`, matching `eth_getBlockByNumber`. |
| `eth_getBlockTransactionCountByHash` | Same null-on-unknown rule. |

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

### Block-tag handling (all of the above)

`latest` / `pending` / `safe` / `finalized` → current head. `earliest` →
genesis (block 0). An explicit hex number is honored as-is. There is no
mempool and no reorgs on this chain (single sequencer, auto-mine), so
`pending` never differs from `latest` — MASTER §10 pitfall 4.

## Not yet implemented (by milestone)

- `eth_getLogs` — **M06**.
- `evm_increaseTime`, `evm_mine`, `evm_setNextBlockTimestamp`,
  `hardhat_setBalance` / `anvil_setBalance` — **M07**, gated behind
  `DEV_RPC=true`.

## Explicitly out of scope (MASTER §9 — not planned at all)

- WebSocket subscriptions (`eth_subscribe` family) — every consumer polls
  over HTTP.
- Filter methods (`eth_newFilter` family) — viem's `getLogs` path doesn't
  need them.
- `eth_snapshot` / `evm_snapshot` — no `loadFixture` usage in this repo's
  hardhat tests.
- Tracing/debug namespaces.
- EIP-1898 `{blockHash}` / `{blockNumber}` object-form block parameters —
  every consumer in MASTER §2's table sends a plain tag or hex number.

## Test harnesses

Run `make diff-install` once to install the shared Node dependencies for the
whole `e2e/` tree. All three harnesses below expect **freshly started** nodes
(`make reset && make run`, and a restarted `yarn chain`).

| Command | Script | What it proves |
|---|---|---|
| `make shape-check` | `e2e/shape-check.mjs` | The JSON encoding, with **no node running**: viem's own formatters and ABI decoders are run over the exact objects `internal/rpc/convert.go` marshals. Catches MASTER §10 pitfall 5 (a missing receipt field fails silently) in a second rather than only under a live diff. |
| `make diff HARDHAT_URL=…` | `e2e/diff/diff.mjs` | Read methods (M04): identical calls against both backends, normalizing fields that differ by design (chain id, genesis hash/timestamp, client version) and diffing the rest. |
| `make diff-write HARDHAT_URL=…` | `e2e/diff/write.mjs` | Write path (M05): deploys the same compiled `Probe.sol` on both, then diffs receipts field-by-field, asserts viem decodes the **same custom error name** on both for a revert (on `sendRawTransaction`, `eth_call` and `estimateGas`), and compares nonce-too-low error text. |
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
