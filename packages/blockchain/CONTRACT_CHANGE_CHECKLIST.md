# Contract / Circuit Change Checklist

The Go node embeds the compiled Solidity contracts and exposes one typed Go
method + one REST endpoint per contract function. Unlike scaffold-eth (which
regenerates its bindings automatically on `yarn deploy`), these bindings are
**hand-written** — a contract change that skips a step below ships a node that
silently runs stale logic. This list is the price of the typed bridge; the
payoff is decoded revert errors, pre-commit EVM validation, and caching.

## When `Voting.sol` (or a library it links) changes

1. **Artifacts** — `make sync-artifacts` (compiles in `packages/hardhat`, copies
   `Voting.json`, `HonkVerifier.json`, `PoseidonT3.json`, `LeanIMT.json` into
   `assets/`). The node logs `voting_code_hash` at startup — compare across
   nodes/deploys to catch drift.
2. **`internal/evm/bridge.go`** — add/update the typed method for any
   added/changed function (Pack call, arg encoding, cache invalidation rule,
   `blockTime` parameter).
3. **`internal/core/types.go`** — new `TxType` + payload struct if the change
   introduces a new write operation.
4. **`internal/evm/replay.go`** — one new `case` dispatching the new `TxType`
   to the bridge method.
5. **`internal/api/server.go`** — handler + route (admin-gated writes follow
   the "EVM first, commit only on success" ordering; reuse `commitAdminTx`).
6. **`API.md`** — document the endpoint/response change (this file is the
   frontend's contract).
7. **Tests** — `internal/evm/bridge_test.go`, `internal/api/server_test.go`,
   and `integration-test/run.mjs` if the end-to-end flow changed.
8. **Frontend** — add the method to the `ChainAdapter` interface
   (`packages/nextjs/services/chain/types.ts`) and implement it in BOTH
   adapters (`hooks.ts` EVM branch + REST branch).

## When the Noir circuit (`packages/circuits`) changes

1. Recompile the circuit; replace `packages/nextjs/public/circuits.json`.
2. Regenerate `Verifier.sol` (HonkVerifier) from the new verification key and
   place it in `packages/hardhat/contracts/`.
3. `make sync-artifacts` (the verifier is one of the four embedded artifacts).
4. If public inputs / sibling count changed: update `GenerateProof.tsx`
   (fixed `[Field; 16]` padding, input order) and `Voting.sol`'s `vote(...)`
   signature — then the `Voting.sol` checklist above applies too.

## Genesis defaults

The default question/candidates live in TWO places — keep them identical:
- `packages/hardhat/deploy/00_deploy_your_contract.ts` (hardhat deploys)
- `packages/blockchain/cmd/node/main.go` → `core.NewBlockchain(...)` (genesis)
