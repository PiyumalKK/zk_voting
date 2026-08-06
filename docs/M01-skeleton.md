# M01 — Teardown, module layout, config, logging, health

Status: **done** (2026-07-29). `go mod tidy` run locally by the user with real network
access; acceptance gate re-verified after (build/vet/gofmt/test all clean, `/health` +
graceful-shutdown behavior confirmed). Note: `go mod tidy` correctly dropped
`github.com/ethereum/go-ethereum` from `go.mod` — nothing in M01's source imports it yet;
see the NOTE comment in `go.mod` — M02 re-adds it (pinned to v1.16.8) when it's first
imported. · Depends: — · Package: `packages/blockchain`

## Goal
Clean slate with production scaffolding: v1 code removed (salvage kept), new layout from
MASTER §4, env config, structured logging, graceful shutdown, health endpoint, upgraded deps.

## Deliverables
1. **Delete:** `internal/{api,core,evm,network,persistence}`, `assets/`, `integration-test/`,
   `PLAN.md`, `API.md`, `BLOCKCHAIN_OVERVIEW.md`, `CONTRACT_CHANGE_CHECKLIST.md`, old
   `cmd/node/main.go` body. Also delete `packages/evm-sandbox/` entirely.
   **Keep (move):** `internal/security/tls.go` → `internal/p2p/tls.go` (used in M10);
   `internal/security/rsa.go` is deleted (RSA admin auth is superseded by `01-AUTH-DESIGN.md`).
2. `go.mod`: upgrade `github.com/ethereum/go-ethereum` to current stable **v1.16.x**
   (needed for Prague/Cancun EVM rules; see MASTER §3). Keep `zerolog`. Add nothing else yet.
3. `internal/config/config.go`: parse + validate every node var from MASTER §7 into a
   `Config` struct. Fail fast with a clear message on invalid values (bad port, missing
   replica vars when `ROLE=replica`, …).
4. `cmd/node/main.go`: load config → init zerolog (level from env, console writer in dev) →
   start a bare HTTP server on `RPC_PORT` serving only `GET /health` →
   `{"status":"ok","role":"primary","chainId":9494,"height":0}` → graceful shutdown on
   SIGINT/SIGTERM (context + `http.Server.Shutdown`).
5. `Makefile`: `build`, `run`, `test`, `vet`, `fmt`, `reset` (delete `DATA_DIR`), `tidy`.
6. `.gitignore` entries: `data/`, `certs/`, binary.

## Spec notes
- Config precedence: env only (no flags/files) — matches how the rest of the monorepo works.
- `Config.Validate()` returns all errors joined, not just the first.
- Health handler lives in `internal/rpc/health.go` so M04 can mount it on the real server.

## Tests
- `config_test.go`: table-driven — defaults, overrides, invalid port, replica-role
  validation, CORS list parsing.
- `health_test.go`: httptest — 200, JSON shape.

## Acceptance gate
```
cd packages/blockchain
make vet && make test && make build
make run &   # then:
curl -s localhost:9545/health   # → {"status":"ok",...}
kill %1      # log shows clean shutdown
git grep -l "typed bridge\|bolt" internal/ | wc -l   # → 0
```
