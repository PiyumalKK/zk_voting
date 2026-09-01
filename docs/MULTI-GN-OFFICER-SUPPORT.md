# Multi-GN-officer support

**Date:** 2026-09-01
**Status:** Implemented, tested, deployed to the local custom chain.

## The problem

A Grama Niladhari (GN) division can have more than one officer (shift
coverage, backup officers). But `Voting.sol` stored the division's GN officer
as a single address (`address public s_gnOfficer`). Creating a second officer
account for a division called `setGNOfficer` again, which silently
**overwrote** the first officer's on-chain binding — the second-created
officer always ended up as the only one who could actually sign
(`addVoters`, `reserveNicHash`, `reissueDevice`), while the first officer's
account still existed with valid credentials but no on-chain authority. The
admin panel gave no indication this had happened.

An intermediate fix made the app refuse the second `setGNOfficer` call and
report *why* — honest, but it capped divisions at one officer, which is not
what the application is supposed to support. This document describes the
real fix: the contract itself now tracks a **set** of GN officers per
division, not a single slot.

## Root cause

`Voting.sol` (`packages/hardhat/contracts/Voting.sol`):

```solidity
address public s_gnOfficer;                       // one slot
function setGNOfficer(address _gnOfficer) external onlyOwner {
    s_gnOfficer = _gnOfficer;                      // overwrites, doesn't add
}
```

`NicRegistry.sol` also depended on this single slot cross-contract, to check
whether a caller is the GN officer of the division they're acting on:

```solidity
interface IVotingGN {
    function s_gnOfficer() external view returns (address);
}
require(msg.sender == owner() || msg.sender == IVotingGN(votingContract).s_gnOfficer(), ...);
```

Three separate places in the app (server, two different client hooks) each
independently read this one address and treated it as "the" officer.

## The fix

### Contracts

**`Voting.sol`**
- `address public s_gnOfficer` → `mapping(address => bool) public s_isGnOfficer` plus a private `address[] s_gnOfficerList` (a mapping can't be enumerated, and the admin UI needs to list officers).
- `setGNOfficer(address)` → `setGNOfficer(address _gnOfficer, bool _isOfficer)` — adds or removes one officer without touching any other. No-ops if the officer is already in the requested state (keeps the list free of duplicates).
- New `getGNOfficers() view returns (address[])`.
- `onlyOwnerOrGN` modifier now checks `s_isGnOfficer[msg.sender]` instead of `msg.sender == s_gnOfficer`.
- `event GNOfficerUpdated(address indexed gnOfficer)` → `event GNOfficerUpdated(address indexed gnOfficer, bool isOfficer)`.

**`NicRegistry.sol`**
- `IVotingGN` interface: `s_gnOfficer() returns (address)` → `s_isGnOfficer(address) returns (bool)` (a Solidity public mapping auto-generates this exact getter signature, so no new function was needed on the `Voting` side beyond making the mapping public).
- The `onlyOwnerOrGN(votingContract)` modifier's cross-contract check now asks "is this caller a GN officer" instead of comparing against a single address.

This is a genuine on-chain interface change, not a UI workaround. It requires
a full contract redeploy (`yarn deploy --network custom --reset`), which
also wipes chain state — expected and unavoidable for a Solidity storage
layout change.

### Everywhere that read or wrote "the GN officer"

Every consumer of the old single-address model was found (via full-repo
grep, not assumption) and updated to work with a list/membership check
instead of an equality check:

| File | What changed |
|---|---|
| `services/auth/relayContracts.ts` | `DivisionSummary.gnOfficer: address` → `gnOfficers: address[]`. Reads `getGNOfficers()` instead of `s_gnOfficer()`. |
| `services/auth/relayExecutor.ts` | **Security-sensitive.** The relay's own authorization gate — decides whether a GN's signed request is allowed to execute at all. Changed from address equality to `division.gnOfficers.some(...)`. |
| `services/auth/nicHashAuth.ts` | **Security-sensitive.** Gates `/api/nic/hash` (NIC hashing for enrolment). Same equality → membership change. |
| `services/auth/gnAccountCreation.ts` | Removed the interim "refuse a second officer" guard — creating an officer account now always adds them via `setGNOfficer(address, true)`, since adding no longer displaces anyone. |
| `hooks/useDivisions.ts` | `LiveDivision.gnOfficer: string` → `gnOfficers: string[]`. Client-side live read now calls `getGNOfficers()`. |
| `utils/gnDivision.ts` | `findDivisionForGN` (hardhat-mode: "which division is this wallet the GN for") now checks membership across `gnOfficers` instead of equality. |
| `app/api/nic/hash/route.ts` | Hardhat-mode wallet-signature path (`isAuthorizedGn`) — flattens each division's officer list and checks membership, instead of comparing against one address per division. |
| `app/api/election/route.ts` | Public API consumed by the mobile app. Added `gnOfficers: string[]`; **kept** `gnOfficer` (first officer, or the zero address) for backward compatibility — the mobile app's type declares this field, so nothing there needed to change. |
| `app/voting/admin/_components/GnAccountsSection.tsx` | "Is this credential account's address currently bound on-chain" badge now checks membership. |
| `app/voting/admin/_components/GNManagementSection.tsx` | The manual assign/override panel now shows every officer per division (not just one), added a **Remove** action per officer (`setGNOfficer(address, false)`), and the "orphaned / unassigned" division warnings are computed across the whole officer list. |
| `app/voting/admin/_components/DivisionsListSection.tsx` | "GN Officer" column shows a count (`"N officers"`) when there's more than one, instead of assuming a single address. |
| `app/voting/admin/_components/adminContracts.ts` | `SET_GN_OFFICER_ABI` updated to the two-argument signature. |
| `app/gn/page.tsx` | The "not authorized" screen's officer listing now shows every officer per division. |
| `deploy/01_deploy_divisions.ts` | Hardhat-mode auto-assignment and the custom-mode "already staffed" log message updated for the new signature/list return. |
| `blockchain/e2e/election.mjs` | The M14 acceptance-gate script's `setGNOfficer` call and officer-assignment check updated to the new signature. |

### What was deliberately left untouched

- `ElectionRegistry.sol`'s own `Division.gnOfficer` field — already documented as a stale, unused copy (the code has never trusted it; the Voting contract's own storage is and always was the authority). No behavior depends on it, so it wasn't worth another contract change.
- `utils/divisions.ts` — an already-dead, explicitly-marked "NOT the source of truth" static fallback file with no importers anywhere in the app. Confirmed unused via grep before leaving it alone.
- `app/gn/register/page.tsx`'s local `s_gnOfficer` ABI entry — declared but never actually called (dead code); leaving it doesn't affect behavior.
- The mobile app (`packages/mobile`) — its `services/api.ts` only declares a `gnOfficer: string` type field and never branches on it, and the public API still serves that field, so nothing needed to change there.

