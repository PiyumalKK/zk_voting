# M13 — Mobile voter app on the custom chain

Status: pending · Depends: M11 (step 4's GN enrollment needs M12) · Package: `packages/mobile` (goal: zero code changes)

## Goal
The Expo app completes register → OTP → proof → anonymous vote against the Go node purely
via env config. Any code change here is a *finding* — first suspect the node, only patch
mobile if the node is provably spec-correct (e.g. an app-side hardcode we missed).

## Steps
1. Env: `EXPO_PUBLIC_RPC_URL=http://<LAN-IP>:9545`, `EXPO_PUBLIC_CHAIN_ID=9494`,
   `EXPO_PUBLIC_API_URL=http://<LAN-IP>:3000` (Next.js in custom mode from M11/M12).
   Update the `DEV_HOST/DEV_RPC` comment block in `src/config.ts` to mention both modes —
   comment-only change.
2. Verify the raw-legacy-tx path against the node (this is the compat-critical surface —
   `src/services/chain.ts` builds legacy txs manually):
   `eth_getTransactionCount(latest)`, `eth_gasPrice` → `0x0` (falls into the app's happy
   path; its 1-gwei fallback triggers only on RPC *failure*), `signTransaction{gasPrice:0,
   chainId:9494}`, `eth_sendRawTransaction`, `waitForTransactionReceipt`.
3. Gasless proof-point: register + vote from a burner with **zero balance** — skip the
   faucet call manually once (or point out `fundBurner` no-ops are tolerated: funding a
   burner 0.05 ETH from prefunded account #0 also works and changes nothing about
   anonymity on a free-gas chain — document both facts).
4. Full device flow on emulator + one physical device (LAN): onboarding → GN enrolls via
   web QR scan (M12 GN portal) → register (OTP + biometric) → WebView UltraHonk proof →
   vote → "Verify My Vote" screen confirms nullifier on-chain → results update on web.

## Acceptance gate
```
- Register tx mined on node (block explorer shows it; NewLeaf log present).
- Vote from unfunded burner succeeds (receipt status 1, gasPrice 0) — THE gas-problem proof.
- Double-vote attempt → app shows the existing "already voted" error
  (Voting__NullifierHashAlreadyUsed decoded through the node's revert data).
- /api/merkle-path serves the correct path (proof verifies) — root matches getVotingData.
- git diff packages/mobile → empty (or comments/env only, with justification recorded here).
```
