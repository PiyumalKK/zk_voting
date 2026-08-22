# Authentication & Verification Design (Custom-Chain Mode)

> How every actor is authenticated and every action verified once MetaMask is gone.
> Applies **only** when `NEXT_PUBLIC_CHAIN_BACKEND=custom`. Hardhat mode keeps wallet
> connections exactly as today (locked decision). Implemented in M12; voter parts already
> exist and are unchanged.

---

## 1. Principle

On-chain authorization does not change: contracts still check `msg.sender` against
`owner` / `gnOfficer` / the voter allowlist, and votes are still authorized by ZK proof +
nullifier — the chain remains the root of trust. What changes is **who holds the signing
keys and how a human proves they may use them**. MetaMask (user-held keys + browser
extension) is replaced by:

- **Admin & GN officers:** credential login → server-side session → a Next.js **relay**
  that holds their keys and signs whitelisted contract calls on their behalf.
- **Voters (mobile):** nothing changes — keys never were user-visible wallets. Device
  keystore key for registration, throwaway burner for voting, ZK proof for authorization.

---

## 2. Actor/authentication matrix

| Actor | Authenticates by | Key custody | Signs txs | On-chain check |
|---|---|---|---|---|
| Election admin | username + bcrypt password → iron-session cookie (httpOnly, SameSite=Strict, 8 h TTL) | `ADMIN_RELAY_PRIVATE_KEY` in server env — must be the contracts' `owner` account | Relay (server) | `Ownable.onlyOwner` |
| GN officer | per-officer username + bcrypt password → iron-session cookie carrying `{role:"gn", divisionId}` | Per-GN keypair generated server-side at account creation; private key AES-256-GCM-encrypted at rest (`GN_KEY_ENCRYPTION_KEY`), file `packages/nextjs/data/gn-accounts.json` (gitignored) | Relay (server) | `onlyOwnerOrGN` — GN address bound on-chain via `setGNOfficer()` |
| Voter — registration | In person: GN verifies NIC + face; digitally: OTP on phone (`/api/otp/*`) + device biometric gating the keystore | Secp256k1 key in hardware keystore (`packages/mobile/src/services/keystore.ts`); never leaves device | Voter device (direct RPC) | `register()` requires `msg.sender` on the division allowlist (`addVoters` by GN) **and** `NicRegistry.commitDevice` — the device must still be the live one bound to its NIC, and that NIC must not already have a leaf |
| Voter — voting | ZK proof of Merkle membership; biometric unlocks secret/nullifier | Fresh random burner key per vote, discarded after | Voter device (direct RPC) | `vote()` verifies UltraHonk proof, root freshness, unused nullifier. `msg.sender` is meaningless by design (anonymity) |
| Observer / public | none (read-only) | — | — | — reads via `/api/election`, results/audit pages |
| Replica nodes | mTLS client certs (P2P) | `certs/` per node | — | Re-execute blocks; reject state-root mismatch |

Free gas (chain accepts `gasPrice=0`) is what makes voter self-signing workable without a
faucet or paymaster: an unfunded burner can submit `vote()` directly.

---

## 3. Components (M12 builds these)

```
packages/nextjs/
├── middleware.ts                      # guards /voting/admin, /gn/** , /api/relay/** (custom mode only)
├── app/login/page.tsx                 # single login page, role inferred from account store
├── app/api/auth/{login,logout,session}/route.ts   # iron-session; bcrypt verify; rate-limited (5/min/IP)
├── app/api/relay/route.ts             # THE signer — see §4
├── app/api/gn-accounts/route.ts       # admin-session-only CRUD for GN accounts
├── services/auth/{session.ts,accounts.ts,crypto.ts}  # session config, account store, AES-GCM keystore
└── hooks/useElectionWriter.ts         # ONE seam: hardhat → wagmi walletClient (unchanged);
                                       # custom  → POST /api/relay
```

Admin/GN pages call `useElectionWriter()` instead of `walletClient.writeContract` directly;
in hardhat mode it returns the existing wagmi path byte-for-byte, so MetaMask behavior is
untouched.

---

## 4. The relay (`POST /api/relay`)

Request: `{ target: "0x…", fn: "startVoting", args: [3600] }`. Steps, in order:

1. Session check (iron-session cookie) → role + divisionId. 401 otherwise.
2. **Whitelist check** — the only functions the relay will ever sign:
   - role `admin` → `Voting`: `setQuestion, setCandidates, startRegistration, startVoting,
     endElection, resetElection, setGNOfficer` · `ElectionRegistry`: `createDivision,
     addDivision, updateDivision` · `NicRegistry`: `setVotingContract`, `setStrictEnrolment`
   - role `gn` → `Voting`: `addVoters` · `NicRegistry`: `reserveNicHash`, `reissueDevice`
     — **and** `target` must equal the GN's own division contract (looked up from the
     registry, not trusted from the client). 403 otherwise.
3. Encode calldata with viem using the ABI from `deployedContracts.ts` (never a
   client-supplied ABI).
4. Sign with the role's key, `eth_sendRawTransaction` to `RPC_URL`, wait for receipt.
5. Append JSONL audit record `{ts, role, username, target, fn, args, txHash, status}` to
   `data/relay-audit.log`.
6. Return `{ txHash, blockNumber, status }`; on revert, forward the decoded custom error
   name so existing UI error matching keeps working.

Rate limit: 30 relay calls/min per session. The relay never signs `register`, `vote`, or
value transfers — voter txs must not pass through the server (anonymity + trust boundary).

**`addVoters` is GN-only, deliberately.** The contract itself would accept it from the
owner (`onlyOwnerOrGN`), and the admin panel offers a bulk-allowlist section in hardhat
mode for exactly that reason. The relay does not sign it for the `admin` role, because
allowlisting an address without the paired `reserveNicHash` call skips the duplicate-NIC
check that the enrolment flow exists to enforce. In custom mode the admin panel therefore
renders that section as a pointer to the GN portal rather than a form (M12 pass 2).

---

## 5. Voter verification chain (unchanged, restated end-to-end)

1. **Enrollment (in person):** GN verifies physical NIC + face → scans the voter app's QR
   (device address) → `reserveNicHash(hash(NIC), division, device)` blocks duplicate NICs
   without storing the NIC, **and binds that device to the NIC** → `addVoters([addr],[true])`
   allowlists the device address for that division.
1a. **Re-issue (lost or broken phone, before registering):** GN scans the new device →
   `reissueDevice(hash(NIC), division, newDevice)` marks the old device `Superseded` in the
   same write that binds the new one. Refused outright once the NIC has a leaf in the tree.
   See §5a.
2. **Registration (in app):** OTP verifies phone possession → biometric unlocks keystore →
   device signs `register(commitment)` where `commitment = poseidon(nullifier, secret)`;
   secrets never leave the device. `register()` calls `NicRegistry.commitDevice`, which
   refuses a superseded device and spends the NIC's one and only registration; the contract
   then inserts the commitment into the LeanIMT.
3. **Voting (in app):** biometric → build Merkle path (`/api/merkle-path`, public data) →
   generate UltraHonk proof in WebView → fresh burner signs `vote(proof, nullifierHash,
   root, vote, depth)` at `gasPrice=0`. Identity link: none (burner + ZK).
4. **Verification (anyone):** `isNullifierUsed()` + `VoteCast` logs (`/api/verify-vote`,
   audit page); M09's replay tool re-executes the full chain, and replicas independently
   confirm every state root.

What each mechanism defends: OTP → remote device theft; biometric+keystore → local device
theft; NIC hash registry → duplicate enrollment; device binding + supersession → double
registration via a falsely claimed device loss; allowlist → non-citizen registration; ZK
proof + nullifier → vote forgery and double voting; burner + free gas → deanonymization via
sender or funding trail; audit replay + replicas → sequencer tampering with history.

---

## 5a. Device loss, and why the registry owns it

The policy, in two lines:

- Lost **before** registering → the voter is issued a new device and may still vote.
- Lost **after** registering → the vote is gone. Their commitment is already an anonymous
  leaf; nothing on chain can identify it in order to reassign it.

The case that shapes the design is neither of those. It is a voter who enrols, deliberately
does *not* register, claims a false loss, is issued a second device, and registers both.
Two leaves, two nullifiers, two votes — and **no downstream layer can catch it**: Merkle
leaves are unlinkable by construction and `vote()` only checks that a nullifier is fresh.
Enforcement has to happen at enrolment or nowhere.