## Testing performed

- **`packages/hardhat` test suite: 101/101 passing.** Added new cases for multi-officer assignment, independent removal, and confirmed existing single-officer flows (GN add-voters authorization, NicRegistry enrolment, ElectionRegistry) are unaffected.
- **`packages/nextjs` — `tsc --noEmit`: clean** (one pre-existing, unrelated error about a missing `prismjs` type declaration, present before this work).
- **`packages/nextjs` — `vitest run`: 411/415 passing.** The 4 failures are in `app/voting/admin/page.test.tsx` and were confirmed **pre-existing**: reverting every change from this session via `git stash` and re-running the exact same tests reproduced the identical failures against the original code. Root cause is unrelated to GN officers — those tests mock admin auth as `mode: "custom"`, but `GNManagementSection` (the component they're asserting against) is only rendered in hardhat mode (`{!isCustom && <GNManagementSection />}` in `app/voting/admin/divisions/page.tsx`), so the heading they wait for can never appear. Not touched, since it's a pre-existing bug outside this task's scope — flagging it here rather than silently leaving it.
- **Live chain verification:** wrote a standalone script that called the freshly deployed `Voting` contract directly (bypassing the app entirely) to add two officers to the same division and confirmed both remained bound (`getGNOfficers()` returned both addresses after each addition, neither displaced the other).
- **Real-world confirmation:** after redeploying, your own bulk-import testing against the running app assigned two officers to Kaduwela via the identity-management-server import, and `/api/election` now reports both addresses in `gnOfficers` for that division.

## Operational notes

- This required a full chain wipe + redeploy (`packages/blockchain/data` and `packages/nextjs/data` cleared, then `yarn deploy --network custom --reset`) — a Solidity storage-layout change can't be applied to an already-deployed contract.
- To remove a wrongly-added officer, use **GN Officer Management → Remove** next to their address (admin, hardhat-mode panel) — this calls `setGNOfficer(address, false)`.
- Creating a GN officer account (Admin → Divisions → GN Officer Accounts, single or bulk) now always succeeds in binding that officer on-chain, alongside any officers already assigned to the same division.

## Related, earlier fixes from this session

- **Identity mock server copy button** (`packages/identity-mock-server/public/api.html`): `navigator.clipboard.writeText` had no fallback, so it failed silently when the Clipboard API was unavailable (e.g. the page opened via a LAN IP instead of `localhost`, which isn't a secure context). Added an `execCommand('copy')` fallback with a toast on failure.
- **Admin password reset**: generated a new admin password and its bcrypt hash, updated `packages/nextjs/.env.local`'s `ADMIN_PASSWORD_HASH` (with `$` escaped as required by Next.js's env loader), and restarted the web app to pick it up. The previous password was never known to this session — only its hash existed.
