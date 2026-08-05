# Running the milestone acceptance gates locally

> Written 2026-08-01. Every milestone agent so far has run in a sandbox with **no Go
> toolchain and no network access to install one**, so the Go half of each gate
> (`go vet` / `gofmt` / `go test`) and every check that needs two live nodes has to be
> run on your machine. This file is the missing "how".
>
> Applies to M05 (write path) and M06 (`eth_getLogs`). Later milestones add their own
> gate commands; the setup in §1 does not change.

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
| `make fmt` lists files | Cosmetic. `gofmt -w .`, re-run. |
| Build error on `rawdb.ReadTransaction` / `ReadRawReceipts` / `EffectiveGasPrice` | Version-sensitive go-ethereum identifiers introduced in M05 (`internal/chain/txlookup.go`). Check the real signature in `$(go env GOMODCACHE)\github.com\ethereum\go-ethereum@v1.16.8\core\rawdb\` and tell me — I'll adjust. |
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

## 4. What to send me if a gate fails

Paste the **full terminal output** of the failing command, plus the command you ran.
For Go build failures, the compiler error with its file:line is enough. For harness
failures, the `[FAIL]` lines carry an `our=… hardhat=…` diff — that diff is the fix
instruction.
