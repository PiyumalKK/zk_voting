# BFT Consensus

How this chain decides what is true, when `CONSENSUS_MODE=bft`.

---

## 1. Why

Through M14 this chain had exactly one writer. That is simple and fork-free,
and it makes the machine running the sequencer a single point of both failure
and trust:

- **failure** — if the primary EC2 stops, the election stops, even though
  three healthy replicas are running. Replicas can copy; they cannot propose.
- **trust** — whatever the primary seals is the truth. Replicas re-execute and
  can *detect* a bad block, but detection after the fact is not the same as
  being unable to produce one.

For a national-scale vote neither is acceptable. With four validators —
`authority`, `jvp`, `unp`, `sjb` — and a quorum of three:

> **No single party can stop the election, and no single party can decide its
> contents.**

Losing any one validator, including the authority, leaves the chain running.
Losing two stops it — deliberately, because the alternative is two parties
agreeing a result between themselves.

---

## 2. The numbers

| | |
|---|---|
| Validators (N) | 4 |
| Quorum (Q) | 3 = ⌈2N/3⌉ |
| Tolerated failures (f) | 1 = N − Q |

Why ⌈2N/3⌉ and not a simple majority: with f faulty validators, a quorum must
be reachable when f are down (`Q ≤ N−f`) **and** any two quorums must overlap
in at least one *honest* validator (`2Q−N > f`). Together those give `N > 3f`,
and `Q = ⌈2N/3⌉` is the smallest threshold satisfying both. For N=4 that is
Q=3, f=1.

A 3-validator set would give Q=2 and f=0 — a set that halts on any single
failure, which is the problem this exists to solve. Four is the minimum.

---

## 3. The protocol

QBFT/IBFT-style, leader-based, single-slot final. One transaction per block,
as before.

```
                    proposer = validators[(height + round) % N]

  PRE-PREPARE   the round's proposer broadcasts a block
       │
       ▼
  PREPARE       every validator that RE-EXECUTES the block and agrees
       │        broadcasts a signed PREPARE
       ▼
  COMMIT        on ≥ Q prepares, a validator LOCKS the block and
       │        broadcasts a signed COMMIT
       ▼
  FINALIZE      on ≥ Q commits, the block is applied and the Q
                signatures are stored as its commit certificate

  ROUND-CHANGE  on timeout, ≥ Q of these rotate to the next proposer
```

Once Q commits exist for a height, that block is final. There is no reorg
above a finalized height, ever.

### What a vote means

A PREPARE is not "the proposer says this is fine". It is **"I executed this
block myself and reproduced every value its header commits to"** — using
`internal/chain/replay.go`, the same code `cmd/audit` and every solo-mode
replica use. A validator never takes a peer's word for anything, including
during catch-up after a restart.

### Proposer rotation

`validators[(height + round) % N]` is a pure function of `(height, round)`, so
every validator — and any auditor reading the chain afterwards — computes the
same answer with no communication. Adding `round` is what makes a round change
rotate: if the schedule depended on height alone, a dead proposer would be
re-elected in every round and the chain would never recover from losing one
machine.

The round timer is **flat for the first N rounds** — one full rotation, every
validator getting exactly one turn — and grows linearly only after a complete
rotation has failed, which means something systemic rather than one dead
machine.

### Quiescence

Round timers arm only when there is something to make progress on: a queued
write, a proposal in flight, a lock owed, or evidence that a peer is trying.
An idle BFT cluster produces no blocks and burns no rounds, exactly as the
single-sequencer chain did — blocks exist because someone wrote, not because
time passed.

---

## 4. Message types and signing

| Type | Carries | Round in signature? |
|---|---|---|
| `PROPOSAL` (1) | height, round, block hash, block RLP | yes |
| `PREPARE` (2) | height, round, block hash | yes |
| `COMMIT` (3) | height, block hash | **no — zeroed** |
| `ROUND-CHANGE` (4) | height, target round, any lock held | yes |

Wire format is JSON over the existing mTLS link, `POST /p2p/consensus`:

```json
{
  "type": 2,
  "height": 42,
  "round": 0,
  "blockHash": "0x9f3c…",
  "signature": "0x1b2c…00"
}
```

