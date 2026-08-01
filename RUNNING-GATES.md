# Running the milestone acceptance gates locally

> Written 2026-08-01. Every milestone agent so far has run in a sandbox with **no Go
> toolchain and no network access to install one**, so the Go half of each gate
> (`go vet` / `gofmt` / `go test`) and every check that needs two live nodes has to be
> run on your machine. This file is the missing "how".
>
> Applies to M05 (write path), M06 (`eth_getLogs`) and M07 (dev/compat methods).
> Later milestones add their own gate commands; the setup in §1 does not change.

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

### 1.6 A note on `packages/blockchain/.env`

That file is a **leftover from the v1 node** — it sets `NODE_ID`, `PEERS` and
`ALLOWED_ORIGIN`, none of which v2's `internal/config` reads. It is harmless (v2 falls
back to its defaults) but misleading. `.env.example` is the current reference. Safe to
delete or replace with a copy of `.env.example`.

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

**Expected:** 55 passing (13 `GNAndRegistry` + 5 `NicRegistry` + 37 `Voting`).

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

## 6. What to send me if a gate fails

Paste the **full terminal output** of the failing command, plus the command you ran.
For Go build failures, the compiler error with its file:line is enough. For harness
failures, the `[FAIL]` lines carry an `our=… hardhat=…` diff — that diff is the fix
instruction.
