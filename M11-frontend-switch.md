# M11 — Next.js on the custom chain (reads + env plumbing + v1 cleanup)

Status: pending · Depends: M08 · Package: `packages/nextjs`

## Goal
The web app runs against the Go node with **env changes only**; all read surfaces (results,
audit, GN roll, explorer, mobile-serving API routes) work. Stale v1 REST code is removed.
Writes still use MetaMask here (relay lands in M12). Hardhat mode must remain pixel-identical.

## Deliverables
1. `utils/customChain.ts` — viem chain object: id `NEXT_PUBLIC_CHAIN_ID`, rpc
   `NEXT_PUBLIC_RPC_URL`, name "ZK Election Chain".
2. `scaffold.config.ts` — `chainBackend === "custom"` → `targetNetworks: [customChain]`
   (replace the current `chains.mainnet` placeholder hack; keep the type-pinning cast so
   scaffold-eth contract typing still compiles).
3. Env audit: every route/page must derive chain from env, never hardcode 31337/8545.
   Grep-verify: `app/api/{election,merkle-path,verify-vote,faucet}/route.ts` already use
   `NEXT_PUBLIC_CHAIN_ID`/`RPC_URL` (confirmed); `hooks/useDivisions.ts` and any
   `createPublicClient` in pages must use the target network from scaffold config.
4. Faucet: replace the `CHAIN_ID !== 31337` guard with an allowlist `{31337, custom id}`
   (env `FAUCET_CHAIN_IDS`, default `"31337,9494"`). It funds from prefunded Hardhat
   account #0, which exists on our chain by genesis design — works unchanged.
5. **v1 cleanup (delete after `git grep` confirms no remaining imports):**
   - `services/chain/{restClient,identityStore,errors}.ts`; strip all `custom`-REST
     branches from `services/chain/hooks.ts` — if the old web-voting components that
     consume these hooks are themselves dead (web voting is now the "Download the App"
     page), delete the dead components + `hooks.ts` entirely; keep the tree compiling.
   - `app/api/admin/[action]/route.ts` (RSA-signing proxy for the v1 REST node).
   - `app/chain-explorer/` (v1 REST explorer) — the scaffold `app/blockexplorer/` now
     works against our node's RPC in custom mode; verify and keep that one.
   - README "Switching Chain Backends" section rewritten to MASTER §8.
6. `.env.example` updated with the two mode columns (MASTER §7).

## Acceptance gate
```
# Custom mode: blockchain node running + contracts deployed (M08), .env.local = custom column
cd packages/nextjs && yarn dev
#  - /results shows the 3 divisions + national tally
#  - /audit loads VoteCast logs without errors
#  - /blockexplorer browses node blocks
#  - /api/election, /api/merkle-path?division=..&commitment=.. , /api/verify-vote respond correctly
#  - /voting/admin + /gn still function with MetaMask pointed at chain 9494 (temporary until M12)
yarn next build          # type-check + build green
# Hardhat regression: restore hardhat env column → yarn chain/deploy → identical behavior to main
```
