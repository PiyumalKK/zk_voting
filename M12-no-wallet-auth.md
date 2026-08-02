# M12 — No-wallet admin/GN auth + signing relay (custom mode only)

Status: **pass 1 (server) code complete · pass 2 (UI) pending** · Depends: M11 · Package: `packages/nextjs`
**Read `01-AUTH-DESIGN.md` first — it is the spec. This file adds only sequencing + gates.**

## Split into two passes

The milestone was implemented in two passes so the security-critical half could
be reviewed before the UI churn:

- **Pass 1 (done):** build-order items 1–3 and the server half of 6 — the auth
  services, auth routes, middleware, `POST /api/relay` and `/api/gn-accounts`.
- **Pass 2 (next):** items 4–5 and the admin panel UI — `useElectionWriter`,
  `useElectionAuth`, `app/login/page.tsx`, and the mechanical page refactors.
  **Until pass 2 lands, the middleware redirects to `/login`, which does not
  exist yet**, and the admin/GN pages still call `walletClient.writeContract`
  directly — so custom mode is not yet operable end-to-end by hand.

### Pass 1 inventory

| File | Role |
|---|---|
| `services/auth/crypto.ts` | bcrypt helpers, AES-256-GCM envelope, key parsing, one-time password generation |
| `services/auth/session.ts` | Session shape, cookie policy, role→path table. **Edge-safe** — the only auth module `middleware.ts` may import |
| `services/auth/serverSession.ts` | `getServerSession` / `requireSession` for route handlers (Node runtime) |
| `services/auth/accounts.ts` | `GnAccountStore`: atomic JSON store, sealed keys, CRUD |
| `services/auth/rateLimit.ts` | Fixed-window limiter + login lockout, injectable clock |
| `services/auth/relayPolicy.ts` | **Pure** whitelist, GN division scoping, ABI arity/type validation |
| `services/auth/relayContracts.ts` | Server-side resolution of addressable contracts (registries + live divisions) |
| `services/auth/relayExecutor.ts` | Authorise → sign → send → audit; custom-error decoding |
| `services/auth/auditLog.ts` | JSONL relay audit log |
| `middleware.ts` | Route gating; **returns `next()` immediately in hardhat mode** |
| `app/api/auth/{login,logout,session}/route.ts` | Credential login, 5/min/IP, lockout 15 min after 5 failures |
| `app/api/relay/route.ts` | The signer endpoint, 30/min/session |
| `app/api/gn-accounts/route.ts` | Admin-only GN account CRUD (`GET`/`POST`/`PATCH`/`DELETE`) + auto `setGNOfficer` |

Dependencies added: `iron-session@8.0.4`, `bcryptjs@3.0.3` (pure JS — no native
build step on Windows, CI or Vercel).

Tests: **112 new cases** across `middleware.test.ts` and `services/auth/*.test.ts`
— the AES envelope (round-trip, wrong key, cross-account AAD, tamper), the
account store (no plaintext key on disk, concurrent-write serialisation,
corrupt-file refusal), the relay policy (cross-division GN, unknown target,
voter functions, argument coercion and caps), revert decoding, audit-line
serialisation, and the middleware (hardhat pass-through, forged and
foreign-sealed cookies, role routing, fail-closed on a bad `SESSION_SECRET`).
Run them with `yarn test`; the gate is `RUNNING-GATES.md` §9.

Three of those tests exist because they caught real bugs during the
verification pass, all of which would have surfaced as opaque 500s:

1. `describeRevert` overflowed the stack on a self-referential error `cause`
   — viem's `walk()` has no cycle detection, and this code runs inside a catch.
2. `serialiseArgs` threw on a `bigint` nested in an array, because
   `JSON.stringify` cannot serialise one — and it runs while *building* the
   audit record, before any write is attempted.
3. Session construction throws when `SESSION_SECRET` is missing, and no route
   handler caught it. Now centralised in `tryGetServerSession()` → 503 naming
   the variable.

## Build order
1. `services/auth/` — iron-session config (`SESSION_SECRET`), bcrypt helpers, GN account
   store (`data/gn-accounts.json`, atomic writes, gitignored) with AES-256-GCM key
   encryption (`GN_KEY_ENCRYPTION_KEY`). Unit-test crypto round-trip + store CRUD.
2. Auth routes: `POST /api/auth/login` (admin creds from env; GN from store; 5/min/IP rate
   limit; lockout 15 min after 5 failures), `/logout`, `GET /api/auth/session`.
   `middleware.ts`: when `NEXT_PUBLIC_CHAIN_BACKEND=custom`, gate `/voting/admin`, `/gn/**`,
   `/api/relay`, `/api/gn-accounts` → redirect to `/login`. **No-op in hardhat mode.**
3. `POST /api/relay` exactly per `01-AUTH-DESIGN.md` §4 (whitelist table, ABI from
   `deployedContracts.ts`, per-role keys, JSONL audit log, decoded-revert passthrough,
   30/min/session rate limit). Unit-test the whitelist/scoping logic hard: GN cannot target
   another division; unknown fn rejected; args validated against ABI arity/types.
4. `hooks/useElectionWriter.ts` — the single seam:
   `write({target, fn, args}) → Promise<{txHash}>`; hardhat → existing wagmi
   `walletClient.writeContract` path (moved, not rewritten); custom → `fetch /api/relay`.
   Also `useElectionAuth()` → `{mode, session, isOwner}` replacing wallet-address owner
   checks in custom mode.
5. Page refactors (mechanical, no logic changes): `app/voting/admin/page.tsx`,
   `app/voting/_components/AddVotersModal.tsx`, `app/gn/register/page.tsx`, `app/gn/page.tsx`
   — every `writeContractAsync`/`walletClient.writeContract` → `useElectionWriter`; wallet
   connect UI (RainbowKit button, address displays) hidden when `mode === "custom"`.
6. Admin UI addition (custom mode only): "GN Accounts" panel — create GN account →
   server generates keypair → shows username + one-time password → relay auto-calls
   `setGNOfficer(gnAddress)` on the chosen division.
7. GN key bootstrap note: `ADMIN_RELAY_PRIVATE_KEY` must be the deploy owner (Hardhat
   account #0's key for the dev mnemonic) — document in `.env.example` with a warning that
   production replaces this with a dedicated key at deploy time.

## Acceptance gate

Pass 1's runnable gate — offline checks, the auth/relay API driven by `curl`,
the on-disk key and audit-log inspection, and the hardhat regression — is
`RUNNING-GATES.md` §9. The click-through gate below is **pass 2's**, because it
needs the login page and the refactored admin/GN pages.

```
# Custom mode, node running, contracts deployed. MetaMask NOT installed / disconnected.
- /voting/admin redirects to /login; admin logs in; runs full lifecycle:
  create division → set question/candidates → startRegistration → startVoting →
  endElection → resetElection — every action lands on-chain (check /blockexplorer).
- Admin creates GN account for division 0; logout; GN logs in; /gn/register:
  reserveNicHash + addVoters succeed; GN targeting division 1 → 403 (unit + manual).
- Wrong password ×5 → lockout. Relay audit log has one line per action.
- data/gn-accounts.json on disk contains no plaintext private key (grep for "0x" 64-hex).
# Hardhat regression: hardhat env column → admin/GN pages behave exactly as before with
# MetaMask; middleware inert; yarn next build green in both modes.
```
