# M04 — JSON-RPC server + read methods

Status: **done** (2026-07-31). `go vet`/`go build`/`go test ./...` all clean
(user-run locally; this milestone's agent had no Go toolchain in-sandbox).
Acceptance gate re-verified: `eth_blockNumber` curl check, and
`make diff HARDHAT_URL=http://127.0.0.1:8545` — 12 passed, 0 failed, 2
skipped (the two write-dependent checks correctly defer to M05's
`eth_sendRawTransaction`). One harness bug found and fixed along the way:
`eth_accounts` was diffed for exact equality, but Hardhat legitimately
lists its 20 unlocked dev accounts there while this node correctly never
does (no local keys — MASTER §3); now diffed by shape instead.

## Goal
Standards-compliant JSON-RPC over HTTP with every read method from MASTER §9, verified
byte-shape-compatible against a live Hardhat node by a differential test harness.

## Deliverables
1. `internal/rpc/server.go` — use geth's `rpc.NewServer()` + `RegisterName` for namespaces
   `eth`, `net`, `web3` (M07 adds `evm`, `hardhat`, `anvil`). Mount on `http.ServeMux`
   together with `/health`. CORS middleware (`CORS_ORIGINS`), request logging at debug,
   per-IP token-bucket rate limit (100 rps, burst 200 — generous; env-tunable) exempting
   localhost.
2. `internal/rpc/eth_read.go` — implemented exactly per Ethereum JSON-RPC spec + Hardhat
   quirks:
   - `eth_chainId`, `eth_blockNumber`, `eth_syncing` (→ `false`), `eth_accounts` (→ `[]`)
   - `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount`
     — block tag handling: hex number honored; `latest|pending|safe|finalized` → head;
     `earliest` → genesis (MASTER §10.4)
   - `eth_getBlockByNumber` / `eth_getBlockByHash` with `fullTx bool` — the RPC block
     object (use/mirror geth's `ethapi.RPCMarshalBlock` output; include `baseFeePerGas`,
     `mixHash`, `totalDifficulty` (0x0), tx objects with `v/r/s`, `type`, etc.)
   - `eth_call` — on `RevertError` return JSON-RPC error `{code: 3, message: "execution
     reverted[: <reason-string if Error(string)>]", data: "0x…"}`
   - `eth_estimateGas` (same revert behavior), `eth_gasPrice` → `0x0`,
     `eth_maxPriorityFeePerGas` → `0x0`, `eth_feeHistory` → all-zero arrays of the
     requested length (mirror field names from a real response)
   - `net_version` (decimal string), `net_listening` → `true`,
     `web3_clientVersion` → `"zkchain/v2.0.0"` (revisit in M07 if tooling objects)
3. `internal/rpc/convert.go` — hexutil marshaling helpers; **all** quantities hex-encoded
   per spec (`0x0`, no leading zeros), addresses lowercase, hashes 32-byte hex.
4. **Differential harness** `e2e/diff/diff.mjs` (Node + viem): starts against two RPC URLs,
   runs an identical call script, normalizes volatile fields (hashes, timestamps,
   gas numbers where semantically irrelevant), and diffs JSON. Used from now through M08.
   `make diff HARDHAT_URL=http://127.0.0.1:8545` runs it.

## Tests
- Go: httptest-driven RPC tests per method — tag handling, unknown-method error code
  (-32601), malformed params (-32602), batch requests (geth server gives this free — assert).
- Differential: reads against Hardhat (both fresh chains): `chainId` differs by design
  (31337 vs 9494 — normalized), block 0 shape, balance/code/nonce of prefunded accounts,
  `eth_call` to a deployed test contract, revert error shape for a failing call,
  `feeHistory` field names.

## Acceptance gate
```
cd packages/blockchain && make test && make run &
curl -s -X POST localhost:9545 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'   # → {"result":"0x0"}
# In packages/hardhat: yarn chain &   then:
make diff HARDHAT_URL=http://127.0.0.1:8545    # → PASS (zero unexplained diffs)
```
`packages/blockchain/RPC.md` created: table of implemented methods + behaviors + explicit
non-goals (from MASTER §9). Keep it current from here on.
