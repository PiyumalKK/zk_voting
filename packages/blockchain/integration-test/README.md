# Stage 6 Integration Test

Headless end-to-end test for `packages/blockchain` (see `PLAN.md`'s Stage 6). It
starts a real node, drives a full election through the REST API, generates one
genuinely valid ZK proof, and verifies rejection/restart-recovery behavior.

**This is test infrastructure only.** It plays the role of a browser to produce a
real proof (the same way `packages/nextjs/app/voting/_components/GenerateProof.tsx`
does) so the test can exercise the backend's actual verification path — it is
never part of the running node, and the backend never sees a `nullifier` or
`secret`, only a `commitment` and later a proof + public inputs with no voter
identity attached. See `BLOCKCHAIN_OVERVIEW.md`'s "Stage 6" section for the full
frontend/backend split this preserves.

## Prerequisites

- `openssl` on `PATH` (used to generate a throwaway TLS cert + RSA admin keypair
  for the test run — discarded afterward)
- Go toolchain (builds `packages/blockchain`'s node binary)
- Node.js 18+
- `packages/blockchain/assets/` must contain the compiled contract artifacts
  (`npx hardhat compile` in `packages/hardhat`, then copy into `assets/` — see
  `PLAN.md`'s Stage 2 prerequisite note)
- `packages/nextjs/public/circuits.json` must exist (the compiled Noir circuit —
  same artifact the frontend serves via `/api/circuit`)

## Run

```
npm install
node run.mjs
```

Exits `0` on success, non-zero on any failed assertion (with the node's log
output printed on failure for debugging). Cleans up its own scratch data
directory, generated certs/keys, and the built binary — win or lose.

## What it does

1. Builds and starts a node with `REQUIRE_EVM=true` (fresh data directory, throwaway TLS/admin credentials)
2. Adds two voters, opens registration
3. Registers a real commitment for voter 1 (and a throwaway one for voter 2, so the tree has depth > 0) and checks the Merkle root changes as expected
4. Generates a real ZK proof (via `noir_js` + `@aztec/bb.js`, using the ordered commitment list from `GET /commitments` to rebuild the Merkle tree locally) and submits it — expects acceptance
5. Submits a garbage proof (expects rejection) and resubmits the same valid proof again (expects double-vote rejection)
6. Restarts the node against the same data directory and confirms every read endpoint returns byte-identical state to before the restart