### The signing pre-image

```
keccak256(rlp(Domain, ChainID, Type, Height, Round, BlockHash, Locked))
Domain = "zkbft/v1"
```

Every field earns its place:

- **Domain and ChainID** — a signature from a test cluster must not be valid on
  production, where the same operators may hold the same keys, and a consensus
  vote must not be reinterpretable as anything else the key could have signed
  (a transaction, an EIP-191 message).
- **Type** — without it, an attacker could replay each honest validator's
  PREPARE, which is broadcast in the clear, as that validator's COMMIT. Three
  honest PREPAREs would become three COMMITs nobody cast, reaching quorum with
  zero real commits. The whole safety argument depends on this being
  impossible.
- **Height and BlockHash** — what is being voted on.

The block body rides on the wire but is **not** signed: the receiver requires
`block.Hash() == BlockHash`, so the body is bound by the hash the signature
does cover, and the pre-image stays a fixed-size struct.

### Why COMMIT zeroes the round

A COMMIT is a claim about a *block* — "this block is final at its height" —
not about a round, and the block hash already binds the height through the
header. Zeroing the round buys two things:

1. **Liveness.** Commits for the same block cast in different rounds aggregate
   toward the same quorum, so a slow validator's late commit still counts
   after a round change instead of being wasted.
2. **Auditability.** A stored seal is verifiable from the finalized block
   alone, years later, with no need to also record which round produced it.

This is Besu's IBFT2 behaviour, and it is why the safety argument below is
phrased per-height rather than per-round.

---

## 5. Safety

> With N = 4 validators and quorum Q = 3, any two quorums share at least
> 2Q − N = 2 members. Tolerating f = 1 Byzantine validator, at least one of
> those shared members is honest. An honest validator broadcasts a COMMIT for
> at most one block hash per height: `lockedHash` is set the instant it
> commits, survives every round change at that height, and is the guard that
> refuses a proposal for any other hash — and because the COMMIT pre-image
> omits the round, a round change cannot produce a second, differently-signed
> commit from the same validator. Therefore if two distinct blocks B₁ and B₂
> both accumulated three valid COMMIT signatures at the same height, some
> honest validator would have signed a COMMIT for both, contradicting the
> lock. **No two distinct blocks can be finalized at the same height.**
>
> The property survives round changes because commit tallies are per-height,
> not per-round. It survives an equivocating proposer because a validator that
> has prepared B₁ at (H, r) will not prepare B₂ at (H, r) — the
> (height, round, type, signer) dedup turns the second vote into recorded
> evidence rather than a second vote.
>
> Liveness, by contrast, requires three validators reachable within the round
> timeout. With two down the protocol correctly makes **no progress** rather
> than finalizing with fewer than three signatures.

### Equivocation

A validator that signs two different block hashes for the same
(height, round, type) is Byzantine by definition, and **both** its votes are
discarded — including the one already tallied. Keeping the first would let it
choose which honest node's tally it contributes to by controlling arrival
order, which is exactly the power the quorum-intersection argument assumes it
does not have. Discarding both costs at most liveness: with N=4 the remaining
three honest validators still make quorum.

Detected equivocation is logged at `Error` with the literal string `CRITICAL`
and surfaced in `zk_consensusStatus` as `faulty`.

---

## 6. Where the signatures live

**Commit seals are stored beside the chain, not inside the block header.**

IBFT chains normally pack seals into `extraData`, which makes the certificate
part of the block and is elegant. This chain cannot do that. Its `extraData`
is already spoken for (system-op blocks, `internal/chain/sysop.go`) and —
decisively — the block hash and state root are what `replay.go`, `cmd/audit`
and every existing replica verify against. Putting seals in the hashed header
would change the hash of every block, so the same transactions would produce a
different chain, the auditor would need a second code path, and a solo-mode
replica could not follow a BFT node during a rollout.

So the certificate lives in a sidecar in the same database:

```
key:    "zkbft-seals-" ‖ big-endian uint64(height) ‖ blockHash
value:  rlp({ Round, Seals[][65] })      seals sorted by signer address
```

