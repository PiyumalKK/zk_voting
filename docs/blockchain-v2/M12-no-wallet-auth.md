# M12 — No-wallet admin/GN auth + signing relay (custom mode only)

Status: pending · Depends: M11 · Package: `packages/nextjs`
**Read `01-AUTH-DESIGN.md` first — it is the spec. This file adds only sequencing + gates.**

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
