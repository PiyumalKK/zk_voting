# M13 — Mobile voter app on the custom chain

Status: code complete, device gate pending · Depends: M11 (step 4's GN enrollment needs M12) · Package: `packages/mobile` (goal: zero code changes)

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

---

## What was built (2026-08-03)

The gate above is a device walkthrough: it proves the system once, on one phone,
and proves nothing repeatably. Two artefacts were added so the parts that *can*
be checked mechanically are:

| Artefact | Runs | Covers |
|---|---|---|
| `src/**/*.test.ts` (vitest, 36 cases) | offline, `yarn test` | Config resolution, the faucet policy, and the hand-built legacy-transaction path driven over HTTP against a recording JSON-RPC server |
| `e2e/mobile-chain-check.mjs` | against a live node + app | The same path against the real node, the `/api` shapes `services/api.ts` decodes, and revert-data decoding |

Neither replaces steps 2–4 of the gate; they narrow what a failure there can
mean. The keystore, biometric auth, OTP and the WebView prover still need a
device.

`packages/mobile` gained one devDependency (`vitest`) and three scripts
(`test`, `test:watch`, `chain-check`). Run `yarn install` from the repo root
before the offline phase.

### The chain tests are wire tests, not mocks of viem

`src/services/chain.test.ts` starts a real HTTP JSON-RPC server, points `CONFIG`
at it, and inspects the bytes that arrive. Mocking viem would have tested the
mock; what matters here is what a node receives. Two assertions carry most of
the value:

- **No `eth_estimateGas`, `eth_feeHistory` or `eth_maxPriorityFeePerGas`
  appears in the request log.** Avoiding those calls is the entire reason
  `chain.ts` is hand-rolled (they are malformed under Hermes), and nothing else
  would notice if a refactor reintroduced one.
- **`gasPrice` is taken from the node even when it is zero, and the 1-gwei
  fallback fires only when the RPC call itself errors.** A fallback that treated
  `0n` as falsy would reprice every vote at 1 gwei and reinstate the gas problem
  the custom chain exists to remove.

One thing worth knowing before reading those tests: a legacy transaction
RLP-encodes a zero gas price as an *empty* item, and viem's `parseTransaction`
then omits the key rather than reporting `0n`. `expect(tx.gasPrice).toBe(0n)`
fails on a correctly-priced free-gas transaction. The tests assert on the raw
RLP item instead.

## Findings — the three source changes

The milestone's rule is that a mobile code change is a finding to be justified
here, not a routine edit. Three were made.

### 1. Burner funding was a precondition for voting (`app/vote.tsx`)

```js
await api.fundBurner(burner.address).catch(() => {
  throw new Error("Could not fund the anonymous wallet (is the local faucet running?)");
});
```

On a chain where `eth_gasPrice` is `0x0`, a burner with a zero balance can
transact — that is the gas-problem proof this milestone exists to demonstrate,
and this line made it impossible to demonstrate. Any faucet failure (down,
`FAUCET_CHAIN_IDS` not covering 9494, `/api/faucet` unreachable from the phone's
LAN address) aborted the vote *before* the transaction was attempted, and
reported a faucet outage to the voter as a failed vote.

Funding is now best-effort via `api.tryFundBurner`, which resolves `false`
instead of throwing. The transaction itself is the honest test of whether a
wallet can pay: "insufficient funds" from the node is precise and names the real
cause, whereas this early abort did not.

**Hardhat mode is unaffected in practice** — the faucet still runs there and
still funds the burner. What changed is only what happens when it does not.

### 2. The same pattern in registration (`app/register.tsx`)

`await api.fundBurner(voterAddress)` at the "Fund" step, unguarded, so a faucet
failure surfaced as `Registration failed (fund wallet)`. Same treatment, same
reasoning. The voter's own key signs `register()`, and on the custom chain it
needs no balance at all.

### 3. A malformed chain id became `NaN` (`src/config.ts`)

`Number(process.env.EXPO_PUBLIC_CHAIN_ID ?? 31337)` yields `NaN` for a
malformed value and `0` for the empty string — and `EXPO_PUBLIC_CHAIN_ID=` in an
env file yields the empty string, not `undefined`, so `??` never fired. viem
accepts either without complaint, signs every transaction for a chain that does
not exist, and the node's rejection says nothing about configuration. This is
the same class of bug M11 found and fixed on the Next.js side
(`utils/customChain.ts`), and it is now guarded by the same kind of test.

`EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_RPC_URL` got the matching blank-is-absent
treatment. The `DEV_HOST`/`DEV_RPC` comment block was rewritten to describe both
modes, as step 1 asks.

## Bugs found in this milestone's own work

Recorded because both were found by review and by running the harness against a
*second* backend, not by writing it:

1. **The reverting-vote check could not work in hardhat mode.** It signed with
   `gasPrice: 0` from a fresh burner. On a chain that charges gas that
   transaction is refused as underpriced or unfunded — a rejection that is not a
   revert, so the check would have failed for a reason having nothing to do with
   what it tests. It now takes the gas price from the node and, when gas is not
   free, signs with a prefunded account.
2. **The registration check built an out-of-range commitment.** A full-width
   256-bit random value overflows BN254's scalar field, which is where the
   Poseidon hash and the LeanIMT live; it is not a valid commitment. Narrowed to
   128 bits.

A third change was quality rather than correctness: a `voting does not depend on
the faucet` check called `pass()` unconditionally and so could never fail. It was
deleted — the unfunded-burner check already proves the property, and
`RUNNING-GATES.md` §4 records the standing rule that a check which cannot fail is
a harness bug.

### Not changed

`src/services/chain.ts` needed nothing. The hand-built legacy path, the
`getGasPrice().catch(() => 1_000_000_000n)` fallback and the fixed 15M vote gas
limit are all already correct against the Go node — which is the milestone's
actual claim, and now the tested one.