Verified against go-ethereum v1.16.8: no `core/rawdb` key or prefix begins
with `z`. Long ASCII prefixes are geth's own convention for namespaced
additions (`clique-`, `secure-key-`, `ethereum-config-`); single-byte prefixes
are dense and new ones appear between releases.

The certificate is written **immediately before** `ApplyExternalBlock`, in its
own single-key batch — not inside `persist`'s atomic batch. Three reasons, in
order of weight:

1. That batch is a contract. Its six writes are exactly what
   `state.VerifyHead` asserts at every boot and what
   `TestChainRecoversFromAPartialWrite` exercises. A seventh, BFT-only key
   would make the atomic unit differ between modes, so "solo mode is
   unchanged" would stop being obviously true.
2. Seals-then-block is strictly better than the reverse. A crash between them
   leaves an orphan certificate keyed by a block hash that never became
   canonical — unreferenced, harmless, overwritten byte-identically when the
   block is re-applied. The opposite order would leave a canonical block whose
   seals are missing forever.
3. It is free. Pebble's `SyncKeyValue` flushes every preceding write, so
   `persist`'s existing single fsync makes the certificate durable at the same
   instant the block is.

### The honest cost

**A block's validity does not depend on its seals.** Re-executing the chain
proves the *state* is right; the seals prove *who agreed to it*. Losing a seal
record loses the audit trail for that block, not the block. That is why a
missing certificate is never an error: blocks sealed before consensus was
enabled have none, and neither do blocks synced from a peer with a truncated
store. `zk_getCommitSeals` returns `null` for those, which is honest.

Certificates are also **not** byte-identical across validators, and should not
be expected to be: a validator finalizes the instant it holds Q commits, so one
node may hold three signatures where another holds four. Both are complete.
What holds everywhere is that each certificate verifies and names at least Q
*distinct* validators.

---

## 7. RPC

Two additive, read-only methods in a `zk_` namespace. Nothing in `eth_*` moves
or changes shape; a client that does not know about `zk_` is unaffected. In
solo mode the namespace is not registered at all, so both answer `-32601`.

### `zk_getCommitSeals(blockNumberOrTag)`

```json
{
  "number": "0x2a",
  "blockHash": "0x9f3c…",
  "round": "0x0",
  "quorum": "0x3",
  "validatorSetSize": "0x4",
  "seals": [
    { "validator": "authority", "address": "0xf39f…", "signature": "0x1b2c…00" },
    { "validator": "jvp",       "address": "0x7099…", "signature": "0x8a41…01" },
    { "validator": "unp",       "address": "0x3c44…", "signature": "0xc0de…00" }
  ]
}
```

This is what makes the design auditable from outside. Addresses are
**recovered server-side from the signatures**, not read from configuration, so
a scrutineer can check the quorum arithmetic without trusting the node that
served it — and an `address` with an empty `validator` is itself a finding.

- Unknown block, or a block with no certificate → JSON `null`.
- A certificate that exists but does **not** verify → an error, never a
  truncated list. Serving a partial list would let a caller read two verified
  seals as a quorum of two.

### `zk_consensusStatus()`

```json
{
  "mode": "bft", "self": "authority", "height": 42, "round": 0,
  "proposer": "unp", "quorum": 3, "synced": true,
  "validators": ["authority", "jvp", "unp", "sjb"], "faulty": []
}
```

---

## 8. Catch-up and rejoin

A validator that was down is just a follower that happens to hold a key. There
is no handshake and no manual step.

Every BFT node runs the existing `p2p.Follower`, with `p2p.MultiPrimary` as
its source (there is no single primary to pull from). Every pulled block goes
through `Sequencer.ApplyExternalBlock` — same `replay.go`, same
`*ReplayMismatch`. **A rejoining validator re-executes and independently
verifies every block it missed; it never trusts a peer's claim that a block
was finalized.**

The gate on voting is the height window, not a flag:

```
msg.Height == localHead + 1  →  process
msg.Height  > localHead + 1  →  buffer, and ask the follower to catch up
msg.Height <= localHead      →  drop (that height is settled)
```

