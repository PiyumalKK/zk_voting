# M10 — Replication: 1 primary + 2 read replicas (mTLS)

Status: pending · Depends: M09 · Package: `packages/blockchain`
Parallel-safe with M11–M13 (different packages).

## Goal
The 3-node production topology: a sequencer that pushes sealed blocks to verifying replicas;
replicas serve all read RPC locally and transparently forward writes. Replica count is pure
config — nothing in code assumes "2".

## Deliverables — `internal/p2p/`
1. `tls.go` (salvaged M01): mTLS server+client config; `make gen-certs` target creates a
   local CA + per-node certs into `certs/` (openssl script, documented).
2. Wire protocol (HTTPS + mTLS on `P2P_PORT`, JSON bodies, RLP-hex block payloads):
   - `POST /p2p/block` — primary → replicas on every `NewBlockEvent` (from M03). Body:
     `{number, rlp}`. Replica: verify parent linkage → **re-execute fully** (same code path
     as `cmd/audit`) → state root must match header → persist. Mismatch ⇒ 409 + log
     `CRITICAL state root mismatch` (this is the tamper-evidence property).
   - `GET /p2p/blocks?from=N&limit=500` — catch-up pull, served by primary.
   - `GET /p2p/head` — `{number, hash}`.
3. Replica mode (`ROLE=replica`):
   - Boot: compare local head to primary head → pull gap → then serve.
   - Steady state: accept pushes; poll `/p2p/head` every 5 s as a missed-push fallback.
   - RPC behavior: all reads local; `eth_sendRawTransaction` + dev methods proxied to
     `PRIMARY_RPC_URL` (plain HTTP forward, return primary's response verbatim);
     `/health` reports `{role:"replica", height, primaryHeight, synced:bool}`.
4. Primary mode: pushes are fire-and-forget with retry queue (in-memory, 3 retries,
   exponential backoff); a slow replica never blocks sealing.
5. `make run-cluster` — background-process script or docker-compose: primary :9545/:9546,
   replicas :9555/:9556 and :9565/:9566, shared CA certs, distinct `DATA_DIR`s.

## Tests
- Go (httptest with real TLS certs from a test CA): push accept/reject (bad cert, bad
  parent, tampered state root), catch-up pagination, forward-write proxy.
- Cluster script test `e2e/cluster-test.mjs`:
  1. start 3 nodes → deploy stack to primary → all heads converge;
  2. write via **replica** RPC (forwarding) → succeeds, appears on all 3;
  3. kill replica B → 20 writes → restart B → catches up, state root matches;
  4. reads (`eth_call` getVotingData, `eth_getLogs`) identical on all 3 nodes;
  5. tamper test: hand-craft a block push with a wrong state root → replica rejects (409).

## Acceptance gate
```
cd packages/blockchain && make test && make gen-certs && make run-cluster
node e2e/cluster-test.mjs      # all 5 scenarios PASS
```
README gains a topology diagram + cert rotation note.
