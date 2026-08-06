# Running the milestone acceptance gates locally

> Written 2026-08-01. Every milestone agent so far has run in a sandbox with **no Go
> toolchain and no network access to install one**, so the Go half of each gate
> (`go vet` / `gofmt` / `go test`) and every check that needs two live nodes has to be
> run on your machine. This file is the missing "how".
>
> Applies to M05 (write path), M06 (`eth_getLogs`), M07 (dev/compat methods),
> M08 (deploy + contract suite), M09 (restart recovery + audit replay),
> M10 (replication — §7), M11 (the Next.js frontend — §8), M12 (no-wallet
> auth — §9, §10), M13 (mobile — §11) and M14 (the full election — §12).
> The setup in §1 does not change between them.
>
> **§8 (M11) is the exception to all of this:** it runs in `packages/nextjs`,
> needs no Go toolchain, and its offline phase needs no running chain at all.
> Start there if you only have a few minutes.

---

## 0. Which shell you are in

Most commands below were originally written for **PowerShell**. If your
prompt looks like `D:\Projects\FYP\zk_voting>` you are in **cmd.exe**, where
the environment-variable syntax is different and PowerShell's cmdlets do not
exist. The translation table:

| Task | PowerShell | cmd.exe |
|---|---|---|
| Set a variable for later commands | `$env:HARDHAT_URL="http://127.0.0.1:8545"` | `set HARDHAT_URL=http://127.0.0.1:8545` |
| Delete a directory tree | `Remove-Item -Recurse -Force <path>` | `rmdir /s /q <path>` |
| Call real curl | `curl.exe …` (bare `curl` is an alias for `Invoke-WebRequest`) | `curl …` |

A variable set with either form lasts only for that terminal session, so it
has to be set again in each new terminal — and in the *same* terminal you
then run `make` from.

If you would rather not think about any of this, run the gates from **Git
Bash** (ships with Git for Windows), where every command below works in its
POSIX form: `HARDHAT_URL=http://127.0.0.1:8545 make diff-dev`.

---

## 1. One-time setup

### 1.1 Go toolchain

`packages/blockchain/go.mod` requires **Go 1.25.0 or newer**.

```powershell
go version        # want: go1.25.x or later
```

If that fails, install from <https://go.dev/dl/> (Windows MSI). Reopen your terminal
afterwards so `PATH` picks it up.

### 1.2 Download the Go dependencies

`go.sum` is committed, so this only downloads — it does not re-resolve versions:

```powershell
cd D:\Projects\FYP\zk_voting\packages\blockchain
go mod download
```

Expect this to take a few minutes the first time (go-ethereum pulls a large dependency
tree). If it reports *missing go.sum entry*, run `go mod tidy` instead — that needs
network access to `proxy.golang.org`.

### 1.3 GNU Make (optional but recommended)

Every gate command below is given twice: as a `make` target and as the raw command it
runs. If you don't have `make` on Windows, use the raw form, or install it with
`winget install ezwinports.make` / `choco install make`.

### 1.4 Node dependencies for the e2e harnesses

```powershell
cd D:\Projects\FYP\zk_voting\packages\blockchain\e2e
npm install
```

**Before the first run, delete the stale nested install** left over from an earlier
layout, or Node will resolve the old copy of viem instead of this one:

```powershell
Remove-Item -Recurse -Force D:\Projects\FYP\zk_voting\packages\blockchain\e2e\diff\node_modules
```

### 1.5 Compile the contracts

`smoke-deploy.mjs` reads real artifacts out of `packages/hardhat/artifacts`:

```powershell
cd D:\Projects\FYP\zk_voting
yarn install          # if you haven't already
yarn compile
```

### 1.6 `packages/blockchain/.env` — delete it

That file is a **leftover from the v1 node** — it sets `NODE_ID`, `PEERS` and
`ALLOWED_ORIGIN`. Through M09 it was merely misleading: v2's `internal/config`
ignored all three.

**From M10 it is actively harmful.** `PEERS` is now what makes a node a
sequencer *with replicas*, so a stale value makes `make run` try to open the
mTLS P2P port, fail to find certificates, and exit. Delete the file, or
replace it with a copy of `.env.example` (which is the current reference):

```
del packages\blockchain\.env
```

---

## 2. M05 gate — write path

Run the two phases in order. Phase A needs nothing running; phase B needs two live nodes.

### Phase A — offline checks

```powershell
cd D:\Projects\FYP\zk_voting\packages\blockchain

make vet            # raw: go vet ./...
make fmt            # raw: gofmt -l .          -> must print NOTHING
make test           # raw: go test ./... -v
make shape-check    # raw: cd e2e && node shape-check.mjs
```

**Expected**

| Command | Pass looks like |
|---|---|
| `make vet` | no output |
| `make fmt` | no output. Any filename listed → run `gofmt -w .`, cosmetic only |
| `make test` | `ok` for `internal/{chain,config,rpc,state,storage}` |
| `make shape-check` | `36/36 checks passed` |

### Phase B — differential checks against a real Hardhat node

You need **three terminals**. Both chains must be freshly reset — several checks compare
address-derived values that only match while the deployer's nonce is identical on both.

**Terminal 1 — our node, fresh chain**

```powershell
cd D:\Projects\FYP\zk_voting\packages\blockchain
make reset          # raw: rmdir /s /q data
make run            # raw: go build -o bin/zk-blockchain-node ./cmd/node && .\bin\zk-blockchain-node
```

Wait for `listening addr=:9545`.

**Terminal 2 — hardhat node, fresh chain**

```powershell
cd D:\Projects\FYP\zk_voting
yarn chain
```

Wait for `Started HTTP and WebSocket JSON-RPC server at http://127.0.0.1:8545`.

**Terminal 3 — the harnesses**

```powershell
cd D:\Projects\FYP\zk_voting\packages\blockchain

$env:HARDHAT_URL="http://127.0.0.1:8545"

make diff           # raw: cd e2e\diff && node diff.mjs     (M04 reads — must stay green)
make diff-write     # raw: cd e2e\diff && node write.mjs    (M05 writes)
make smoke          # raw: cd e2e && node smoke-deploy.mjs  (real Voting stack)
```

**Expected**

- `make diff` — all `[PASS]`. Its two previously-`[SKIP]`ped write-dependent checks
  should now actually run and pass. **A remaining SKIP there is a gate failure**, not a
  pass.
- `make diff-write` — all `[PASS]`, final line `PASS`.
- `make smoke` — deploys `PoseidonT3 → LeanIMT → HonkVerifier → Voting`, registers a
  commitment, prints a Merkle root that is **not** `0x000…0`.

If you re-run any of these, reset **both** chains first (Ctrl+C both nodes, `make reset`,
restart) — otherwise nonces diverge and you'll see false mismatches.

### If something fails

| Symptom | What it means / what to do |
|---|---|
| `make fmt` lists files | Cosmetic. Run `gofmt -w .` (the `-w` form rewrites; `make fmt` only reports), then re-run. Don't hand-edit the alignment — gofmt's rules for multi-line struct values are unintuitive. |
| `TestGetTransactionByHashShape` fails with `have 21000, want 21032` | **Hit and fixed 2026-08-01.** The test sent two bytes of calldata at the bare 21,000 intrinsic-gas floor; non-zero calldata costs 16 gas per byte on top of it. The gas limit is now 30,000. The node was correct to reject the transaction. |
| ~~Build error on `rawdb.ReadTransaction`~~ | **Hit and fixed 2026-08-01.** go-ethereum v1.16.8 removed the composite `rawdb.ReadTransaction` helper (resolving a hash to a transaction needs to know which chain is canonical, which rawdb stopped assuming). `internal/chain/txlookup.go` now does the three steps itself: `ReadTxLookupEntry` → `ReadCanonicalHash` → `ReadBlock`, then scans the body. |
| Build error on any other `rawdb.*` / `types.*` identifier | Same class of problem. The fastest way to resolve it is to paste me the output of `go doc github.com/ethereum/go-ethereum/core/rawdb` (or `.../core/types`) filtered to the relevant name, e.g. `go doc github.com/ethereum/go-ethereum/core/rawdb \| findstr /I lookup`. That lists what the pinned version actually exports, so the fix is one edit rather than a guess. |
| `NewJSONRPCServer` returns `register eth write namespace`, **or** read methods 404 once write methods register | Two receivers under one `eth` namespace didn't merge. The fix is documented inline in `internal/rpc/server.go`: embed `*EthWriteService` in `EthService` and make a single `RegisterName` call. |
| `write.mjs` check (e) fails on error wording | Expected and useful. `mapSubmitError` in `internal/rpc/errors.go` reproduces Hardhat's text **from knowledge, not observation**. Trust the harness — paste its diff to me and I'll correct the strings. |
| `node: cannot find module 'viem'` | The stale `e2e/diff/node_modules` from §1.4, or `npm install` wasn't run in `e2e/`. |
| `smoke` can't find artifacts | `yarn compile` in the repo root first. |
| A `diff` check reports a mismatch you don't understand | Both nodes must be *freshly started*. Reset both and retry before investigating. |

---

## 3. M06 gate — `eth_getLogs`

Same setup. Phase A, then the logs harness.

```powershell
cd D:\Projects\FYP\zk_voting\packages\blockchain
make vet && make fmt && make test

# both nodes freshly reset and running, as in §2 phase B
$env:HARDHAT_URL="http://127.0.0.1:8545"
make diff-logs      # raw: cd e2e\diff && node logs.mjs
```

`make diff-logs` emits an identical event sequence on both chains and diffs every
`eth_getLogs` response field-by-field, then replays the app's three real query shapes
(`NewLeaf` from the merkle-path route, `VoteCast` from verify-vote/audit,
`DivisionCreated` from `useDivisions`) and asserts viem's `parseEventLogs` output is
identical on both. All `[PASS]`, final line `PASS`.

---

## 4. M07 gate — dev/compat methods

Two differences from §2 and §3, both of which make this gate *easier* to run:

- Our node must be started with **`DEV_RPC=true`** (`make run-dev`). Without
  it every method below answers `-32601` — that is the intended production
  behaviour, and `dev.mjs` detects it and exits with an explanatory message
  rather than reporting 20 confusing failures.
- The chains do **not** need to be freshly reset. Every check in `dev.mjs` is
  a delta or a value it writes to a burn address itself, so it is safe to
  re-run against nodes that are already dirty from `make diff-write` or
  `make diff-logs`.

### Phase A — offline checks

```powershell
cd D:\Projects\FYP\zk_voting\packages\blockchain

make vet            # raw: go vet ./...
make fmt            # raw: gofmt -l .          -> must print NOTHING
make test           # raw: go test ./... -v
```

New in M07, worth watching for by name in `make test` output:

| Test | What it proves |
|---|---|
| `TestChainWithSysOpBlocksReplaysToIdenticalRoot` | The determinism gate. Builds a chain mixing transaction blocks, an empty block and two `setBalance` system-op blocks, then rebuilds all state from the stored block list alone and asserts every state root matches. If this fails, M09's audit tool and M10's replicas cannot work — treat it as a hard stop, not a flake. |
| `TestDevMethodsAreUnavailableWithoutDevRPC` | With `DEV_RPC=false` all five methods return `-32601`, and the read surface is unaffected. |
| `TestIncreaseTimeAcceptsBothParameterEncodings` | `evm_increaseTime` accepts a bare JSON number (what `test/Voting.ts` sends) as well as hex/decimal strings. This is the M08 prerequisite. |
| `TestPinnedTimestampSurvivesRevertedTransaction` | A reverting tx mines nothing and so must not consume an `evm_setNextBlockTimestamp` pin. |
| `TestIncreaseTimeReturnsASignedTotalAfterAPinBelowWallClock` and `TestIncreaseTimeReportsANegativeTotalAsNegative` | Regression tests for a bug found during review: the accumulated dev offset goes negative once a block is pinned below wall clock (legal on a fresh chain — genesis is timestamped 0), and `evm_increaseTime` used to wrap that to a 20-digit unsigned number. |

### Phase B — the quick manual check from the milestone spec

**Terminal 1** — the node, with dev methods enabled:

```
cd D:\Projects\FYP\zk_voting\packages\blockchain
make run-dev
```

If `make run-dev` misbehaves for any reason, this is the equivalent without
make (cmd.exe), and it avoids the built-binary path entirely:

```
cd D:\Projects\FYP\zk_voting\packages\blockchain
set DEV_RPC=true
go run ./cmd/node
```

Wait for `listening addr=:9545`.

**Terminal 2**