A node at H−5 buffers every message for H and tallies none of them. It cannot
vote at a height it has not evaluated, **by construction rather than by
policy**, and starts participating the moment catch-up drags it forward.

---

## 9. Configuration

| Variable | Meaning |
|---|---|
| `CONSENSUS_MODE` | `solo` (default) or `bft` |
| `VALIDATOR_ID` | this node's name in `VALIDATOR_SET` |
| `VALIDATOR_PRIVATE_KEY` | signing key, hex, `0x` optional |
| `VALIDATOR_PRIVATE_KEY_FILE` | path to the key (preferred in production) |
| `VALIDATOR_SET` | `name:address,…` — **order is protocol-significant** |
| `CONSENSUS_PEERS` | `name=p2p-url,…` for every *other* validator |
| `VALIDATOR_RPC_URLS` | `name=rpc-url,…` — optional, enables proposer forwarding |
| `ROUND_TIMEOUT_MS` | round-change timeout (default 4000, minimum 500) |
| `QUORUM` | override; empty derives ⌈2N/3⌉ |

Full descriptions in [`.env.example`](.env.example).

Startup refuses, with a joined error listing every problem at once:

- **any validator variable set while `CONSENSUS_MODE` is `solo`.** Ignoring
  them would be friendlier and exactly wrong: the node would seal blocks alone,
  on its own authority, while three peers believed they were voting.
- `ROLE` other than `primary` in bft mode — a replica cannot vote, so it would
  be counted in the quorum and never take its turn.
- fewer than 4 validators; duplicate names or addresses.
- **a signing key that does not derive to the address `VALIDATOR_SET` lists
  for `VALIDATOR_ID`.** Otherwise that validator is invisible: its messages
  verify as coming from a stranger and are dropped, leaving the cluster
  permanently one vote short with nothing in any log to say why.
- an incomplete `CONSENSUS_PEERS` — with one failure of slack, spending it on
  a typo rather than a dead machine is not a trade worth making silently.
- a `QUORUM` below the Byzantine threshold or below a majority.

### Production keys

The four signing keys come from GitHub Actions secrets
(`VALIDATOR_KEY_NODE1..4`), are passed to Ansible as `--extra-vars` with
`no_log`, and are written to `data_3001/keys/validator.key` mode `0600` on
each host. They are never in this repository and never in an `Environment=`
line, so they appear in neither `ps -e` nor `systemctl show`.

The **addresses** are public — an address is not a secret, and every node
needs every other node's to check signatures — and live in
`infra/scripts/gen_inventory.py`.

> **The defaults in `gen_inventory.py` are Hardhat's published test accounts.**
> They are correct for the local cluster and wrong for anything real. Set
> `VALIDATOR_ADDRESSES` before a deployment that matters.

---

## 10. Running it

### Locally

```bash
make gen-certs        # once
make run-bft          # four validators on 9545 / 9555 / 9565 / 9575
```

Writes may go to **any** node. Reads too.

```bash
curl -s localhost:9545 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"zk_consensusStatus","params":[]}'
```

### The acceptance gate

```bash
make bft-cluster-test
```

Four real binaries over real mTLS, run through all seven criteria. Its
in-process counterpart is `go test ./internal/consensus/`, which drives four
engines against four real chains and is the authority on the protocol's logic;
the cluster gate is the authority on the deployment actually working.

---

## 11. Demonstrating it on AWS

The whole point is that these are observable on real machines. Deploy with the
**Deploy Blockchain Nodes Only** workflow, then:

### One validator down — the election continues

```bash
ssh ubuntu@<node1>  sudo systemctl stop zk-node        # the AUTHORITY
```

Cast a vote from the web app. It lands.

```bash
curl -s http://<node2>:3001 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"zk_consensusStatus","params":[]}'
# → "proposer" is no longer "authority"; the schedule rotated past it

curl -s http://<node2>:3001 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"zk_getCommitSeals","params":["latest"]}'
# → three seals, three distinct addresses, none of them the authority's
```

**This is the property the single-sequencer design did not have.** Stopping
node1 used to stop the chain.

### Two validators down — the election halts, safely

```bash
ssh ubuntu@<node2>  sudo systemctl stop zk-node        # now two are down
```

