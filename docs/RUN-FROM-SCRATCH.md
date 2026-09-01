# Running ZK Voting from scratch (custom chain mode)

A complete runbook: wipe all previous state, rebuild the node, redeploy contracts,
generate your own credentials, and bring up the web app and mobile app.

Prerequisites (already verified working): Go 1.25+, Node.js ≥ 20.18.3, Yarn 4.13.0.
This machine has no `make` — the raw commands below are used instead of `make run`.

---

## Part 0 — Wipe every trace of previous state

```powershell
# Blockchain chain data
Remove-Item -Recurse -Force D:\Projects\FYP\zk_voting\packages\blockchain\data -ErrorAction SilentlyContinue

# Server-side stores this app keeps outside the chain (GN accounts, voter
# enrolment invites, relay audit log) — these persist independently and would
# otherwise leave old test divisions/officers visible after redeploying
Remove-Item -Recurse -Force D:\Projects\FYP\zk_voting\packages\nextjs\data -ErrorAction SilentlyContinue
```

## Part 1 — Terminal 1: build and start the blockchain node

```powershell
cd D:\Projects\FYP\zk_voting\packages\blockchain
go build -o bin\zk-blockchain-node.exe .\cmd\node
.\bin\zk-blockchain-node.exe
```

Wait for a `listening addr=:9545` line. **Leave this terminal running** for the
whole session.

## Part 2 — Terminal 2: deploy the contracts

```powershell
cd D:\Projects\FYP\zk_voting
yarn deploy --network custom --reset
```

`--reset` is required — the chain is brand-new, but
`packages\hardhat\deployments\custom\` still remembers old addresses without it.
This prints the new contract addresses and regenerates
`packages\nextjs\contracts\deployedContracts.ts` automatically.

## Part 3 — Generate your own credentials (still Terminal 2)

**Session secret:**
```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Admin password hash** — pick your own password and run this from
`packages\nextjs` (needs `bcryptjs` from `node_modules`):
```powershell
cd D:\Projects\FYP\zk_voting\packages\nextjs
node -e 'import("bcryptjs").then(b=>b.hash(process.argv[1],12)).then(h=>console.log(h))' "your-password-here"
```

This prints the raw hash. **When you paste it into `.env.local`, manually
replace every `$` with `\$`** — Next.js's env loader treats a bare `$` as a
reference to another variable and silently mangles the hash into an empty
string otherwise. (This exact mistake is what causes the "Admin login is not
configured on this server" error.)

**GN key-encryption key:**
```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Enrolment-link signing secret** (for the bulk voter self-enrolment feature):
```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Part 4 — Edit `packages\nextjs\.env.local`

Set these (create the file from `.env.example` if it doesn't exist):

```
NEXT_PUBLIC_CHAIN_BACKEND=custom
NEXT_PUBLIC_CHAIN_ID=9494
NEXT_PUBLIC_RPC_URL=http://127.0.0.1:9545

SESSION_SECRET="<paste from Part 3, step 1>"
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH="<paste the hash, with every $ escaped as \$>"
ADMIN_RELAY_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
GN_KEY_ENCRYPTION_KEY=<paste from Part 3, step 3>
ENROLMENT_TOKEN_SECRET=<paste from Part 3, step 4>

SERVER_PEPPER=<a long random string — can regenerate the same way, or leave the existing one>
```

`ADMIN_RELAY_PRIVATE_KEY` must be **exactly** that value — it's Hardhat's
well-known test account #0, which is whichever account `yarn deploy` used, so
it's the one that owns every contract (`onlyOwner` checks fail otherwise).
This is a public, well-known dev-only key; never use it for a real deployment.

## Part 5 — Terminal 2: start the web app

```powershell
cd D:\Projects\FYP\zk_voting
yarn start
```

Confirm the printed URL is `http://localhost:3000` (not `:3001` — that would
mean something else is already holding 3000; check with
`netstat -ano | findstr :3000` before continuing).

Sign in at `http://localhost:3000/voting/admin` with `admin` / your chosen
password.

## Part 6 — Terminal 3: mobile app

Find your PC's LAN IP:
```powershell
ipconfig
```
Look for "IPv4 Address" under your active Wi-Fi adapter (e.g. `192.168.1.23`).

Create/edit `packages\mobile\.env`:
```
EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:3000
EXPO_PUBLIC_RPC_URL=http://<your-LAN-IP>:9545
EXPO_PUBLIC_CHAIN_ID=9494
```

Start Expo:
```powershell
cd D:\Projects\FYP\zk_voting\packages\mobile
npx expo start
```

Open it on your phone (Expo Go), on the same Wi-Fi network as this PC.

## Part 7 — Run the actual election

From here it's the operator workflow: add a division, set the ballot question
and candidates, create/bulk-import GN officers, open Registration, enrol
voters (or use `docs/gn-officers-import-sample.csv` and
`docs/voter-roll-import-sample.csv` for the bulk-import panels), open Voting,
and so on — that whole sequence is written up in `docs/ELECTION-GUIDE.html`.

That guide is still accurate except for two things: the admin UI now uses
tabs (Operations / Ballot / Divisions) instead of numbered sections, and it
doesn't yet mention the two bulk-import panels on the Divisions tab.