```powershell
$body = '{"jsonrpc":"2.0","id":1,"method":"evm_increaseTime","params":[3600]}'
curl.exe -s -X POST localhost:9545 -H "content-type: application/json" -d $body

$body = '{"jsonrpc":"2.0","id":1,"method":"hardhat_setBalance","params":["0x000000000000000000000000000000000000dEaD","0xDE0B6B3A7640000"]}'
curl.exe -s -X POST localhost:9545 -H "content-type: application/json" -d $body

$body = '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x000000000000000000000000000000000000dEaD","latest"]}'
curl.exe -s -X POST localhost:9545 -H "content-type: application/json" -d $body
```

**Expected**

| Call | Response |
|---|---|
| `evm_increaseTime` | `{"jsonrpc":"2.0","id":1,"result":"3600"}` — a **decimal** string, not `"0xe10"`. Hardhat's documented exception to the hex convention. |
| `hardhat_setBalance` | `{"jsonrpc":"2.0","id":1,"result":true}` |
| `eth_getBalance` | `{"jsonrpc":"2.0","id":1,"result":"0xde0b6b3a7640000"}` |

Use `curl.exe`, not `curl` — in PowerShell the bare name is an alias for
`Invoke-WebRequest`, which does not take `-X`/`-d`.

Optionally confirm the mutation really landed in a block:

```powershell
$body = '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["latest",false]}'
curl.exe -s -X POST localhost:9545 -H "content-type: application/json" -d $body
```

`extraData` should decode from hex to
`sysop:setBalance:0x000000000000000000000000000000000000dEaD:0xde0b6b3a7640000`.

### Phase C — differential check against a real Hardhat node

**Terminal 1** — our node with dev methods on (leave it running from phase B):

```powershell
cd D:\Projects\FYP\zk_voting\packages\blockchain
make run-dev
```

**Terminal 2** — hardhat node:

```powershell
cd D:\Projects\FYP\zk_voting
yarn chain
```

**Terminal 3** — cmd.exe:

```
cd D:\Projects\FYP\zk_voting\packages\blockchain
set HARDHAT_URL=http://127.0.0.1:8545
make diff-dev
```

or PowerShell:

```powershell
cd D:\Projects\FYP\zk_voting\packages\blockchain
$env:HARDHAT_URL="http://127.0.0.1:8545"
make diff-dev       # raw: cd e2e\diff && node dev.mjs
```

All `[PASS]`, final line `PASS`.

`dev.mjs` exists because Hardhat encodes these four methods' return values
inconsistently — two decimal strings, one hex quantity, one boolean — and
`internal/rpc/dev.go` reproduces that from knowledge of Hardhat's source
rather than from observation. **The harness is authoritative over the code.**
Every failure prints an `our=… hardhat=…` pair; that pair is the fix
instruction.

### If something fails

| Symptom | What it means / what to do |
|---|---|
| `dev.mjs` exits saying "running without DEV_RPC=true" | Start the node with `make run-dev`, not `make run`. |
| `HARDHAT_URL is required` even though you set it | The variable was set in a different terminal, or with PowerShell syntax inside cmd.exe. See §0 — in cmd.exe it is `set HARDHAT_URL=http://127.0.0.1:8545`, with no `$env:` and no quotes, in the same window you then run `make` from. |
| `'.' is not recognized as an internal or external command` | **Hit and fixed 2026-08-01.** The `run`/`run-dev` recipes used a `./bin/...` path, which cmd.exe parses as the command `.` followed by switches. The Makefile now selects `bin\zk-blockchain-node.exe` on Windows and `./bin/zk-blockchain-node` elsewhere. If you still see it, use the `go run ./cmd/node` form above. |
| Check (a)/(f) fails on *encoding* (`decimal-string` vs `hex-quantity-string`) | My reading of Hardhat's return convention was wrong for that method. Paste the line; the fix is one `strconv.FormatInt` ⇄ `hexutil` swap in `internal/rpc/dev.go`. |
| Check (b) "accepts a bare JSON number" fails on our side | `devUint64.UnmarshalJSON` is rejecting the form `test/Voting.ts` sends. This blocks M08 — send me the error object. |
| ~~Check (c) `our delta=1s hardhat delta=86400s`~~ | **Hit and fixed 2026-08-01.** A real bug, and the one this harness most earned its keep on. Your `data/` directory persists between runs, so the head was hours ahead of wall clock; `nextTimestamp`'s `parent+1` floor then swallowed the whole time jump. `IncreaseTime` now floors its offset against the head, so the jump is effective regardless of where the head sits. Hardhat never shows this — its chain is in-memory and always fresh. |
| ~~Check (d) `evm_mine` return value differs~~ | **Hit and fixed 2026-08-01.** Hardhat returns `"0"`, not the hex quantity `"0x0"` I had guessed. All three `evm_` methods return decimal. |
| ~~Harness crashes on `anvil_setBalance`~~ | **Hit and fixed 2026-08-01.** Hardhat does not implement `anvil_setBalance` at all, so it can't be a two-sided diff; check (i) is now a one-sided assertion against our node, and a crash in any one group no longer aborts the run. |
| A `[PASS]` that says `both false` or `both 0` | **This used to be possible and is now a failure.** Two backends that are broken the same way agree perfectly, so verdict-style checks state the value they expect (`compareExpecting`) instead of only comparing the two. If you see a pass whose detail looks wrong, tell me — that is a harness bug, not a node bug. |
| Check (g) passes on hardhat but not on us (or vice versa) | The two backends disagree about whether a non-increasing `evm_setNextBlockTimestamp` is an error. Ours rejects it deliberately (MASTER §10 pitfall 7); if Hardhat *accepts* it, tell me and I'll reconcile rather than guess. |
| `TestChainWithSysOpBlocksReplaysToIdenticalRoot` fails | Something in the sealing path depends on sequencer-local state that never reaches the header. Send the failing block number and the two roots from the message. |
| Build error on `StateDB.SetBalance` | Version-sensitive go-ethereum identifier, flagged inline in `internal/chain/sysop.go`'s `ApplySysOp`. Check the real signature in `$(go env GOMODCACHE)\github.com\ethereum\go-ethereum@v1.16.8\core\state\statedb.go` and tell me. |

---

## 5. M08 phase 1 gate — `yarn deploy --network custom`

### 5.1 Read this first: deploy order matters

`packages/nextjs/contracts/deployedContracts.ts` is **committed to git**, but
it is **generated** from `packages/hardhat/deployments/`, which is
**gitignored**. `scripts/generateTsAbis.ts` rebuilds the whole file from
whatever chain folders exist there — so deploying to a chain while another
chain's folder is missing silently drops that chain's entry.

Right now `packages/hardhat/deployments/` is empty while `deployedContracts.ts`
holds a `31337` entry. Deploying straight to custom would therefore leave you
with a `9494`-only file and no Hardhat entry, breaking MASTER §8's promise
that switching modes needs no redeploy of the other side.

**So: deploy to localhost first, custom second.** After both folders exist,
every later regeneration emits both entries and order stops mattering. The
addresses are deterministic (same mnemonic, same nonce sequence), so the
regenerated `31337` entry should match what is already committed.

### 5.2 Recreate the Hardhat deployment

`yarn deploy` with no `--network` uses `defaultNetwork: "localhost"`, so a
`hardhat node` must already be listening on 8545 — otherwise it stops with
`Error HH108: Cannot connect to the network localhost`.

**Terminal 1** — leave this running:

```
cd /d D:\Projects\FYP\zk_voting
yarn chain
```

Wait for `Started HTTP and WebSocket JSON-RPC server at http://127.0.0.1:8545`.

**Terminal 2**

```
cd /d D:\Projects\FYP\zk_voting
yarn compile
yarn deploy
```

`yarn compile` reports the EVM target it built for, e.g.
`Compiled 2 Solidity files successfully (evm target: paris)`. Worth reading:
Hardhat pins `paris` by default for solc ≥ 0.8.20, which is three forks below
Cancun and well below the Prague this chain activates — which is why M08
does **not** pin `evmVersion: "cancun"`. If that line ever says `prague` or
newer after a toolchain bump, revisit the decision recorded in
`M08-deploy-integration.md`.

Then confirm the folder exists and `31337` is still present:

```
dir packages\hardhat\deployments\localhost
git diff --stat packages/nextjs/contracts/deployedContracts.ts
```

A large diff here is a warning sign — the addresses should be unchanged.

### 5.3 Deploy to the custom chain

**Terminal 3** — a *fresh* node. Reset first: the deploy scripts assume the
deployer's nonce starts at 0, and `01_deploy_divisions.ts` creates divisions
that would otherwise already exist.

```
cd /d D:\Projects\FYP\zk_voting\packages\blockchain
make reset
make run-dev
```

**Terminal 2**

```
cd /d D:\Projects\FYP\zk_voting
yarn deploy --network custom
```

**Expected**

| Step | Pass looks like |
|---|---|
| `00_deploy_your_contract.ts` | PoseidonT3, LeanIMT, HonkVerifier, ElectionRegistry, NicRegistry deployed |
| `01_deploy_divisions.ts` | three divisions created, each deploying a `Voting` contract at runtime |
| `generateTsAbis` | `📝 Updated TypeScript contract definition file` |
| `git diff packages/nextjs/contracts/deployedContracts.ts` | a `9494:` block **added**, the `31337:` block still present |

### 5.4 Size guard

```
cd /d D:\Projects\FYP\zk_voting\packages\blockchain
node e2e\smoke-deploy.mjs
```

Every `[PASS] deploy …` line now reports EIP-170 headroom, and any contract
over 24,576 bytes fails by name. HonkVerifier was 21,635 bytes at last
measurement — note what it reports, since that number is the one MASTER §2
depends on.

### If something fails

| Symptom | What it means / what to do |
|---|---|
| `🚫️ You don't have a deployer account` | **Fixed 2026-08-01**, but if it reappears: `runHardhatDeployWithPK.ts` only skips the encrypted-key prompt for networks in its `LOCAL_NETWORKS` set. `custom` was added there. |
| `could not detect network` / `ECONNREFUSED 9545` | The Go node isn't running, or `CUSTOM_RPC_URL` points elsewhere. |
| `invalid chainId` on every transaction | The node's `CHAIN_ID` and `hardhat.config.ts`'s `custom.chainId` disagree. Both default to 9494. |
| `nonce too high` mid-deploy | The chain isn't fresh. `make reset`, restart, redeploy. |
| `31337` vanished from `deployedContracts.ts` | §5.1. Recreate `deployments/localhost` with `yarn deploy` against a running `yarn chain`, then redeploy custom. `git checkout` the file first if you want the committed version back. |
| A contract exceeds EIP-170 | Contracts grew past the 24,576-byte limit. This is a contract problem, not a node problem — tell me the name and size. |

---

## 5.5 M08 phase 2 gate — the contract test suite on the node

**Do NOT `make reset` first.** This reverses the precaution taken for phase 1,
and the reversal is deliberate: reading the suite shows every test is
self-contained. All three files use `beforeEach` to redeploy PoseidonT3 →
LeanIMT → HonkVerifier → Voting from scratch, and each `Voting` sets its phase
deadlines relative to the *current* block timestamp, so neither leftover
contracts nor an accumulated `evm_increaseTime` offset can affect a later run.
Resetting would only destroy the phase 1 deployment and force a redeploy
before the frontend works again.

The node **must** be running with `DEV_RPC=true` — the suite calls
`evm_increaseTime` and `evm_mine` directly.

**Terminal 1**

```
cd /d D:\Projects\FYP\zk_voting\packages\blockchain
make run-dev
```

**Terminal 2**

```
cd /d D:\Projects\FYP\zk_voting\packages\hardhat
yarn test:custom
```

(`yarn test` stays pinned to `--network hardhat`, so hardhat-mode regression
runs are unaffected.)

**Expected:** 65 passing (13 `GNAndRegistry` + 5 `NicRegistry` + 37 `Voting` +
10 `DivisionEnrolment`).

`DivisionEnrolment.ts` was added on 2026-08-03 with the fix for the
runtime-division enrolment defect (§13). It pins what a division created by
`ElectionRegistry.createDivision()` can and cannot do, and what a client must
call to finish setting one up. Worth reading if the admin panel's section 7
ever changes.

Expect it to take a few minutes. Each of the 37 `Voting` tests redeploys the
4.7M-gas HonkVerifier, and this node seals one transaction per block, so the
run is roughly 220 blocks. Mocha's per-test timeout is 40 s, which is ample
for the six transactions each `beforeEach` performs.

### What is actually being tested here

This is the milestone's flagship gate. 18 assertions use
`revertedWithCustomError`, which is the interesting path: ethers v6 estimates
gas before sending, our node returns the revert as JSON-RPC code 3 with the
raw revert bytes in `data`, ethers turns that into a `CALL_EXCEPTION`, and
hardhat-chai-matchers decodes the custom error name from the ABI. The
equivalent path was proven for viem in M05 (`e2e/diff/write.mjs` check (d));
this proves it for the ethers/chai stack the contract tests use.

### If something fails

