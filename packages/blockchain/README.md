# zk-blockchain node (v2)

A permissioned EVM chain that speaks the Ethereum JSON-RPC subset this app
uses. It executes ordinary EVM bytecode and knows nothing about `Voting.sol`,
`ElectionRegistry.sol` or `HonkVerifier.sol` — contracts are deployed to it
with the same `hardhat-deploy` scripts used against Hardhat, and switching
between the two backends is an environment-variable change.

It runs in one of two modes, selected by `CONSENSUS_MODE`:

| Mode | Who may seal a block |
|---|---|
| `solo` (default) | one sequencer; replicas verify and copy |
| `bft` | four co-equal validators; a block is final only once a quorum of three has signed it |

`solo` is everything this document describes below. For `bft` — the protocol,
the safety argument, and the kill-a-node demonstrations — see
[`CONSENSUS.md`](CONSENSUS.md).

See `../../00-MASTER.md` for the design and milestone plan, `RPC.md` for the
implemented method matrix, and `../../RUNNING-GATES.md` for how to run each
milestone's acceptance gates.

> This file currently covers **operations** only — restart, audit, and the
> failure modes an operator will actually meet. M14 expands it into the full
> runbook.

## Quick start

```
make run          # build and run on :9545 with the defaults in .env.example
make run-dev      # same, plus the evm_*/hardhat_setBalance dev namespaces
make test         # unit tests
make reset        # delete ./data and start from a fresh genesis
```

Configuration is environment-only; every variable, its default and its
meaning are in `.env.example`.

A single node needs no certificates and opens no P2P port. Replication is
opt-in: a node becomes part of a cluster only when `PEERS` (sequencer) or
`ROLE=replica` is set.

## Topology

```
                       writes (eth_sendRawTransaction, evm_*)
   web / mobile ─────────────────┐
        │  reads                 │        ┌──────────────────────────┐
        │                        └───────▶│  PRIMARY (sequencer)     │
        │                                 │  RPC :9545  P2P :9546    │
        │                                 │  validates → executes →  │
        │                                 │  seals 1-tx blocks       │
        │                                 └───────────┬──────────────┘
        │                        push (mTLS, POST /p2p/block)        │
        │                    ┌───────────────────────┴───────────┐   │
        ▼                    ▼                                   ▼   │ pull
   ┌─────────────────────────────────┐        ┌──────────────────────┴──────┐
   │ REPLICA 1  RPC :9555 P2P :9556  │        │ REPLICA 2  RPC :9565 :9566  │
   │ re-executes every block,        │        │ same                        │
   │ verifies its state root,        │        │                             │
   │ serves reads, forwards writes ──┼────────┼──▶ to the primary's RPC     │
   └─────────────────────────────────┘        └─────────────────────────────┘
```

- **One writer.** Only the sequencer seals blocks, so there are no forks and
  no consensus protocol. A replica that is sent a block it did not ask for
  still verifies it; a primary refuses pushed blocks outright.
- **Trust-but-verify.** A replica re-executes every block it receives with the
  same code `cmd/audit` uses, and refuses any block whose state root, receipts
  root, bloom or gas does not follow from its own execution. mTLS decides
  *who may connect*; re-execution decides *what is true*. A compromised
  sequencer holds a valid certificate and still cannot make a replica accept
  a rewritten history.
- **Self-healing.** Pushes are best-effort. Each replica also polls the
  primary's head every 5 s and pulls whatever it is missing, so a node that
  was down, or whose push was dropped, converges on its own.
- **Replica count is configuration.** Nothing in the code assumes two.
- **One writer is also the limitation.** If the primary stops, the chain stops,
  even with healthy replicas — a replica can copy but never propose. That is
  what `CONSENSUS_MODE=bft` removes: four validators take turns proposing, and
  the chain survives losing any one of them. See [`CONSENSUS.md`](CONSENSUS.md).

### Running the cluster

```
make gen-certs      # once: a local CA + one certificate per node, into ./certs
make run-cluster    # primary :9545, replicas :9555 and :9565 — Ctrl+C stops all
make cluster-test   # the M10 gate: 5 scenarios against a fresh cluster
make reset-cluster  # delete all three nodes' data directories
```

`make run-cluster` keeps existing chain data; `cd e2e && node cluster.mjs --reset`
starts from a fresh genesis. Point writes at the primary or at any replica —
a replica forwards them — and reads at whichever node is closest.

### Certificates and rotation

`make gen-certs` writes `certs/ca.{crt,key}` plus `<node>.{crt,key}` for
`primary`, `replica1` and `replica2`. Each node certificate is valid for both
server and client authentication, because every node is both: the primary
serves catch-up pulls and dials replicas to push.

- The CA **is** the cluster's membership credential. There is no other
  authentication on the P2P port.
- `certs/` is gitignored. For a real deployment, keep `ca.key` off the nodes
  entirely — a node needs only its own key pair and `ca.crt`.
