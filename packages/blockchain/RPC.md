# JSON-RPC method reference

Living document, kept current from M04 on (MASTER §11). Reflects
`internal/rpc` as of M04 — read methods only. M05 adds the write methods
listed as "not yet implemented" below.

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

### Block-tag handling (all of the above)

`latest` / `pending` / `safe` / `finalized` → current head. `earliest` →
genesis (block 0). An explicit hex number is honored as-is. There is no
mempool and no reorgs on this chain (single sequencer, auto-mine), so
`pending` never differs from `latest` — MASTER §10 pitfall 4.

## Not yet implemented (by milestone)

- `eth_sendRawTransaction`, `eth_getTransactionByHash`,
  `eth_getTransactionReceipt` — **M05**.
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

## Differential test harness

`e2e/diff/diff.mjs` (Node + viem) runs an identical set of calls against
this node and a live `hardhat node`, normalizing fields expected to differ
by design (chain id, genesis hash/timestamp, client version string) and
diffing the rest exactly. Run via `make diff HARDHAT_URL=http://127.0.0.1:8545`
(first `make diff-install` once, and `make run` / `yarn chain` must both
already be running).

The harness's "deploy a contract" / `eth_call` / "revert shape" checks
submit a transaction to this node first; until M05 lands
`eth_sendRawTransaction`, those checks **SKIP** (not fail) with an
explanatory message — the same script starts actually exercising them once
M05 is in place, no script changes needed.

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