| Symptom | What it means / what to do |
|---|---|
| Every test errors with `-32601` on `evm_increaseTime` | Node started with `make run`, not `make run-dev`. |
| `revertedWithCustomError` failures reporting the wrong error, or none | The revert `data` isn't reaching ethers. Send me one full failure — this is the gate's whole point and the fix belongs in `internal/rpc`. (All 18 passed on the first run, so this path is known good.) |
| ~~Bare `ProviderError: execution reverted` with no custom error, on `resetElection`~~ | **Hit and fixed 2026-08-01.** Not a revert at all — an out-of-gas, which produces an *empty* revert and so looks like one. `eth_estimateGas` returned `UsedGas * 1.1`, but `UsedGas` is net of gas refunds while the transaction must be funded with the gross amount (EIP-3529 caps the refund at `gross/5`, so gross can be 1.25x). The estimator now binary-searches. **If you ever see a bare "execution reverted" with no data again, suspect gas before suspecting the contract.** |
| `Timeout of 40000ms exceeded` in a `beforeEach` | The node is sealing too slowly. Tell me which test and how far it got; the fix is node-side, not a timeout bump. |
| `insufficient funds` | The signer isn't one of the 20 genesis-prefunded accounts — check `custom.accounts.mnemonic` in `hardhat.config.ts`. |
| Failures that also fail on `yarn test` (hardhat mode) | Pre-existing, not caused by this node. Run `yarn test` to confirm before investigating further. |

**Rule (MASTER §6):** the node gets fixed, never the tests or the contracts.

---

## 6. M09 gate — restart recovery + audit replay

Two phases. Phase A is offline. Phase B **reuses the data directory M08's
gate left behind** — that is the point of the gate: it audits a real chain
containing the whole Voting stack, three runtime-deployed division
contracts, and the 220-odd blocks `yarn test:custom` produced, rather than a
synthetic fixture. So do **not** `make reset` before this.

### Phase A — offline checks

```
cd /d D:\Projects\FYP\zk_voting\packages\blockchain

make vet            # raw: go vet ./...
make fmt            # raw: gofmt -l .          -> must print NOTHING
make test           # raw: go test ./... -v
```

New in M09, worth watching for by name in the `make test` output:

| Test | What it proves |
|---|---|
| `TestReplayVerifiesAnHonestChain` | A 60-odd-block chain mixing deploys, storage writes, log emissions, EIP-3529 refund calls, empty blocks, system-op blocks and rejected reverting transactions replays to the sealed head's exact state root. This is the audit's core claim. |
| `TestAuditFixtureCoversEveryTransactionType` | The fixture contains legacy, EIP-2930 and EIP-1559 transactions. Added after the first real audit run failed at block 1: on a legacy transaction every *derived* receipt field equals its zero value, so a legacy-only fixture cannot tell a stored field from a derived one — and the audit had shipped comparing `receipt.Type`, which is derived. |
| `TestReplayIsIncrementalFromAMidChainBlock` | `audit -from N` reads historical trie nodes back through the overlay instead of recomputing them, and still lands on the same final root. |
| `TestReplayReportsATamperedReceipt` / `TestReplayReportsMissingReceipts` | Altering one stored receipt (by a single gas unit) or truncating it is reported **at that block**, not later and not as a vague failure. Receipts live outside the header, so every root still verifies — this is the check that catches them. |
| `TestVerifyBlockNamesTheFieldThatDisagrees` / `TestVerifyLinkageEnforcesTheChainShape` | Each comparison rule names the right field: stateRoot, gasUsed, receiptsRoot, logsBloom, parentHash, number, timestamp. |
| `TestChainRecoversFromAPartialWrite` | A block whose data reached disk while the head pointer did not is left orphaned; the node reopens at the previous head and the next transaction takes the lost block's height. |
| `TestRestartSeedsTheDevClockFromAFarFutureHead` | After a restart, a chain whose head is a week ahead of wall clock keeps tracking real elapsed time instead of crawling forward one second per block. |
| `TestVerifyHeadRejectsAHeadWhoseStateIsMissing` | The node refuses to start on a data directory whose head references unreadable state, and says so in a message that points at `cmd/audit`. |
| `TestOverlay*` (internal/storage) | The audit's copy-on-write layer reads through to the audited database, keeps every write out of it, and refuses deletes and iteration rather than answering them incompletely. |

### Phase B — audit the real chain

**Stop the node first.** Pebble holds an exclusive lock on the data
directory and the audit opens it read-only rather than fighting for it; with
the node still running you will get a lock error, not a wrong answer.

```
cd /d D:\Projects\FYP\zk_voting\packages\blockchain
make audit
```

**Expected:** a single line and exit code 0.

```
AUDIT OK height=<N> stateRoot=0x… blocks=<N> txs=… gas=… elapsed=… (… blocks/s)
```

`height` should equal the height the node last reported.

Observed on the first gate run (2026-08-01), against the data directory M08
left behind:

```
AUDIT OK height=787 stateRoot=0x8ce1fd46… blocks=787 txs=774 gas=1410021337 elapsed=419ms (1878.5 blocks/s)
```

That figure is recorded in `packages/blockchain/README.md` and is the number
to quote in the FYP report for "how long does independently re-verifying an
election take".

Then check the incremental and JSON paths (both fast — the first is a short
range, the second is the same code with a different printer). Call the
binary directly rather than going through `make`: passing quoted arguments
through a make command line does not survive cmd.exe (§0).

```
make build-audit
bin\zk-blockchain-audit.exe -data-dir data -from 400
bin\zk-blockchain-audit.exe -data-dir data -json
```

The incremental run is the interesting one: it starts from block 399's
stored state root and reads historical trie nodes back out of the audited
database through the overlay, instead of recomputing them from genesis.
Expect `AUDIT OK height=787 blocks=388 …`.

### Phase C — restart recovery

```
make run-dev
```

**Expected in the startup log, in this order:**

| Line | Meaning |
|---|---|
| `genesis ready` | unchanged from M02 |
| `chain head recovered` with `height`, `headHash`, `stateRoot` | new in M09 — the head's state was opened successfully before the RPC server started |
| `chain head is ahead of wall clock…` (warning, only if applicable) | the dev clock was seeded from the head. **Expect this** on the M08 data directory, since `yarn test:custom` jumps time forward. The `devOffsetSeconds` value should be roughly how far ahead the last test run pushed the chain |
| `listening addr=:9545` | as before |

Then confirm the chain really resumed rather than restarted:

```
curl.exe -s -X POST localhost:9545 -H "content-type: application/json" ^
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}"
```

The height must match the `height=` the audit reported. A read against a
contract deployed in M08 should also still work — the quickest check is the
frontend or:

```
cd /d D:\Projects\FYP\zk_voting\packages\hardhat
yarn test:custom
```

which redeploys and passes only if the recovered chain is fully functional
(65 passing, as in §5.5).

### If something fails

| Symptom | What it means / what to do |
|---|---|
| `make audit` reports a lock error | The node is still running against that data directory. Stop it, or copy the directory and audit the copy with `make audit DATA_DIR=<copy>`. |
| `AUDIT FAILED block=N field=stateRoot` | Re-execution no longer reproduces the stored state at block N. This is the serious one: it means the sealing path and the replay path disagree, which would also make M10's replicas reject the primary. Send me N and the two roots. |
| `AUDIT FAILED block=N field=receipt[0].…` or `field=storedReceipts` | The header still verifies; only the separately stored receipt record is wrong. Send me the line — this points at the receipt write path, not at execution. |
| `AUDIT FAILED: genesis mismatch …` | The audit is configured for a different chain than the data directory holds — usually a `CHAIN_ID` or `BLOCK_GAS_LIMIT` difference between `.env` and how the chain was created. |
| `AUDIT FAILED: no genesis block in this data directory` | Wrong `DATA_DIR`, or the directory was reset. |
| Node refuses to start with `chain head failed its startup integrity check` | Exactly what M09 added, doing its job. Run `make audit` to find the first bad block before doing anything else — in particular before `make reset`, which destroys the evidence. |
| `chain head is ahead of wall clock` with an implausible `devOffsetSeconds` (years) | A timestamp was pinned absurdly far ahead at some point. Not fatal, but tell me the value and the height. |

---

## 7. M10 gate — replication (primary + 2 replicas over mTLS)

Three phases: offline checks, then a one-time cluster setup, then the
cluster gate itself. Phase B needs no Hardhat node and no `yarn compile` —
it drives a committed contract artifact, so the only prerequisites are the
Go toolchain and `npm install` in `e2e/` (§1.4).

### Before you start: delete `packages/blockchain/.env` if it still exists

§1.6 called this optional. **It is now required.** That leftover v1 file
sets `PEERS`, and from M10 on `PEERS` is what turns a standalone node into a
sequencer with replicas — so `make run` would try to open the mTLS P2P port,
fail to find certificates, and exit with a configuration error. Delete it,
or replace it with a copy of `.env.example`:

```
del packages\blockchain\.env
```

The error, if you hit it, names the fix: *"p2p client TLS (run `make
gen-certs`, or unset PEERS to run standalone)"*.

### Phase A — offline checks

```
cd /d D:\Projects\FYP\zk_voting\packages\blockchain