`NicRegistry` therefore holds the binding, not the GN's workflow:

| State | Meaning | May register? |
|---|---|---|
| `Unbound` | no NIC bound to this address | yes, if allowlisted (bulk `addVoters` path) — unless strict mode is on |
| `Live` | the device currently issued for a NIC | yes, once |
| `Superseded` | replaced by a `reissueDevice` | **never**, in this epoch |

`reissueDevice` supersedes the old device and binds the new one **in a single state
change**, and `register()` cannot be reached without passing `commitDevice`. So the old
phone dies whether or not anyone remembers to revoke it from the allowlist — the GN portal
does send `addVoters([old,new],[false,true])`, but that is hygiene, not the mechanism. A
dropped transaction, a modified client or a careless officer cannot produce two live
devices for one citizen.

Three supporting rules, each closing a specific gap:

- **Same-division only.** A re-issue must name the division that enrolled the NIC.
  Otherwise the old device stays live on division A's allowlist while the new one enrols on
  division B, and neither `Voting` contract ever sees a conflict.
- **Capped and logged.** `MAX_REISSUES = 3` per NIC for a GN; the Election Authority can
  override. Every replacement emits `DeviceReissued(nicHash, old, new, issueCount)` — a
  false loss claim is already harmless, but this makes a pattern of them *visible*.
- **Epoch pinning.** `clearNicHashes()` resets the whole ledger, which would make every
  superseded device `Unbound` again. `Voting` pins the registry epoch at
  `startRegistration()` and refuses to register if it moves, so clearing mid-election halts
  that division instead of silently reviving replaced phones. Reset divisions *first*, then
  clear.

**Strict mode.** `Unbound` is the last route to two leaves for one person, and only a
*colluding officer* can take it: enrol the citizen properly, then allowlist a second address
with `addVoters` and never tell the registry, so there is nothing for supersession to
supersede. That officer can already enrol wholly fictitious voters, so it adds nothing to
their power — which is why `setStrictEnrolment` defaults to **off**, keeping the bulk
allowlist, the e2e scripts and the demo fixtures working. Turn it on for a real election:
enrolment then has exactly one route and the guarantee holds against the officers too. It
only ever refuses more, so it is safe to enable mid-election.

**Privacy.** `nicHash` is an HMAC under a server-held pepper (`services/nic/nicHash.ts`), so
it is not computable from a NIC by anyone reading the chain. Storage does link a nicHash to
its device address — unavoidable, since the officer has no other way to learn the address of
a phone the voter no longer has. Routine events (`NicHashReserved`, `NicHashCommitted`) stay
address-free; `DeviceReissued` carries both addresses deliberately, because a re-issue is
the exceptional event an auditor needs to see.

---

## 6. Threat notes & accepted FYP-scope limits

| Threat | Mitigation | Residual (document in report) |
|---|---|---|
| Relay/server compromise | Whitelist + rate limit + audit log; keys encrypted at rest; admin key only in server env | A compromised server can run admin lifecycle actions — but still cannot forge votes (needs ZK proof) or double-vote (nullifier). Production: HSM/vault + TOTP 2FA |
| GN credential theft | bcrypt, lockout after 5 failures (15 min), per-division scoping | Rogue GN can enroll fake voters — same trust as the physical process; mitigated by enrollment audit logs. They **cannot** give one real citizen two registrations: `NicRegistry` supersession is a contract rule, not a procedure they carry out |
| OTP provider is a mock | `OtpProvider` interface already exists; swap to Firebase/Twilio (TODO.md item) | Dev OTP code is predictable — custom-mode demo only |
| Session hijack | httpOnly + SameSite=Strict cookie, HTTPS in prod, short TTL | — |
| Sequencer censorship (drops txs) | Replicas + audit replay make *tampering* evident; censorship is detectable by clients (tx never mined) | Single sequencer is a liveness single-point — accepted for 3-node permissioned topology |
| RPC DoS | Node rate limiting (M04), `eth_getLogs` range caps, Vercel/edge limits on API routes | — |
