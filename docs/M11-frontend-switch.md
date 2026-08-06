# M11 — Next.js on the custom chain (reads + env plumbing + v1 cleanup)

Status: automated gates green 2026-08-02 (`RUNNING-GATES.md` §8); **browser
walkthrough still outstanding** · Depends: M08 · Package: `packages/nextjs`

> **Implementation notes (2026-08-02).** Three things the spec did not anticipate,
> found by surveying the package before starting:
>
> 1. **The block explorer used a WebSocket.** `useFetchBlocks.ts` built a
>    `createTestClient` over a hardcoded `ws://127.0.0.1:8545`. Our node implements
>    no `eth_subscribe` by design (MASTER §9), so `/blockexplorer` could not have
>    worked in custom mode at all. It now uses an HTTP `publicClient` bound to the
>    target network with `watchBlocks({ poll: true })`, which behaves identically
>    against Hardhat.
> 2. **Deliverable 3's grep list was incomplete.** Four more sites hardcoded chain
>    or endpoint: `blockexplorer/_components/{ContractTabs,AddressStorageTab}.tsx`,
>    `gn/register/page.tsx`, and `voting/admin/page.tsx`. Six further scaffold-eth
>    modules branched on `chainId === hardhat.id` (burner-wallet visibility, wagmi
>    polling interval, explorer links, tx-data decoding, the `/blockexplorer`
>    redirect, `usePublicClient({ chainId })` in the search bar and tx view) — all
>    equally true of chain 9494. They now share one `isLocalChainId()` predicate.
> 3. **`app/voting/_components/` was entirely dead.** Nothing outside the folder
>    imported any of its 12 components; `/voting` is the "Download the App" page.
>    Deleted with the REST layer, per deliverable 5's conditional.
>
> **Found by running the gate, not by reading the code** (detail in
> `RUNNING-GATES.md` §8): `NEXT_PUBLIC_NIC_REGISTRY_ADDRESS` held a single
> address for a contract that has a different one per chain — and the committed
> value matched neither deployment, so GN registration pointed at a dead address
> in Hardhat mode too. It now resolves from `deployedContracts[targetNetwork.id]`
> and the env var is an optional override. The `noHardcodedChain` guard did not
> catch this: it scans for chain ids and RPC URLs, not per-chain **contract
> addresses arriving through env**. Worth extending.
>
> **Deliberately left Hardhat-only:** the scaffold-eth faucet button/modal
> (`components/scaffold-eth/Faucet{,Button}.tsx`). They fund via
> `eth_sendTransaction` with an unlocked node account, which requires the node to
> hold keys and expose `eth_accounts` — our node does neither. Gas is free on 9494
> so burners need no funding; `/api/faucet` (server-signed) covers the rest.

## Goal
The web app runs against the Go node with **env changes only**; all read surfaces (results,
audit, GN roll, explorer, mobile-serving API routes) work. Stale v1 REST code is removed.
Writes still use MetaMask here (relay lands in M12). Hardhat mode must remain pixel-identical.

## Deliverables
0. *(added during implementation)* `utils/serverChain.ts` — the API routes' chain
   id / RPC URL, resolved once; and `utils/deployedAddress.ts` — per-chain
   contract-address lookup, the fix for the third bug in `RUNNING-GATES.md` §8.
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

Full step-by-step in `RUNNING-GATES.md` §8. Summary:

```
# Phase A — offline, no chain needed
cd packages/nextjs
yarn install             # first time only: M11 adds vitest
yarn test                # 36 unit tests incl. the hardcoded-chain guard
yarn check-types
yarn lint
yarn build

# Phase B — custom mode (node running + contracts deployed per M08)
#   .env.local = custom column
yarn dev
CHAIN_ID=9494 RPC_URL=http://127.0.0.1:9545 node e2e/frontend-check.mjs
#  - /results shows the 3 divisions + national tally
#  - /audit loads VoteCast logs without errors
#  - /blockexplorer browses node blocks
#  - /voting/admin + /gn still function with MetaMask pointed at chain 9494 (temporary until M12)

# Phase C — hardhat regression: restore hardhat env column → yarn chain/deploy
node e2e/frontend-check.mjs      # defaults to 31337 / :8545 — same output shape
```

The equivalence of Phase B's and Phase C's harness output is the milestone's
real claim: the same reads, against two different chains, no source edits.