make vet            # raw: go vet ./...
make fmt            # raw: gofmt -l .          -> must print NOTHING
make test           # raw: go test ./... -v
make block-rlp-test # raw: cd e2e && node lib/block-rlp.test.mjs
```

`make fmt` listing files is expected on this milestone — I hand-aligned the
new struct fields without a formatter. Run `gofmt -w .` and re-run; it is
cosmetic.

New in M10, worth watching for by name in `make test` output:

| Test | What it proves |
|---|---|
| `TestReplicaReproducesThePrimaryChainBlockByBlock` | A replica fed M09's whole audit fixture chain (deploys, storage writes, logs, refund calls, empty blocks, system-op blocks) ends up at the *same head hash* — so every block was re-executed and every re-execution agreed. |
| `TestAReplicaChainPassesTheAuditor` | The state a replica derived by following passes `cmd/audit` on its own. This is the join between M09 and M10: a replica is not merely consistent with the primary, it is independently verifiable. |
| `TestReplicaRejectsATamperedStateRoot` / `...ASwappedTransaction` / `...ATamperedTimestamp` | The tamper-evidence property, from three directions. Each must be refused at that block, naming the field, leaving the replica's height unchanged. |
| `TestReplicaDetectsAForkAtAnAlreadyAppliedHeight` | A second, different block at an applied height is refused and the local one *kept* — overwriting would destroy the evidence. |
| `TestReplicaRefusesAPushedGenesisBlock` | Genesis comes from local config, never from the wire. |
| `TestMutualTLSRejectsAForeignCertificate` / `...AnAnonymousClient` | Membership of the cluster is possession of a certificate signed by its CA — nothing else. |
| `TestSealingIsNeverBlockedByAnUnresponsivePeer` | 30 blocks sealed against a peer that answers nothing, in under a second. Fire-and-forget pushing, not a synchronous one. |
| `TestPusherRetriesATransientFailure` / `TestPusherDoesNotRetryARefusal` | A 5xx is retried (3 times); a 409 verdict is not. |
| `TestAGapInAPushTriggersCatchUp` / `TestPollingCatchesMissedPushes` | The replica repairs itself, both when a push tells it that it is behind and when no push ever arrives. |
| `TestWritesAreForwardedVerbatim` / `TestDevMethodsAreForwarded` | A replica hands writes to the sequencer without re-encoding them, and never seals a block of its own. |

`make block-rlp-test` is a Node-only unit test of the block encoder the
cluster gate uses to forge a block. Expect `27 checks` and `PASS`. It is
cheap and worth running first: a fault there shows up in phase C as the
replica rejecting a block, which looks exactly like the tamper detection
that scenario is trying to observe.

### Phase B — one-time cluster setup

```
cd /d D:\Projects\FYP\zk_voting\packages\blockchain
make gen-certs
```

**Expected:** a `certs/` directory holding `ca.crt`, `ca.key`, and
`primary`/`replica1`/`replica2` `.crt`/`.key` pairs, and a summary listing
them. `certs/` is gitignored; regenerate freely.

Optionally bring the cluster up by hand and look at it:

```
make run-cluster
```

Three nodes start in one terminal with their logs prefixed by node name.
Then, in another:

```
curl.exe -s http://127.0.0.1:9545/health
curl.exe -s http://127.0.0.1:9555/health
```

The primary reports `{"status":"ok","role":"primary",...}`; each replica adds
`"primaryHeight"` and `"synced":true`. Ctrl+C stops all three.

### Phase C — the gate

```
cd /d D:\Projects\FYP\zk_voting\packages\blockchain
make cluster-test
```

This starts a **fresh** 3-node cluster (the cluster's data directories are
wiped first), runs all five scenarios, and stops the cluster on the way out
whether it passes or fails. Set `VERBOSE=1` to see the nodes' own logs
interleaved with the checks.

**Expected:** every line `[PASS]`, then a count and `PASS`. The scenarios:

| # | Scenario | What it proves |
|---|---|---|
| 1 | Deploy a contract to the sequencer | All three nodes converge on the same head *hash*, and each replica's `/health` reports itself synced. |
| 2 | Write through **replica1's** RPC | `eth_sendRawTransaction` is forwarded, the transaction is mined by the sequencer, the receipt comes back through the replica, and `evm_mine` sent to a replica advances the *sequencer's* height. |
| 3 | Stop replica2, seal 20 blocks, restart it | The surviving replica stays current throughout (one node down does not stall the cluster), and the restarted one catches up to the exact same head hash. |
| 4 | Read the same seven calls from all three nodes | `eth_getBalance`, `eth_getCode`, `eth_call`, `eth_getLogs`, `eth_getTransactionReceipt`, `eth_getBlockByNumber` and `eth_getTransactionCount` are byte-identical, and viem's decoded event stream matches. |
| 5 | Push a hand-crafted block with a wrong state root | The replica re-executes, refuses it with HTTP 409 `state-mismatch`, keeps its own head, and stays synced. Its node log carries `CRITICAL state root mismatch`. |

Scenario 5 checks its own tooling first: it re-encodes a block the replica
already has and expects the replica to answer `duplicate`, which can only
happen if this script's RLP reproduces the node's bytes exactly. If that
check fails, the tamper result is reported as unproven rather than as a pass.

### Observed on the first gate run (2026-08-01)

All five scenarios passed first time — `26 checks: 26 passed, 0 failed.`
Worth recording, because these are the numbers to quote in the FYP report:

| Observation | Value |
|---|---|
| Nodes converged on head | `0x697f4f4102…`, heights `3 / 3 / 3` |
| Write submitted through replica1 | mined by the sequencer, receipt readable from the replica; `value()` returned 77 |
| `evm_mine` sent to a replica | advanced the *sequencer's* height 4 → 5 |
| Blocks sealed while replica2 was down | 20 (height 5 → 25); replica1 stayed current throughout |
| Restarted replica2 | caught up to the sequencer's exact head `0x48c21a3fdb…`, `synced: true` |
| Reads compared across all 3 nodes | 7 JSON-RPC methods byte-identical; 25 decoded events identical |
| Tampered block | refused with `409 {"code":"state-mismatch"}`: *block 26: stateRoot mismatch: got 0xebb1193b…, want 0xbadbad…* — the replica's own re-execution produced the real root and rejected the forged one |
| Self-check before tampering | this script's header encoding reproduced the node's block hash exactly |

The tamper line is the milestone's headline result: a replica was handed a
correctly-linked, correctly-numbered, correctly-signed block whose only fault
was a state root that does not follow from its contents, and it re-derived
the real root itself and refused. That is the tamper-evidence property MASTER
§3 claims, demonstrated rather than asserted.

### If something fails

| Symptom | What it means / what to do |
|---|---|
| `node binary not found` | `make build` first (`make cluster-test` does this for you; running `node cluster-test.mjs` by hand does not). |
| `missing certificates in …/certs` | `make gen-certs`. |
| A node exits during startup with a TLS error | The certificate names must match the node names in `e2e/cluster.mjs` (`primary`, `replica1`, `replica2`). Regenerate with plain `make gen-certs`. |
| `listen tcp :9545: bind: address already in use` | A node from an earlier run (or `make run`) is still up. Stop it; the cluster uses 9545/9546, 9555/9556, 9565/9566. |
| Scenario 1 times out waiting for convergence | Look at a replica's log (`VERBOSE=1`). A `CRITICAL state root mismatch` there means sealing and replay disagree — the same class of failure as an `AUDIT FAILED`, and the serious one. Send me the block number and the two roots. |
| Scenario 2 fails with `cannot reach the sequencer` | The replica's `PRIMARY_RPC_URL` is wrong or the primary died. The launcher sets it; check the primary's log first. |
| Scenario 3's restarted replica never catches up | Send me the replica's log from restart onward — the interesting lines are `chain head recovered`, then `replica caught up`. |
| Scenario 5 reports "this script encodes a block header exactly as the node does" as `[FAIL]` | The JS header encoder and the node disagree — most likely a go-ethereum bump changed the header's field set. The tamper check is then skipped deliberately. Send me the two hashes; the fix is in `e2e/lib/block-rlp.mjs`. |
| Scenario 5's push is refused with `400 malformed` instead of `409 state-mismatch` | Same cause as above, one step further along: the header encodes but the block wrapper does not. Also `e2e/lib/block-rlp.mjs`. |
| Windows Defender/firewall prompt on first run | The nodes bind loopback ports; allow it once. |

### Re-running

`make cluster-test` always starts from a fresh genesis, so it is safe to run
repeatedly. `make reset-cluster` removes the data directories by hand if you
want the disk back. Note that the cluster's data lives in `data-cluster/`,
which is *separate* from the `data/` directory M08 and M09 use — running the
cluster does not disturb the chain those gates left behind.

---

## 8. M11 gate — Next.js on the custom chain

The first gate that lives in `packages/nextjs` rather than `packages/blockchain`,
so none of the Go setup in §1 applies. Three phases: offline, then the app
against the custom chain, then the same thing against Hardhat. **Phase C is not
optional** — it is the half of the claim that says the swap goes both ways.

### Before you start: `yarn install`

M11 adds one dependency (`vitest`) and two scripts (`test`, `test:watch`). From
the repo root:

```
cd /d D:\Projects\FYP\zk_voting
yarn install
```

### Phase A — offline checks

No chain and no dev server needed.

```
cd /d D:\Projects\FYP\zk_voting\packages\nextjs

