# zk-blockchain node (v2)

A permissioned, single-sequencer EVM chain that speaks the Ethereum JSON-RPC
subset this app uses. It executes ordinary EVM bytecode and knows nothing
about `Voting.sol`, `ElectionRegistry.sol` or `HonkVerifier.sol` — contracts
are deployed to it with the same `hardhat-deploy` scripts used against
Hardhat, and switching between the two backends is an environment-variable
change.

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