Cast a vote. It fails, after roughly `ROUND_TIMEOUT_MS × (N+2)`:

```
consensus did not reach quorum for this transaction;
it was not mined — safe to resubmit
```

Check the heights on the two survivors: frozen. Check any block's seals: still
three. **Nothing anywhere is ever finalized with fewer than three signatures.**
The chain stopped rather than letting two parties agree a result.

### Restore one — it resumes

```bash
ssh ubuntu@<node2>  sudo systemctl start zk-node
```

Node2 re-executes every block it missed, verifying each itself, then rejoins
voting. Resubmit the vote; it lands. Bring node1 back the same way.

### The audit still passes

```bash
ssh ubuntu@<node1>
sudo systemctl stop zk-node      # the auditor needs the database exclusively
cd /opt/zk-voting/packages/blockchain
go run ./cmd/audit -data-dir ./data_3001
sudo systemctl start zk-node
```

Every block re-executes to the same state root it always did. Consensus
decided *ordering and finality*; it did not touch execution.

### A Byzantine validator

Criterion 5 is proven against the production engine by
`TestEquivocatingProposerCannotFinalizeTwoBlocks`, which wraps the transport to
send two differently-signed blocks for one height to different halves of the
cluster. To watch it on real machines, deploy one node with a binary built as
`make build-byzantine`. That build announces itself with a `CRITICAL` log line
and must never be deployed otherwise; the misbehaving code is behind a build
tag and is not compiled into any other binary.

---

## 12. Reverting

Set `CONSENSUS_MODE=solo` (or unset it) and restart. The node is then
byte-for-byte the M14 single-sequencer node: `startReplication` checks the
consensus flag first and returns early, so with it off the two original
branches are the only reachable code.

For a full redeploy, `CONSENSUS_MODE=solo python infra/scripts/gen_inventory.py`
regenerates the primary/replica inventory.

Nothing about the flag is one-way. Existing blocks stay valid under either
mode — they were verified by re-execution, which is unchanged — and their
commit certificates simply become inert records.

---

## 13. Known limitations

Stated plainly, because each is a deliberate trade rather than an oversight.

- **The validator set is fixed at configuration.** There is no on-chain
  validator management. Changing the set means deciding at which block it
  changes, which has real consequences for the certificates of blocks either
  side, and is a coordinated restart.
- **`evm_setNextBlockTimestamp` is best-effort.** The pin is proposer-local, so
  a round change between the pin and the next block drops it. `DEV_RPC`-only,
  and the chain's time still moves forward correctly because every validator
  adopts the timestamp of each block it accepts.
- **The proposer executes each transaction twice** — once building the
  candidate, once committing it through `ApplyExternalBlock`. Bought
  deliberately: it leaves exactly one durable write path in the codebase, so a
  block this node proposed and a block it received are indistinguishable on
  disk, which is why `cmd/audit` needed no new argument.
- **A write submitted to a node whose turn has just passed waits for the
  proposership to rotate** when the proposer is unreachable — at most
  `N × ROUND_TIMEOUT_MS`. `VALIDATOR_RPC_URLS` makes the healthy path one hop.
- **`cmd/audit` does not verify seals.** It re-executes the chain, which is the
  stronger check; cross-checking every historical certificate is possible
  future work.

---

## 14. Where the code is

| | |
|---|---|
| `internal/consensus/engine.go` | the state machine; one goroutine owns all round state |
| `internal/consensus/roundstate.go` | per-height tallies, the lock, equivocation detection |
| `internal/consensus/message.go` | message types, the signing pre-image, verification |
| `internal/consensus/validators.go` | the registry and the proposer schedule |
| `internal/consensus/seals.go` | the certificate sidecar |
| `internal/chain/candidate.go` | build-without-persisting, and verification |
| `internal/p2p/transport.go` | consensus broadcast over mTLS |
| `internal/p2p/multiprimary.go` | catch-up from any validator |
| `internal/rpc/zk.go` | `zk_getCommitSeals`, `zk_consensusStatus` |
| `cmd/node/consensus.go` | the wiring |
| `e2e/bft-cluster-test.mjs` | the four-process acceptance gate |