yarn test            # raw: vitest run
yarn check-types     # raw: tsc --noEmit --incremental
yarn lint            # raw: next lint
yarn build           # raw: next build
```

**Expected**

| Command | Pass looks like |
|---|---|
| `yarn test` | `Test Files 5 passed`, `Tests 49 passed` |
| `yarn check-types` | no output |
| `yarn lint` | `No ESLint warnings or errors` |
| `yarn build` | `✓ Compiled successfully`, then the route table |

The four test files, and what each is for:

| File | What it proves |
|---|---|
| `utils/customChain.test.ts` (14) | The custom chain resolves to 9494 / :9545 by default and follows `NEXT_PUBLIC_CHAIN_ID` / `NEXT_PUBLIC_RPC_URL`. A malformed id falls back instead of producing a `NaN` chain id — which viem accepts silently and which then fails somewhere unrelated. |
| `utils/serverChain.test.ts` (11) | The API routes' chain config defaults to Hardhat (so a checkout with no `.env.local` is unchanged), `RPC_URL` overrides `NEXT_PUBLIC_RPC_URL`, and the faucet allowlist parser drops malformed entries and **fails closed** on wholly invalid input. |
| `scaffold.config.test.ts` (5) | The swap switch itself: `NEXT_PUBLIC_CHAIN_BACKEND=custom` repoints `targetNetworks` at the real custom chain, anything else stays on Hardhat. One case explicitly asserts the target is *not* chain 1 — the `chains.mainnet` placeholder this replaced would have sent every read to a public RPC while looking fine. |
| `utils/deployedAddress.test.ts` (11) | Contract addresses resolve per chain and never leak across chains; a blank env override falls back to the deployment record instead of masking it. Two cases assert the real `deployedContracts.ts` carries `NicRegistry` and `ElectionRegistry` on **both** 31337 and 9494. |
| `utils/noHardcodedChain.test.ts` (8) | The regression net. Scans `app/`, `components/`, `hooks/`, `utils/`, `services/` for `31337`, `:8545`, `webSocket(`, `hardhat.id` and imports from the deleted `services/chain`. Comments are stripped before matching, and every permitted occurrence sits in a named allowlist with its reason. |

If `noHardcodedChain` fails, read the file list it prints — that is the fix list.
Adding a file to its allowlist is fine, but write down why.

### Phase B — custom mode

**Terminal 1** — the node (reuse the data directory from M08/M09; do not reset):

```
cd /d D:\Projects\FYP\zk_voting\packages\blockchain
make run-dev
```

**Terminal 2** — `packages\nextjs\.env.local` must hold the custom column:

```
NEXT_PUBLIC_CHAIN_BACKEND=custom
NEXT_PUBLIC_CHAIN_ID=9494
NEXT_PUBLIC_RPC_URL=http://127.0.0.1:9545
```

```
cd /d D:\Projects\FYP\zk_voting\packages\nextjs
yarn dev
```

**Terminal 3** — the harness:

```
cd /d D:\Projects\FYP\zk_voting\packages\nextjs
set CHECK_CHAIN_ID=9494
set CHECK_RPC_URL=http://127.0.0.1:9545
node e2e\frontend-check.mjs
```

(PowerShell: `$env:CHECK_CHAIN_ID="9494"` etc. — see §0.)

> **Never `set RPC_URL` or `NEXT_PUBLIC_*` in a console you will later run
> `yarn dev` from.** On Windows those persist for the session and are inherited
> by child processes, and process env **outranks `.env.local`**. The result is a
> server that reads contract addresses for one chain and sends calls to the
> other — which looks exactly like a code bug and is not one. This is why the
> harness's variables carry a `CHECK_` prefix: they cannot collide with the
> app's. The harness warns if it sees app variables set in its own shell.

**Expected:** every line `[PASS]` or `[SKIP]`, final line `PASS`.

`frontend-check.mjs` drives the four API routes the mobile app and the pages
depend on, and cross-checks each answer against the node directly — the
server-rebuilt Merkle root must equal the contract's root, the resolved candidate
name must equal the one in the `VoteCast` log, the faucet's claimed transfer must
show up as a balance increase. Checks that need election data (a registered
commitment, a cast vote) print `[SKIP]` with the reason on a freshly deployed
chain; pass `--strict` to turn those into failures once M14 runs a full election.

Then walk the pages in a browser:

| Page | Expected |
|---|---|
| `/results` | the three divisions plus the national tally |
| `/audit` | `VoteCast` logs load without console errors |
| `/blockexplorer` | browses the node's blocks, and keeps ticking as new ones seal |
| `/gn` | connects with MetaMask on chain 9494; the voter roll loads |
| `/voting/admin` | phase controls work with MetaMask on chain 9494 (temporary — M12 replaces this with credential login) |

Add chain 9494 to MetaMask manually the first time: RPC `http://127.0.0.1:9545`,
currency ETH. Import a genesis-prefunded account with one of the Hardhat mnemonic
keys to act as owner/GN.

### Phase C — Hardhat regression

Restore the hardhat column in `.env.local`, then:

```
# Terminal 1
cd /d D:\Projects\FYP\zk_voting
yarn chain

# Terminal 2
yarn deploy

# Terminal 3
cd /d D:\Projects\FYP\zk_voting\packages\nextjs
yarn dev

# Terminal 4 — no env vars needed; the harness defaults to 31337 / :8545
node e2e\frontend-check.mjs
```

**Expected:** the same check names, the same verdicts. Walk the same pages; they
must behave exactly as they did before M11.

### Observed on the first gate run (2026-08-02)

All three phases green. The numbers to quote in the FYP report:

| Phase | Observation |
|---|---|
| A | `49 passed (49)` across 5 test files in 0.83 s; `check-types` silent; `lint` 2 pre-existing warnings (see below); `build` compiled, 23 routes. (First run was 36/4; the third bug's fix added `deployedAddress.ts` with 11 tests and 2 further guards.) |
| B (custom, 9494) | `19 checks: 17 passed, 0 failed, 2 skipped` — `PASS` |
| B — node state | Started from the M08/M09 data directory: `height=787`, `stateRoot=0x8ce1fd46…`, matching M09's audit exactly. Reads, writes and receipts all served from a chain built by earlier milestones. |
| B — write path | `/api/faucet` funded a fresh address on chain 9494; balance `0 → 50000000000000000`. Sign, seal, receipt, balance — the whole write path through the app, on free gas. |
| C (hardhat, 31337) | `19 checks: 17 passed, 0 failed, 2 skipped` — `PASS`. **The same check names with the same verdicts as B**; the only difference in the output is `chainId=31337` vs `9494`. |

That last row is the milestone's headline result: the same API surface, exercised
identically against two entirely different chain implementations, with no source
change between the runs — only three lines of `.env.local`.

The two `[SKIP]`s in both phases are `merkle-path returns a proof…` and
`verify-vote resolves a real vote…`. Both need election data that a freshly
deployed chain does not have. M14 runs a full election and should turn them into
passes; run the harness with `--strict` there.

The two `yarn lint` warnings are **pre-existing and unrelated to M11**: a
`react-hooks/exhaustive-deps` note on `candList` in `app/voting/admin/page.tsx`
(line 126, untouched by this milestone) and a prettier nit on the GitHub icon
path in `components/Footer.tsx` (line 50). `yarn format` clears the second.

### Still outstanding: the browser walkthrough

**The page-by-page table above has not been run.** Only the harness and the
offline checks have. That gap is not cosmetic — the third bug below lived on
`/gn/register`, a page the harness never touches, and survived two full green
harness runs because of it. M11 is not done until the five pages have been
opened in both modes.

### Three bugs this gate found

Worth recording, because neither would have surfaced from reading the code:

1. **`NEXT_PUBLIC_NIC_REGISTRY_ADDRESS` held one address for two chains.**
   `NicRegistry` has a different address per chain, so a single env value cannot
   be right in both modes — and the committed value (`0x9A9f2CCf…`) matched
   *neither* deployment (both record `0x5FC8d326…`), so GN registration was
   pointing at a dead address in Hardhat mode too. `gn/register/page.tsx` now
   reads it from `deployedContracts[targetNetwork.id]`, with the env var demoted
   to an optional override. Leave it empty.
2. **The harness's `RPC_URL`/`CHAIN_ID` collided with the app's own variables.**
   Setting them in a console and later starting `yarn dev` from the same window
   gave the server a hybrid config: 31337 contract addresses, calls sent to
   :9545. Renamed to `CHECK_RPC_URL` / `CHECK_CHAIN_ID`; the harness now also
   warns when it sees app variables in its shell.
3. **`??` against `process.env` — introduced by the fix for (1), found by
   re-reading it.** `NEXT_PUBLIC_NIC_REGISTRY_ADDRESS=` in a `.env` file yields
   the **empty string**, not `undefined`, so `process.env.X ?? deployedAddress`
   evaluated to `""` and the deployment-record fallback never ran. `""` is falsy,
   so `/gn/register` reported "NIC Registry Not Deployed" in both modes. Address
   resolution now lives in `utils/deployedAddress.ts`, which normalises blank to
   absent, and two new guards in `noHardcodedChain.test.ts` reject `process.env.X
   ??` and env-supplied contract addresses outright.

   The lesson worth keeping: the fix for a config bug is itself config code, and
   deserves the same scrutiny. This one was caught by reading, not by any test —
   which is why it is now a test.

### If something fails

| Symptom | What it means / what to do |
|---|---|
| `yarn test` can't find `vitest` | `yarn install` from the repo root — M11 added the dependency. |
| A `noHardcodedChain` test fails | A chain literal came back. The printed file list is the fix list; each file should read its chain from `useTargetNetwork()` (components), `scaffoldConfig.targetNetworks[0]` (module scope) or `serverChainConfig` (API routes). |
| `frontend-check.mjs` exits 2 with "Cannot reach the node" | The node isn't running, or `CHECK_RPC_URL` was set in a different terminal (§0). |
| `frontend-check.mjs` exits 2 with a chain-id mismatch | `CHECK_CHAIN_ID` and the node disagree. The harness refuses to run rather than report confusing failures. |
| The dev server's stack trace shows an RPC URL that isn't the one in `.env.local` | Environment leak — see the warning box above. Close that console, open a fresh one, restart `yarn dev`. The harness prints a `WARNING:` block listing the offending variables if they are also set in *its* shell. |
| `election reports the configured chain id` fails | The app's `NEXT_PUBLIC_CHAIN_ID` and the harness's `CHAIN_ID` differ, or `.env.local` wasn't picked up — Next.js only reads it at startup, so restart `yarn dev`. |
| `election lists at least one division` fails | Contracts aren't deployed on this chain. `yarn deploy --network custom` (or plain `yarn deploy` for Hardhat). |
| `every division's Voting contract is readable` fails | `ElectionRegistry` lists divisions whose `Voting` contracts don't answer `eth_call` — a chain/deployment mismatch. Check that `deployedContracts.ts` still holds both the `31337` and `9494` blocks (§5.1). |
| `server-rebuilt root matches the contract's root` fails | `eth_getLogs` and `eth_call` disagree on this node — a node bug, not a frontend one. Send me the two roots and the division address. |
| `faucet funds an address` reports `[SKIP] disabled for chain N` | `FAUCET_CHAIN_IDS` doesn't include the chain. Default is `31337,9494`. |
| `/blockexplorer` shows nothing and the console mentions WebSocket | A `webSocket(` transport came back somewhere; the `noHardcodedChain` guard should have caught it. Our node has no `eth_subscribe` (MASTER §9). |
| The faucet button next to the wallet is missing in custom mode | Expected and deliberate — see the note at the top of `M11-frontend-switch.md`. |
| A page works in Hardhat mode but not custom mode | The classic M11 failure. Grep the page for a chain literal; if there isn't one, it is reading a contract address from `deployedContracts[31337]` via a hardcoded key. |

---

## 9. M12 pass 1 gate — no-wallet auth, server side

M12 was split in two. **Pass 1 (this section) is the server half**: the auth
services, the login/logout/session routes, `middleware.ts`, `POST /api/relay`
and `/api/gn-accounts`. **Pass 2 adds the browser half** — `app/login/page.tsx`,
the `useElectionWriter` seam and the admin/GN page refactors.

> **What you cannot do yet.** There is no `/login` page until pass 2, so the
> middleware's redirect lands on a 404, and the admin/GN pages still sign with
> MetaMask. The full M12 acceptance gate in `M12-no-wallet-auth.md` — the
> click-through election lifecycle with no wallet installed — belongs to pass 2.
> This section verifies the server behaves correctly on its own.

### Before you start: `yarn install`

M12 adds two dependencies (`iron-session`, `bcryptjs`). From the repo root:

```
cd /d D:\Projects\FYP\zk_voting
yarn install
```

### Phase A — offline checks

No chain and no dev server needed.

```
cd /d D:\Projects\FYP\zk_voting\packages\nextjs

yarn test            # raw: vitest run
yarn check-types     # raw: tsc --noEmit --incremental
yarn lint            # raw: next lint
yarn build           # raw: next build
```

**Expected**

| Command | Pass looks like |
|---|---|
| `yarn test` | `Test Files 13 passed`, `Tests 161 passed` (49 from M11 + 112 from M12) |
| `yarn check-types` | no output |
| `yarn lint` | `No ESLint warnings or errors` (the two pre-existing warnings noted in §8 may persist) |
| `yarn build` | `✓ Compiled successfully`; the route table now lists `/api/auth/login`, `/api/auth/logout`, `/api/auth/session`, `/api/relay`, `/api/gn-accounts`, and a `ƒ Middleware` line |

The M12 test files are `middleware.test.ts` and `services/auth/*.test.ts`. The
ones worth reading if you only read a few: `relayPolicy.test.ts` (every way a GN
is stopped from acting outside their division) and `middleware.test.ts` (proves
hardhat mode is untouched, and that a missing `SESSION_SECRET` fails closed).

**Two of these tests exist because they caught real bugs during development** —
a stack overflow in revert decoding on a self-referential error chain, and
`JSON.stringify` throwing on `bigint` while building an audit line. Both would
have shown up as opaque 500s from the relay.

### Phase B — the server against the custom chain

Needs the node running with contracts deployed (§5). Set up the environment
first — **all five variables, or the routes report 503 rather than working**:

```
cd /d D:\Projects\FYP\zk_voting\packages\nextjs
```

Add to `.env.local` (on top of the custom-mode column from §8):

```
NEXT_PUBLIC_CHAIN_BACKEND=custom
NEXT_PUBLIC_CHAIN_ID=9494
NEXT_PUBLIC_RPC_URL=http://127.0.0.1:9545

SESSION_SECRET=<openssl rand -base64 32>
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=<see below>
ADMIN_RELAY_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
GN_KEY_ENCRYPTION_KEY=<openssl rand -hex 32>
```

Generate the admin password hash (PowerShell, one line):

```
node -e "import('bcryptjs').then(b=>b.hash(process.argv[1],12)).then(console.log)" "your-password"
```

`ADMIN_RELAY_PRIVATE_KEY` above is **Hardhat account #0** — the account that owns
the deployed contracts, and a publicly known test key. If admin actions revert
with `OwnableUnauthorizedAccount`, this is the variable that is wrong.

Then `yarn dev`, and drive the API directly (PowerShell `curl` is
`Invoke-WebRequest`; these use `curl.exe` explicitly):

```
# 1. Signed out: the relay refuses.
curl.exe -s -X POST http://localhost:3000/api/relay -H "Content-Type: application/json" ^
  -d "{\"target\":\"0x0\",\"fn\":\"endElection\",\"args\":[]}"
#    -> {"error":"Sign in to continue."}   (401)

# 2. Wrong password.
curl.exe -s -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" ^
  -d "{\"username\":\"admin\",\"password\":\"wrong\"}"
#    -> {"error":"Incorrect username or password."}   (401)
#    Repeat 5x -> {"error":"Account locked for 15 minutes..."}   (429)
#    Use a different username to keep testing, or restart `yarn dev` to clear
#    the lockout (it is process-local by design — see 01-AUTH-DESIGN.md §6).

# 3. Correct password, keeping the cookie.
curl.exe -s -c cookies.txt -X POST http://localhost:3000/api/auth/login ^
  -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"your-password\"}"
#    -> {"username":"admin","role":"admin"}

curl.exe -s -b cookies.txt http://localhost:3000/api/auth/session
#    -> {"mode":"custom","session":{"username":"admin","role":"admin",...}}

# 4. A real admin action. Use a division address from /api/election.
curl.exe -s -b cookies.txt -X POST http://localhost:3000/api/relay ^
  -H "Content-Type: application/json" ^
  -d "{\"target\":\"0x<division>\",\"fn\":\"setQuestion\",\"args\":[\"Gate test\"]}"
#    -> {"txHash":"0x...","blockNumber":"...","status":"success"}

# 5. The relay must refuse to sign voter functions, whoever is asking.
curl.exe -s -b cookies.txt -X POST http://localhost:3000/api/relay ^
  -H "Content-Type: application/json" ^
  -d "{\"target\":\"0x<division>\",\"fn\":\"register\",\"args\":[1]}"
#    -> {"error":"Role \"admin\" may not call register on Voting."}   (403)

# 6. And to sign for addresses it does not know.
curl.exe -s -b cookies.txt -X POST http://localhost:3000/api/relay ^
  -H "Content-Type: application/json" ^
  -d "{\"target\":\"0x9999999999999999999999999999999999999999\",\"fn\":\"setQuestion\",\"args\":[\"x\"]}"
#    -> {"error":"The relay does not sign calls to that address."}   (403)

# 7. Create a GN account (also assigns it on-chain via setGNOfficer).
curl.exe -s -b cookies.txt -X POST http://localhost:3000/api/gn-accounts ^
  -H "Content-Type: application/json" -d "{\"username\":\"gn-colombo\",\"divisionId\":0}"
#    -> {"username":"gn-colombo","password":"<shown once>","address":"0x...","assigned":true}
```

**Then check the two files on disk.** This is the part of the gate that cannot
be faked:

```
type data\gn-accounts.json
#  - contains "encryptedPrivateKey":"v1:..." and a $2b$ bcrypt hash
#  - contains NO bare 64-hex string, and not the password you were shown

findstr /C:"0x" data\gn-accounts.json
#  - only the 40-hex `address` field should match

type data\relay-audit.log
#  - one JSON line per call above, including the refusals, each with
#    {ts, role, username, target, fn, args, status}
```

Finally, sign in as the GN (step 3 with the new credentials) and confirm the
scoping rule — this is the single most important behaviour in M12:

```
# addVoters on the GN's own division 0 -> success
# the same call against division 1     -> 403 "You may only act on your own division."
# startVoting on any division          -> 403 (admin-only function)
```

### Phase C — hardhat regression

**Not optional.** Restore the hardhat env column (§8) and restart `yarn dev`:

| Check | Expected |
|---|---|
| `/voting/admin` and `/gn` | Load with MetaMask exactly as before M12 — no redirect, no login |
| `curl.exe -s -X POST http://localhost:3000/api/auth/login -d "{}" -H "Content-Type: application/json"` | 404 `Credential login is only available in custom-chain mode.` |
| `curl.exe -s -X POST http://localhost:3000/api/relay -d "{}" -H "Content-Type: application/json"` | 404 `The relay is only available in custom-chain mode...` |
| `yarn build` | Green with no `SESSION_SECRET` set at all |

The last row is the one that catches an accidental hard dependency: hardhat mode
must work in a checkout that has never configured M12's environment.

### If something fails

| Symptom | What it means / what to do |
|---|---|
| Any auth route returns 503 `Authentication is not configured on this server.` | `SESSION_SECRET` is missing or under 32 characters. The server log names the variable. |
| Relay returns 503 `ADMIN_RELAY_PRIVATE_KEY is missing or malformed` | Not set, or not a `0x` + 64-hex string. |
| Relay returns 503 `The GN account store is unavailable` | `GN_KEY_ENCRYPTION_KEY` is missing or not 32 bytes (64 hex / base64). |
| Admin actions revert `OwnableUnauthorizedAccount` | `ADMIN_RELAY_PRIVATE_KEY` is not the account that deployed the contracts. |
| GN gets 403 `not the on-chain GN officer for <division>` | The account exists but `setGNOfficer` never landed — check `assigned` in the creation response, and re-run it from the relay. |
| Relay returns 503 `Cannot reach the election chain` | The node is down, or `RPC_URL` / `NEXT_PUBLIC_RPC_URL` points somewhere else. |
| Relay returns 503 `No Voting ABI recorded for chain N` | `deployedContracts.ts` lost the block for this chain id. Re-run `yarn deploy --network custom`. |
| A revert message shows as a generic failure instead of a custom-error name | The relay's decoding lost it. Send me the `errorName` field from the response and the matching `relay-audit.log` line. |
| `data/` is committed to git | It must not be — `packages/nextjs/.gitignore` has `/data/`. It holds sealed signing keys. |

---

## 10. M12 pass 2 gate — no-wallet auth, browser side

Pass 2 completes M12: the `/login` page, the `useElectionWriter` / `useElectionAuth`
seam, the admin and GN page refactors, the GN Accounts panel, and the session
branch of `/api/nic/hash`. After this, custom mode is operable end to end **with
no wallet extension installed at all**.

### Before you start: `yarn install`

Pass 2 adds four dev dependencies for the component tests
(`jsdom`, `@testing-library/react`, `@testing-library/dom`,
`@testing-library/user-event`). From the repo root:

```
cd /d D:\Projects\FYP\zk_voting
yarn install
```

### Phase A — offline checks

No chain and no dev server needed. From `packages/nextjs`:

```
cd /d D:\Projects\FYP\zk_voting\packages\nextjs
yarn test
yarn check-types
yarn lint
```

| Check | Expected |
|---|---|
| `yarn test` | Two projects run — `node` (185 cases) and `jsdom` (115, was 111 before §13's fix added four to `app/voting/admin/page`). All green. Pass 2 adds 135: `utils/chainMode`, `utils/navigation`, `services/auth/nicHashAuth` (node); `hooks/useElectionAuth`, `hooks/useElectionWriter`, `hooks/useGnDivision`, `app/login/page`, `components/ElectionIdentity`, `components/Header`, `app/gn/page`, `app/gn/register/page`, `app/voting/admin/page`, `app/voting/admin/_components/GnAccountsSection` (jsdom) |
| `yarn check-types` | Clean. Partially pre-verified: the agent could not run `tsc` against the repo directly (network mount — ~20k `.d.ts` reads, never finished inside a 45-second tool call), so it copied `typescript` and the type declarations to local disk and type-checked the source tree there. Every M12 pass-2 file is clean under `strict`. That check could not resolve a handful of packages (`@rainbow-me/rainbowkit`, `next-themes`, `blo`, `poseidon-lite`, …), so **run it yourself** — call sites touching those are still unverified. |
| `yarn lint` | Clean. Not run in the sandbox, same reason. |

Then both builds, which is the check that no client component accidentally
imports a server-only module:

```
# hardhat mode — no M12 environment configured at all
set NEXT_PUBLIC_CHAIN_BACKEND=
yarn build

# custom mode
set NEXT_PUBLIC_CHAIN_BACKEND=custom
yarn build
```

Both must be green. A failure mentioning `node:fs`, `node:crypto` or `bcryptjs`
in a client bundle means something under `services/auth/` was imported as a
value (not a type) from a `"use client"` file.

### Phase B — the click-through gate (custom mode, no wallet)

Node running, contracts deployed with `yarn deploy --network custom`, the custom
env column from MASTER §7 set in `.env.local`, `yarn dev` running. **Use a
browser profile with no MetaMask installed** — that is the whole point of the
gate. A private window with extensions disabled is enough.

| # | Step | Expected |
|---|---|---|
| 1 | Open `/voting/admin` | Redirected to `/login?next=%2Fvoting%2Fadmin` |
| 2 | Wrong password ×5 | Fifth attempt (or sooner) answers "Account locked … 15 minutes" |
| 3 | Sign in as `ADMIN_USERNAME` (wait out the lockout, or restart `yarn dev` to clear it) | Lands on `/voting/admin`; header shows the username and "Election Authority", **no Connect Wallet button** |
| 4 | Section 7 → create a division | Appears in the picker; `/blockexplorer` shows the transaction |
| 5 | Sections 1–5 on that division: question → candidates → start registration → start voting → end election → start new election | Each lands on chain; each is one line in `packages/nextjs/data/relay-audit.log` |
| 5b | Look at section 3, "Allowlist voters" | Shows a pointer to the GN portal, **not** a form. `addVoters` is GN-only in the relay whitelist — see `01-AUTH-DESIGN.md` §4 |
| 6 | Section 8 → create GN account for division 0 | One-time password shown once; row appears with **Assigned** |
| 7 | `type packages\nextjs\data\gn-accounts.json` | No 64-hex private key anywhere in the file |
| 8 | Sign out → sign in as the GN | Lands on `/gn`; the portal shows that division only |
| 9 | `/gn/register`: NIC → paste an address → phone → submit | `reserveNicHash` **and** `addVoters` both succeed. This is the step that proves the `/api/nic/hash` session branch works — before pass 2 it answered 401 for a wallet-less GN |
| 10 | While signed in as the GN, open `/voting/admin` | Bounced to `/gn` (middleware role routing) |
| 11 | Suspend that officer from the admin panel, then try to sign in as them | Sign-in refused |

Cross-division refusal is covered by unit tests (`relayPolicy.test.ts`,
`nicHashAuth.test.ts`); to check it by hand, edit the `divisionId` in a second
GN account and confirm the relay answers 403 "You may only act on your own
division."

### Phase C — hardhat regression

**Not optional.** Restore the hardhat env column and restart `yarn dev`, with
MetaMask enabled again:

| Check | Expected |
|---|---|
| Header | RainbowKit Connect Wallet button, exactly as before M12 |
| `/voting/admin` | No redirect; owner-gated by the connected wallet; every lifecycle action prompts MetaMask |
| `/gn` and `/gn/register` | GN resolved from the connected wallet; `addVoters` prompts MetaMask; NIC hashing still uses the `x-gn-signature` path |
| Admin section 3, "Allowlist voters" | The form is **back** — the owner may call `addVoters` directly here |
| `/login` | Renders "authenticate with a wallet", no credential form |
| Browser devtools → Network | **No request to `/api/auth/session` on any page.** The seam must not add traffic in hardhat mode |

### If something fails

| Symptom | What it means / what to do |
|---|---|
| `/login` redirect loop | The cookie is not being set — check `SESSION_SECRET` is 32+ chars and that you are on `http://localhost`, not an IP (SameSite=Strict) |
| Admin page shows "Sign in as the Election Authority" after a successful login | The session says `role: "gn"`. You signed in with a GN account |
| Every admin action fails `OwnableUnauthorizedAccount` | `ADMIN_RELAY_PRIVATE_KEY` is not the deploying account |
| GN enrolment fails 403 "no longer the assigned GN officer" | `setGNOfficer` never landed for that account — the Section 8 row shows **Not assigned**. Assign the address from Section 6 |
| GN enrolment fails 401 at `/api/nic/hash` | The session branch is not being taken — confirm `NEXT_PUBLIC_CHAIN_BACKEND=custom` is set for the **server** process, not just the browser |
| "Too many transactions in the last minute" during the ALL-divisions buttons | The relay's 30/min/session budget. Wait a minute; it is per session, not per division |
| Hardhat mode shows a Sign in button in the header | `NEXT_PUBLIC_CHAIN_BACKEND` is still `custom` in `.env.local`, or `yarn dev` was not restarted (it is a build-time inline) |

---

## 11. M13 gate — the mobile app on the custom chain

Four phases. Phase A is offline and takes under a minute. Phase B needs the node
and the Next.js app but no phone. Phases C and D are the device walkthrough, and
only they can prove the whole flow — the earlier phases exist so that a failure
there means something specific.

Like §8, this section needs **no Go toolchain**: the node has to be *running*,
but nothing here builds it.

### Before you start: `yarn install`

M13 adds one devDependency to `packages/mobile` (`vitest`) and three scripts
(`test`, `test:watch`, `chain-check`).

```
cd /d D:\Projects\FYP\zk_voting
yarn install
```

> If `yarn install` complains about `packages\mobile\node_modules\vitest`, delete
> that entry first (`rmdir packages\mobile\node_modules\vitest`) and re-run. The
> agent left a symlink there while verifying the suite and could not remove it
> from its sandbox — it points at a path that does not exist on your machine.

### Phase A — offline checks

No chain, no dev server, no phone.

```
cd /d D:\Projects\FYP\zk_voting\packages\mobile

yarn test            # raw: vitest run
yarn check-types     # raw: tsc --noEmit
```

**Expected**

| Command | Pass looks like |
|---|---|
| `yarn test` | `Test Files 3 passed`, `Tests 36 passed` |
| `yarn check-types` | no output |

The three test files, and what each is for:

| File | What it proves |
|---|---|
| `src/config.test.ts` (15) | The app resolves to 9494 / :9545 on `EXPO_PUBLIC_*` alone — M13's whole claim, as a test. A blank or malformed chain id falls back instead of becoming `NaN` or `0`, either of which viem signs with silently. |
| `src/services/api.test.ts` (7) | `tryFundBurner` never throws, whatever the faucet does — a disabled chain, a 502, an unreachable host. `fundBurner` still throws, so a caller that needs the failure can have it. |
| `src/services/chain.test.ts` (14) | The hand-built legacy transaction, driven over HTTP against a recording JSON-RPC server. Asserts the envelope (legacy, chain id, gas price, 600k/15M limits, nonce, selector), that **no** `eth_estimateGas` / `eth_feeHistory` / `eth_maxPriorityFeePerGas` call is made, that a zero gas price is used rather than the 1-gwei fallback, and that every vote gets a fresh sender. |

If `chain.test.ts` fails on a `gasPrice` assertion, read the helper comment in
that file first: a legacy transaction encodes zero as an empty RLP item and
viem's parser omits the key, so `undefined` there means zero, not missing.

### Phase B — the harness against a live node

**Terminal 1** — the node (reuse the M08/M09 data directory; do not reset):

```
cd /d D:\Projects\FYP\zk_voting\packages\blockchain
make run-dev
```

**Terminal 2** — the app in custom mode (`.env.local` as in §8/§9):

```
cd /d D:\Projects\FYP\zk_voting\packages\nextjs
yarn dev
```

**Terminal 3** — the harness. Defaults point at the **custom** chain, unlike
§8's, because M13 is a custom-chain milestone:

```
cd /d D:\Projects\FYP\zk_voting\packages\mobile
node e2e\mobile-chain-check.mjs
```

**Expected:** every line `[PASS]` or `[SKIP]`, final line `PASS`.

The checks that matter most:

| Check | Why it is here |
|---|---|
| `an unfunded burner transacts and is mined` | **THE gas-problem proof.** A wallet that has never held a wei signs, sends, and gets `status: success`, and its balance is still 0 afterwards. This is the milestone's headline result and the number to quote in the FYP report. |
| `eth_getTransactionCount agrees on latest and pending` | MASTER §10 pitfall 4. The app asks for `latest`; a disagreement would mean nonces that skip. |
| `the chain prices gas at zero` | The app's 1-gwei fallback fires only on RPC *failure*, so a non-zero answer here would quietly reprice every vote. |
| `a reverting vote returns decodable custom-error data` | MASTER §10 pitfalls 1 and 2, from the phone's side. The screens' "already voted" copy is derived from the custom error's *name*, so `Voting__…` has to survive the round trip. Needs `yarn compile` to have run — it reads the real `Voting` ABI. |
| `merkle-path serves a path the prover can use` | The API's root must equal the contract's. A mismatch shows up on the phone as `Voting__InvalidRoot` after a two-minute proof, which is the hardest failure in the system to diagnose. |

Two checks SKIP on a chain with no election data (`merkle-path`, and the
registration transaction unless you supply a key). To run the registration
check, pass an allowlisted voter's key:

```
set CHECK_VOTER_KEY=0x<private key of an allowlisted voter>
node e2e\mobile-chain-check.mjs
```

Add `--strict` in M14, once a full election exists, to turn the SKIPs into
failures.

In **hardhat mode** `CHECK_VOTER_KEY` does double duty: it also pays for the
reverting-vote transaction, which cannot come from an empty burner on a chain
that charges gas. Left unset it falls back to account #0 of the default
mnemonic, which genesis prefunds on both chains.

**Hardhat regression** (MASTER §6 rule 4) — the same harness, the other backend:

```
# yarn chain && yarn deploy, nextjs in hardhat mode, then:
cd /d D:\Projects\FYP\zk_voting\packages\mobile
set CHECK_CHAIN_ID=31337
set CHECK_RPC_URL=http://127.0.0.1:8545
node e2e\mobile-chain-check.mjs
```

The free-gas checks SKIP with a stated reason (Hardhat charges gas, so an
unfunded sender genuinely cannot transact); everything else must pass with the
same check names.

### What has and has not been run (2026-08-03)

Being precise about this, because the distinction matters for the report:

| | Status |
|---|---|
| Phase A (`yarn test`, `yarn check-types`) | **Run and green** — `36 passed (36)`, `tsc` silent |
| Phase B, against a **mock** JSON-RPC node | **Run and green** in both modes — custom `16 passed, 0 failed, 2 skipped`; hardhat `10 passed, 0 failed, 4 skipped` |
| Phase B, against the **real** node | **Not run.** No Go toolchain in the agent's sandbox, as with every milestone so far |
| Phases C and D (device) | **Not run.** Needs a phone |

The mock run is worth what it is worth: it proves the harness executes every
branch, parses what a node returns, and reports sensibly — not that the node
behaves. The numbers to record in the FYP report come from your phase B run.

The hardhat-mode mock is the one that earned its keep. It rejects any
zero-priced transaction the way Hardhat really does, and that caught a bug in
this harness before you ever saw it: the reverting-vote check signed with
`gasPrice: 0` from an empty burner, so on Hardhat it was refused as *underpriced*
and never reached the revert it exists to test. It now takes the price from the
node and the sender from a funded account. The lesson is M11's, again: a check
that only ever runs against one backend is not yet a check.

### Phase C — the device flow

This is the milestone's real gate and it needs a phone. Point the app at your
machine's **LAN IP**, not `localhost` — a device resolves `localhost` to itself.

`packages\mobile\.env` (or the shell you run `expo start` from):

```
EXPO_PUBLIC_API_URL=http://<LAN-IP>:3000
EXPO_PUBLIC_RPC_URL=http://<LAN-IP>:9545
EXPO_PUBLIC_CHAIN_ID=9494
```

The node binds all interfaces and the Next.js dev server needs `--hostname
0.0.0.0` (or `yarn dev -H 0.0.0.0`) to be reachable from the phone. Check from
the phone's browser before blaming the app:

```
http://<LAN-IP>:3000/api/election      → JSON with chainId 9494
```

Then, per the milestone's step 4: onboarding → GN enrols you via the web portal
(M12) → register (OTP + biometric) → the WebView proof → vote → "Verify My Vote".

| Step | Expected |
|---|---|
| Register | Transaction mined; `/blockexplorer` shows it; a `NewLeaf` log is present |
| Vote | Receipt `status: 1` at `gasPrice 0`, from a burner the faucet never funded |
| Vote again | The app's existing "already voted" error, decoded from the node's revert data |
| Verify My Vote | Finds the nullifier on-chain and names the candidate |
| `/results` on the web | The tally moves |

### Phase D — the zero-balance proof by hand

Worth doing once explicitly, because it is the claim the whole custom chain was
built for. Stop the Next.js app (or block `/api/faucet`) and cast a vote. The
top-up will fail, the app will carry on, and the vote will land. Before M13 this
aborted with "Could not fund the anonymous wallet".

Then confirm on-chain:

```
curl.exe -s -X POST localhost:9545 -H "content-type: application/json" ^
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"0x<burner>\",\"latest\"]}"
```

`0x0`, after that address sent a 15M-gas transaction.

### If something fails

| Symptom | What it means / what to do |
|---|---|
| `yarn test` can't find `vitest` | `yarn install` from the repo root, and see the note about the stale symlink above. |
| `yarn check-types` errors only in `*.test.ts` | Same cause — the vitest types are not installed yet. |
| Harness exits 2 with "Cannot reach the node" | The node isn't running, or `CHECK_RPC_URL` was set in a different terminal (§0). |
| Harness exits 2 with a chain-id mismatch | `CHECK_CHAIN_ID` and the node disagree; it refuses to run rather than report confusing failures. |
| `a reverting vote returns decodable custom-error data` SKIPs | `yarn compile` hasn't run — it reads `packages/hardhat/artifacts/.../Voting.json`. |
| That same check FAILs with "no revert data in the error" | The node is returning a revert without the `data` field. This is a node bug and a serious one: every custom-error message in both the app and the web UI depends on it. Send me the full error object. |
| `an unfunded burner transacts and is mined` fails with `insufficient funds` | The node is not applying the free-gas policy — check `eth_gasPrice` answers `0x0` and that the transaction really carried `gasPrice: 0`. |
| The phone shows "Network request failed" everywhere | `localhost` in the env instead of the LAN IP, or the Next.js server is bound to loopback only. Test from the phone's browser first. |
| Registration fails with "we couldn't verify your eligibility" | The account is not on that division's allowlist, or you selected a different division than the GN enrolled you for. Not a chain problem. |
| The vote's proof step hangs | The WebView prover, untouched by this milestone (MASTER §6 rule 3). Confirm the same phone works in hardhat mode before investigating. |
| `git diff packages/mobile` shows more than the M13 files | Check the line endings before the content — the working tree already carries CRLF-only diffs on files no milestone has touched. |

---

## 12. M14 gate, part 1 — the full election (`make e2e`)

The first gate that runs an actual election. Everything earlier proved one
layer; this drives all of them at once, on a chain it creates and destroys:

```
fresh node -> yarn deploy --network custom -> admin sets up the election
-> GN officer allowlists five voters -> each registers a commitment
-> Merkle path rebuilt from NewLeaf logs -> REAL UltraHonk proof
-> vote from an UNFUNDED burner -> tally / nullifier / double-vote refused
-> node restarted, state intact -> cmd/audit replays the whole chain
```

M14's other deliverables (the swap drill, the docs, `RESULT.md`) come after
this passes, because their numbers come from this run.

### Before you start

Three things beyond the §1 setup, and the first two are the ones that bite:

**1. `npm install` in `e2e/` again.** M14 adds four dependencies — `@aztec/bb.js`,
`@noir-lang/noir_js`, `@zk-kit/lean-imt` and `poseidon-lite`. The bb.js
download is large; expect a minute or two.

```
cd /d D:\Projects\FYP\zk_voting\packages\blockchain
make diff-install
```

**2. The first proof needs internet access.** bb.js fetches its structured
reference string from `aztec-ignition.s3.amazonaws.com` and caches it in
`%USERPROFILE%\.bb-crs`. On the first run this is a few hundred megabytes and
several minutes; afterwards it is instant and offline. If you see a network
error naming that host, this is why — it is not a chain problem.

**3. Nothing else may be listening on :9545.** The harness starts its own node
and refuses to run if the port answers, rather than quietly driving a chain it
does not control. Stop any `make run` / `make run-dev` first.

It uses its own data directory, `data-e2e/`, which it wipes at the start of
every run. The `data/` directory that M08 built, M09 audited and M11-M13 read
from is untouched — deliberately, so this gate cannot destroy the chain those
gates depend on.

### Phase A — offline

```
cd /d D:\Projects\FYP\zk_voting\packages\blockchain

make vet
make fmt
make test
make e2e-core-test        # raw: cd e2e && node --test lib/election-core.test.mjs
```

`make e2e-core-test` is new in M14 and takes about a second. It unit-tests the
election's cryptography and Merkle-path logic with no node, no chain and no
proving. **Expected: `# pass 45`, `# fail 0`.**

New in M14's Go suite, worth watching for by name in `make test` output. All
four exist because of one fault the first gate run found — see "Durability"
below:

| Test | What it proves |
|---|---|
| `TestSealedBlocksAreFlushedToDisk` | A sealed transaction block is written **and then flushed**. Before M14 it was only written. |
| `TestEverySealingPathFlushesToDisk` | All three sealing paths — transaction, empty block, system-op — flush exactly once. A regression that synced only transaction blocks would still lose an `evm_mine` or a `hardhat_setBalance`, and M07 made system-op blocks part of the audited history, so a lost one is a hole in the replay. |
| `TestASyncFailureFailsTheSeal` | A disk that will not flush fails the seal loudly. Swallowing it would be the worst outcome: the caller gets a receipt, the block is not durable, and nothing says so. |
| `TestPersistFlushesAfterWritingNotBefore` | The flush comes *after* the write it flushes. A sync in the wrong order guarantees nothing, and a counter alone cannot tell the two apart. |

Two of its suites check against something outside this repo's JavaScript,
which is what makes them worth having:

| Suite | What it proves |
|---|---|
| `against the circuit's own fixture` | The values in `packages/circuits/Prover.toml` — produced independently and accepted by `nargo` — are reproduced exactly: `poseidon1(42)` gives the recorded nullifier hash, and the recorded root recovers index 2. If poseidon-lite, the field, or the path-walking bit order ever diverged from the circuit, this fails. Testing poseidon against poseidon would not. |
| `against the compiled circuit's ABI` | The witness object has exactly the parameters `circuits.json` declares, with the declared array length of 16. A renamed or reordered circuit input is caught in a second here instead of as an opaque bb.js failure ten minutes into the full gate. |

The `buildMerklePath` suite builds real LeanIMTs of 1, 2, 3, 5, 8 and 9 leaves
and re-walks each path the way the *circuit* does — little-endian index bits,
poseidon2 per level — rather than the way LeanIMT does. That is the whole point
of the brute-forced circuit index, so verifying it any other way would verify
nothing. The one-leaf case is deliberate: a division with a single registered
voter has a path with no siblings at all, `depth = 0`, and the root *is* the
commitment.

### Phase B — the gate

One command, no other terminals:

```
cd /d D:\Projects\FYP\zk_voting\packages\blockchain
make e2e
```

Expect it to take a few minutes — most of it the UltraHonk proof and the
`yarn deploy` run. Add `E2E_ARGS="--quiet"` (Git Bash / PowerShell only, see
§0) to suppress the node's own log; from cmd.exe use `node e2e\election.mjs
--quiet` directly.

> **Do not append a `#` comment to a `make` command line.** `make e2e   # note`
> is parsed as a second target and stops with `No rule to make target '#'`.
> The command before it still ran; only the comment fails.

The deploy step runs with hardhat-deploy's `--reset` because the chain is new
every time — see the troubleshooting table for why that is mandatory rather
than tidy. It rewrites `packages/hardhat/deployments/custom/`, but the
addresses are deterministic, so `git diff packages/nextjs/contracts/deployedContracts.ts`
should stay empty. If it does not, that is worth telling me about.

**Expected:** every line `[PASS]`, a "numbers for the report" block, then
`PASS`. The checks, in order of what they establish:

| Check | What it establishes |
|---|---|
| `the real deploy scripts complete` | This is `yarn deploy --network custom` itself, not a private deployment path. A break in the deploy scripts fails here rather than in front of an examiner. |
| `the Merkle path rebuilt from NewLeaf logs matches the contract's root` | `eth_getLogs` and `eth_call` agree. A mismatch would reach a voter as `Voting__InvalidRoot` two minutes after their proof started — §11 calls that the hardest failure in the system to diagnose. Here it is one line. |
| `the path is non-trivial, so the sibling ordering is actually exercised` | A guard on the gate itself. Five voters register, and the one who votes is the middle leaf, so the path has siblings on both sides and the circuit-index search really runs. With a single registered voter the root would simply *be* the commitment, the path would be empty, and the check above would pass while proving nothing. |
| `a real UltraHonk proof is generated` | Same Noir + Barretenberg (keccak) pipeline as the web UI and the mobile WebView prover. Not a fixture. |
| `the burner votes without ever being funded` | **THE headline result.** A wallet created seconds earlier, holding 0 wei before and after, sends a 15,000,000-gas transaction and it is mined. This is the problem the custom chain exists to solve. |
| `the chosen candidate's tally increases by exactly one` | And no other candidate's does. |
| `replaying the proof from another wallet is rejected` | A valid proof resubmitted by a different burner is refused with the custom error **by name** (`Voting__NullifierHashAlreadyUsed`), which is what the phone's "you have already voted" copy is derived from. |
| `the rejected vote is not mined into a block` | MASTER §10 pitfall 2. An election audit should not have to explain a transaction that did nothing. |
| `the chain comes back at the same head after a restart` | M09's property, now over a chain containing a verified ZK proof. |
| `cmd/audit replays the whole election` | The claim the report rests on: an observer trusting only the block list re-derives every state root, including the one produced by verifying the proof. |

Record the "numbers for the report" block — deploy time, witness time, proof
time, vote submit-to-receipt latency, and the audit line. Those are the M14
figures for the FYP report.

### Durability: what the first gate run found

Worth recording in full, because it is the most substantive thing M14 turned up
and it belongs in the FYP report.

The first run reached the end of the election — real proof, free-gas vote,
replay refused — and then failed two checks in the durability section: the node
came back **two blocks short** of where it had been, and the tally read `0/0/0`.
One of the lost blocks contained the vote, for which a receipt had already been
returned to the client.

This was not a replay fault and not a consistency fault. M09 made the six
writes that seal a block atomic, so the database can never be torn — and
indeed `cmd/audit` passed cleanly on what survived, because a chain that is
merely *short* is still perfectly self-consistent. What M09 never addressed was
durability. go-ethereum configures Pebble with `writeOptions: pebble.NoSync`,
and says so in its own comment: *"recent data may be lost in the event of an
application-level panic... Geth is expected to handle recovery from an unclean
shutdown."* For a general-purpose client that is a sound trade — a node missing
its last few blocks re-syncs them from peers. This chain is the sequencer.
There are no peers to re-sync from, and the RPC returns a receipt the moment
the write lands in memory.

`internal/chain/seal.go`'s `persist` now calls `db.SyncKeyValue()` after the
batch, which writes a no-op WAL record in sync mode and flushes every preceding
write with it. One fsync per sealed block — and since this chain seals one
transaction per block, one per transaction. That is a deliberate cost, and a
small one beside the 2.9 s a vote's proof takes.

Two notes for reading the result:

- **Graceful shutdown was never affected.** §6 Phase C — Ctrl+C, restart,
  resume at height 787 — worked before this change and works after. The gap was
  only ever visible on abrupt termination.
- **The harness kills abruptly on purpose, and on Windows has no choice.**
  Node.js cannot send a POSIX signal to a child process there; `kill()` is
  documented as terminating "forcefully and abruptly (similar to SIGKILL)". So
  the restart check is really a crash test, which is the more useful of the two
  — and the reason this was found at all.

The `AUDIT OK` line alone did not catch it, which is why there is now a second
check: the audited height must equal the height the election reached. A green
tick over a shorter story than the checks above told is not a pass.

### Two things the harness does that are not obvious

**It registers five voters, not one.** A division with a single registered
voter has a Merkle tree whose root *is* that voter's commitment: the path has
no siblings, the circuit index is 0, and the sibling ordering and index
brute-force — the most bug-prone code in the flow — never execute. The voter
who actually votes is the middle leaf, so the path carries siblings on both
sides and a left/right ordering bug cannot pass by symmetry. The
`path is non-trivial` check above exists so that this cannot silently regress.

**It reassigns the GN seat before enrolling anyone.**

### Why the GN separation is not the deploy script's default

`01_deploy_divisions.ts` assigns Kaduwela's GN seat to the deployer, so a demo
can be driven from one wallet. The harness reassigns it to account #1 before
enrolling anyone, so the voter is allowlisted by an account that is *not* the
election authority. Without that, the whole gate would pass with the owner
quietly doing the GN's job, and the role separation `01-AUTH-DESIGN.md` §4
describes would be untested.

### What has and has not been run (2026-08-03)

Being precise, as §11 was:

| | Status |
|---|---|
| `make e2e-core-test` (44 offline unit tests) | **Run and green** |
| Every harness phase, against a **mock** JSON-RPC chain | **Run and green** in both modes — free-gas and a paying (Hardhat-like) control. The mock uses the real `Voting`/`ElectionRegistry` ABIs for every encode and decode, recovers the sender from each signed transaction, and enforces the contract's phase and access-control rules — so calldata, event decoding, receipt handling, revert decoding and the free-gas branch are all genuinely exercised |
| The proof step | **Not run.** bb.js needs to download its SRS; the agent's sandbox has no route to S3. The control run stubs the prover |
| `make e2e` against the **real node** | **Not run.** No Go toolchain in the agent's sandbox, as with every milestone so far |

So: the harness is proven to execute, encode and parse correctly. Whether the
*node* executes a Honk verification identically to Hardhat is what your run
answers — and it is the interesting question, since `HonkVerifier.verify()` is
the most EVM-sensitive thing this application does.

### If something fails

| Symptom | What it means / what to do |
|---|---|
| `something is already serving http://127.0.0.1:9545` | A `make run` / `make run-dev` / `make run-cluster` is still up. Stop it. The harness refuses rather than driving a chain it does not own, because the restart and audit steps would then operate on the wrong data directory. |
| `packages/hardhat/deployments/localhost does not exist` | §5.1's footgun, now a hard stop instead of a silent one: deploying to `custom` would regenerate `deployedContracts.ts` without the 31337 entry. The message names the fix. `--allow-single-network` overrides it if you really mean to. |
| ~~`cannot get the transaction for PoseidonT3's previous deployment, please check your node synced status`~~ | **Hit and fixed 2026-08-03, on the first gate run.** Not a sync problem and not a node fault, despite the wording. `hardhat-deploy`'s `fetchIfDifferent` reads the `transactionHash` recorded in `deployments/custom/PoseidonT3.json` and asks the node for that transaction, to decide whether anything changed. This gate creates a brand-new chain every run, so that transaction has never existed on it, the provider returns null, and hardhat-deploy stops. The records were simply describing a chain that no longer exists. The harness now passes hardhat-deploy's own `--reset` whenever it created the chain. Safe precisely here: addresses are deterministic, so a successful run regenerates byte-identical records and `deployedContracts.ts` does not move. |
| A deploy failure whose exit code is `3221226505` | `0xC0000409`. ts-node's libuv teardown aborting on Windows *after* the real error was already printed (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`). The exit code carries no information; the harness now extracts and prints the meaningful `Error:` line instead. |
| A network error naming `aztec-ignition.s3.amazonaws.com` | The SRS download. Needs internet on the first run only. |
| `could not read the compiled circuit` | `packages/nextjs/public/circuits.json` is missing — it comes from `nargo compile` in `packages/circuits`. |
| `missing contract artifact` | `yarn compile` at the repo root. |
| `the Merkle path rebuilt from NewLeaf logs matches the contract's root` FAILS | A node bug, not a harness bug: `eth_getLogs` and `eth_call` disagree. Send me the derived root, the contract's root and the division address. |
| `the vote transaction is mined successfully` fails with a bare `execution reverted` and no data | Suspect gas before suspecting the proof — §5.5 records exactly this, and it was an out-of-gas both times. `Voting.vote()` is the most expensive call in the system. |
| `the vote transaction is mined successfully` fails with `Voting__InvalidProof` | The interesting failure, and the one this gate exists to find. The proof was accepted by Barretenberg and rejected by the EVM, which means the node's execution of `HonkVerifier.verify()` differs from Hardhat's. Re-run `yarn test:custom` (§5.5) first to see whether the contract suite still passes, then send me both results. |
| `replaying the proof ... is rejected` reports an error name of `null` | The revert `data` is not reaching us. Every custom-error message in the phone app and the web UI depends on that field (MASTER §10 pitfall 1). Send me the whole error object. |
| `cmd/audit replays the chain` FAILS | The serious one, exactly as in §6: sealing and replay disagree over a chain that now contains a ZK verification. Send me the block number and the two roots. |
| `the audited chain is the one the election ran on` FAILS while the audit itself passes | The chain is self-consistent but shorter than the election was — blocks were lost. If the restart check also failed, read the durability section above. If the restart check *passed*, this is new and I want to see it. |
| ~~The restart loses the last blocks and the tally reads `0/0/0`~~ | **Hit and fixed 2026-08-03, on the first gate run.** Sealed blocks were written but never flushed; an abrupt stop lost them. `persist` now fsyncs. Full account in the durability section above. |
| `sync block N (0x…) to disk` in the node log | The new durability check failing for real: the write landed but the disk would not flush it. The seal is refused rather than acknowledged, which is correct. Investigate the disk, not the chain. |
| The run hangs after the last check | Barretenberg's worker threads. `generateVoteProof` destroys the backend in a `finally`; if it still hangs, tell me — the process should exit on its own. |
| The output ends with `INCOMPLETE` | The run threw before its last phase rather than failing a check — the error is printed immediately below, and the checks above it are the context for reading it. Exit code 2, as opposed to 1 for a genuine check failure. |
| `every allowlisted voter registers a commitment` fails on voter 3 or 4 | The accounts are mnemonic indices 4–8. If one is not genesis-prefunded the registration cannot pay for itself on a chain that charges gas; on the custom chain it should not matter. Check `internal/state/genesis.go` still prefunds all 20. |

### Re-running

Safe to run repeatedly: `make e2e` wipes `data-e2e/` and redeploys every time.
It is also idempotent against a chain that already ran an election — the first
thing it does to a division is `resetElection()` if it is not in Setup — so
`--no-deploy` against a warm chain works too.

`make reset-e2e` reclaims the disk afterwards.

---

## 13. Runtime divisions and NIC enrolment (fixed 2026-08-03)

Not a gate — a defect found by reading the contracts, fixed, and recorded here
because the symptom is misleading and the sample data hides it.

### What was wrong

Admin section 7, "Add New Division", called
`ElectionRegistry.createDivision()` and reported success. GN enrolment goes
through `NicRegistry.reserveNicHash`, whose first check is
`require(s_votingContracts[votingContract], "Unregistered division")` — and
nothing ever called `NicRegistry.setVotingContract` for a division created that
way. So a hand-made division looked complete, appeared in every picker, and
then failed at `/gn/register` with a bare revert string.

Three things kept it hidden:

- **The sample divisions are exempt.** `deploy/01_deploy_divisions.ts`
  authorises Kaduwela, Colombo Central and Gampaha explicitly, so every demo
  that used them worked.
- **The contract suite was exempt.** `test/NicRegistry.ts` authorises its
  division in `beforeEach`, so all five of its tests started from a state the
  defect cannot reach.
- **The error named the wrong thing.** `/gn/register` special-cased
  `NicRegistry__AlreadyUsed` and `Not owner or GN` but not this, so it fell
  through to the raw revert text, which sounds like the division does not exist.

It affected **both chain modes**. Nothing about it is custom-chain specific.

### Why the fix is in the UI and not the contract

`NicRegistry.setVotingContract` is `onlyOwner`, and the owner is the deployer,
not `ElectionRegistry` — which holds no reference to `NicRegistry` at all.
Making `createDivision` self-authorising therefore needs an ownership or
authorised-factory change to `NicRegistry`, a redeploy, and new addresses. It is
also out of bounds under MASTER §6 rule 3. The requirement is real and permanent
and belongs to whoever creates a division, so the caller now meets it.

### What changed

| Change | Where |
|---|---|
| Section 7 now sends **two** transactions: `createDivision`, then `setVotingContract` for the address read out of the `DivisionCreated` event | `app/voting/admin/page.tsx` |
| A partial failure says the division *was* created and points at the repair, instead of reporting a clean error | same |
| Divisions that are not authorised are listed with an **Authorise** button — this is the repair path for divisions created before the fix | same |
| `/gn/register` maps "Unregistered division" to an explanation naming section 7 | `app/gn/register/page.tsx` |
| 10 tests pinning the contract behaviour the fix relies on | `packages/hardhat/test/DivisionEnrolment.ts` |
| 4 tests pinning the panel's two-transaction behaviour and the repair list | `app/voting/admin/page.test.tsx` |

Authorisation is read from the `VotingContractUpdated` event, because
`s_votingContracts` is a private mapping with no getter — there is no other way
for a client to answer the question. `DivisionEnrolment.ts` asserts that event's
shape so a contract change cannot make the indicator go blind.

### Checking it by hand

Any chain whose divisions were created through the admin panel before this fix
will show the warning in section 7. Click **Authorise** once per division.

To verify the whole path on a fresh chain, add this to §10's click-through
table — it is the walkthrough step whose absence let the defect survive:

| # | Step | Expected |
|---|---|---|
| 4b | Section 7 → create a division, then sign in as a GN assigned to it and enrol a voter at `/gn/register` | Both `reserveNicHash` and `addVoters` succeed. Before this fix the first one reverted "Unregistered division" |

### What has and has not been run

| | Status |
|---|---|
| The defect itself | **Confirmed by reading the contracts**, and by tracing every call site |
| `DivisionEnrolment.ts`, `page.test.tsx` additions | **Written, not executed.** `packages/nextjs/node_modules` holds Windows-native binaries (`@esbuild/win32-x64`), so vitest cannot start in the agent's Linux sandbox, and there is no Go/Hardhat toolchain either. Both files parse cleanly under TypeScript's own parser; that is a syntax check, not a test run |
| The fix in a browser | **Not run.** Needs the §10 click-through |

So: run `yarn test` in `packages/nextjs` and `yarn test` in `packages/hardhat`
before trusting the counts above.

---

## 14. What to send me if a gate fails

Paste the **full terminal output** of the failing command, plus the command you ran.
For Go build failures, the compiler error with its file:line is enough. For harness
failures, the `[FAIL]` lines carry an `our=… hardhat=…` diff — that diff is the fix
instruction.
