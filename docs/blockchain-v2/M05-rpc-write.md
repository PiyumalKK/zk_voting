# M05 — Write path: sendRawTransaction, tx queries, revert errors

Status: pending · Depends: M04 · Package: `packages/blockchain`

## Goal
Full write cycle over RPC with Hardhat-identical error semantics — after this milestone viem
can deploy and interact with arbitrary contracts on the node.

## Deliverables — `internal/rpc/eth_write.go`
1. `eth_sendRawTransaction(data hexutil.Bytes)`:
   decode `types.Transaction` (UnmarshalBinary) → `Sequencer.SubmitTx` → return tx hash.
   Error mapping (differential-verify each against Hardhat, adjust wording to match):
   - validation failures → error code `-32000` style messages (`Nonce too low. Expected X got Y`,
     `Trying to send a raw transaction with an invalid chainId`, …) — copy Hardhat's
     observed text where the app might substring-match; otherwise keep close.
   - execution revert → `{code: 3, message: "execution reverted…", data: "0x<revert bytes>"}`
     and **no block mined** (MASTER §10.1–2).
2. `eth_getTransactionByHash` — via rawdb tx lookup; include `blockHash/blockNumber/
   transactionIndex` (never pending — all known txs are mined), `v/r/s`, `type`,
   `gasPrice` (effective, i.e. as-signed), 1559 fields when applicable.
3. `eth_getTransactionReceipt` — every field from MASTER §10.5. `null` for unknown hash
   (viem polls on this — must be JSON `null` result, not an error).
4. `eth_getBlockTransactionCountByNumber`/`ByHash` (trivial; explorer may probe).

## Tests
- Go: submit signed legacy + 1559 + 2930 txs (build with geth types + test keys); assert
  receipt shape, tx lookup, unknown-hash → null.
- Differential (`e2e/diff/write.mjs`): with viem against both nodes —
  a) deploy a test contract with custom errors + events (add `e2e/diff/contracts/Probe.sol`,
     compile once with solc-js, commit artifact);
  b) successful write → receipt field-by-field diff (normalize hashes/gas);
  c) revert via custom error → assert **viem decodes the same error name** on both;
  d) revert on `eth_call` and on `estimateGas`;
  e) nonce-too-low replay → compare error substrings;
  f) `waitForTransactionReceipt` completes on both.
- **Realistic dry-run:** script `e2e/smoke-deploy.mjs` — viem deploys the *actual* compiled
  `PoseidonT3 → LeanIMT (linked) → HonkVerifier → Voting` artifacts from
  `packages/hardhat/artifacts` (read at runtime; library linking done in-script), calls
  `setCandidates`, `startRegistration`, `register(commitment)`, reads `getVotingData`.
  This proves the EVM handles the real bytecode (Poseidon, big contracts) before M08.

## Acceptance gate
```
cd packages/blockchain && make test
make run &  # fresh chain (make reset first)
node e2e/diff/write.mjs           # PASS vs hardhat node
node e2e/smoke-deploy.mjs         # deploys real Voting stack, register succeeds, root != 0
```
