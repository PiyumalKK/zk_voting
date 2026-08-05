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
| Voter — registration | In person: GN verifies NIC + face; digitally: OTP on phone (`/api/otp/*`) + device biometric gating the keystore | Secp256k1 key in hardware keystore (`packages/mobile/src/services/keystore.ts`); never leaves device | Voter device (direct RPC) | `register()` requires `msg.sender` on the division allowlist (`addVoters` by GN) + NIC-hash uniqueness (`NicRegistry.reserveNicHash`) |
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
     addDivision, updateDivision` · `NicRegistry`: `setVotingContract`
   - role `gn` → `Voting`: `addVoters` · `NicRegistry`: `reserveNicHash` — **and** `target`
     must equal the GN's own division contract (looked up from the registry, not trusted
     from the client). 403 otherwise.
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
   (device address) → `reserveNicHash(poseidon(NIC))` blocks duplicate NICs without storing
   the NIC → `addVoters([addr],[true])` allowlists the device address for that division.
2. **Registration (in app):** OTP verifies phone possession → biometric unlocks keystore →
   device signs `register(commitment)` where `commitment = poseidon(nullifier, secret)`;
   secrets never leave the device. Contract inserts the commitment into the LeanIMT.
3. **Voting (in app):** biometric → build Merkle path (`/api/merkle-path`, public data) →
   generate UltraHonk proof in WebView → fresh burner signs `vote(proof, nullifierHash,
   root, vote, depth)` at `gasPrice=0`. Identity link: none (burner + ZK).
4. **Verification (anyone):** `isNullifierUsed()` + `VoteCast` logs (`/api/verify-vote`,
   audit page); M09's replay tool re-executes the full chain, and replicas independently
   confirm every state root.

What each mechanism defends: OTP → remote device theft; biometric+keystore → local device
theft; NIC hash registry → duplicate enrollment; allowlist → non-citizen registration; ZK
proof + nullifier → vote forgery and double voting; burner + free gas → deanonymization via
sender or funding trail; audit replay + replicas → sequencer tampering with history.

---

## 6. Threat notes & accepted FYP-scope limits

| Threat | Mitigation | Residual (document in report) |
|---|---|---|
| Relay/server compromise | Whitelist + rate limit + audit log; keys encrypted at rest; admin key only in server env | A compromised server can run admin lifecycle actions — but still cannot forge votes (needs ZK proof) or double-vote (nullifier). Production: HSM/vault + TOTP 2FA |
| GN credential theft | bcrypt, lockout after 5 failures (15 min), per-division scoping | Rogue GN can enroll fake voters — same trust as the physical process; mitigated by enrollment audit logs |
| OTP provider is a mock | `OtpProvider` interface already exists; swap to Firebase/Twilio (TODO.md item) | Dev OTP code is predictable — custom-mode demo only |
| Session hijack | httpOnly + SameSite=Strict cookie, HTTPS in prod, short TTL | — |
| Sequencer censorship (drops txs) | Replicas + audit replay make *tampering* evident; censorship is detectable by clients (tx never mined) | Single sequencer is a liveness single-point — accepted for 3-node permissioned topology |
| RPC DoS | Node rate limiting (M04), `eth_getLogs` range caps, Vercel/edge limits on API routes | — |