- Rotation is all-or-nothing: regenerate everything and restart all three
  nodes. A half-rotated cluster fails with handshake errors that look like
  network faults.
- Certificates default to one year (`-days` to change). Add a node later with
  `go run ./cmd/gencerts -nodes replica3` against the *same* directory — but
  note this creates a new CA, so prefer regenerating the whole set.

A cluster's nodes must share `CHAIN_ID` and `BLOCK_GAS_LIMIT`: both feed the
genesis block, so a mismatch changes the genesis hash and the replica refuses
block 1 with a `parentHash` mismatch rather than drifting silently.

## Operations

### Restart

The chain is durable: stopping the node and starting it again resumes at the
same height, with the same state and the same contract addresses. Two things
happen at boot that are worth knowing about.

**The head is verified before the RPC server starts.** The node resolves its
head pointer and opens the state trie at that head's root. If the state
cannot be opened — a disk that filled mid-commit, a half-restored backup, a
`data/` directory copied while the node was running — it refuses to start
rather than serving a chain it cannot read:

```
chain head is block 412 (0x…) but its state root 0x… cannot be opened: …
run `make audit` to find the first bad block, or `make reset` to start from a fresh genesis
```

**The dev clock is seeded from the head.** A chain that used
`evm_increaseTime` — which is every chain the M08 contract-test gate touches,
and any election whose phase deadlines were crossed by jumping forward — has
a head timestamp well ahead of wall clock. The time offset lives in memory,
so a restart resets it to zero while those blocks remain on disk; block
timestamps would then advance one second per block until real time caught up.
The node therefore seeds the offset from the head at startup, and logs it:

```
WRN chain head is ahead of wall clock; dev clock seeded from it … devOffsetSeconds=604800
```

A large value here is expected on a test chain and worth a second look on a
production one.

### Audit

`cmd/audit` re-derives the entire chain state from the stored block list and
checks every block against its own header — the "anyone can recheck the
election" property. It is a separate binary from the node, opens the data
directory **read-only**, and keeps everything it computes in memory, so it
cannot alter the history it is verifying.

```
make audit                              # whole chain in ./data
make audit DATA_DIR=./data_replica1
make audit AUDIT_ARGS="-from 1200"      # incremental, from block 1200 up
make audit AUDIT_ARGS="-json"           # machine-readable summary
```

Per block it verifies: parent linkage, block numbering, strictly increasing
timestamps, the state root, the transaction root, the receipt root, the logs
bloom, gas used, and the stored receipts against the recomputed ones. Genesis
is verified by reconstruction — rebuilt from the configured `CHAIN_ID` and
prefund set and compared — so an audit cannot succeed against a chain that
was never the one it was configured for.

Success prints one line and exits 0:

```
AUDIT OK height=412 stateRoot=0x… blocks=412 txs=298 gas=1043… elapsed=9.2s (44.8 blocks/s)
```

Failure names the first block that did not verify and exits 1. Replay stops
there deliberately: every later block builds on that one's state, so
continuing would report a cascade of consequences instead of the cause.

```
AUDIT FAILED block=57 field=stateRoot got=0x… want=0x…
```

**The node must be stopped first.** Pebble holds an exclusive lock on the
data directory, which read-only mode does not bypass. To audit while the node
stays up, copy the data directory and audit the copy.

**Duration.** Measured on the M09 gate run (2026-08-01), against the data
directory `yarn deploy --network custom` and `yarn test:custom` left behind:

```
AUDIT OK height=787 blocks=787 txs=774 gas=1410021337 elapsed=419ms (1878.5 blocks/s)
```

787 blocks, 1.41 billion gas of re-execution, in 0.42 seconds — roughly
**1,900 blocks/s** and **3.4 Ggas/s** on a developer laptop. Repeat runs of
the same audit reached 3,300 blocks/s (0.24 s) once the data directory was in
the OS page cache, so quote the cold figure: it is the one an auditor
starting from a freshly copied directory will see. Either way, independently
re-verifying an election is a sub-second operation at this scale, not a batch
job.

Cost is governed by gas re-executed rather than by block count, so the figure
will drop on a chain with a different mix: that chain averages ~1.8M gas per
block (contract deployments and the contract test suite), while a `vote()`
carrying a real Honk proof runs up to 15M gas. A full election of *n* voters
is dominated by those *n* verification blocks — extrapolating from the
measured gas rate, on the order of 4 ms per vote.

### Recovering from a bad audit

1. `make audit` — note the block number and field.
2. If the chain is a development one, `make reset` and redeploy.
3. If it is not, the block named is where to look: a `stateRoot` mismatch
   means execution no longer reproduces the stored state, while a
   `storedReceipts` or `receipt[…]` mismatch means the header still verifies
   and only the separately stored receipt records are wrong — the second is
   recoverable by re-deriving receipts, the first is not.
