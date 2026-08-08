# Byzantine Fault Tolerant Consensus — A Complete Guide

**What it is, why it exists, what those four keys are, how it runs on the AWS
machines, and how to demonstrate it.**

This is the explanatory document. Two companions:

| Document | Purpose |
|---|---|
| [`packages/blockchain/CONSENSUS.md`](packages/blockchain/CONSENSUS.md) | technical reference — message formats, safety proof, code map |
| [`infra/DEPLOY-BFT.md`](infra/DEPLOY-BFT.md) | the deployment runbook — do these steps in this order |

---

# Part I — The problem

## 1.1 What we had

Until now the chain had **one writer**. One machine — `node1`, the "primary"
or "sequencer" — received every transaction, executed it, and sealed it into a
block. The other three machines were *replicas*: they received each finished
block, re-executed it to check it was honest, and stored it.

That design has two genuine virtues. There are no forks, because only one
machine ever writes. And replicas are not gullible — they re-execute
everything, so a primary that tried to lie about a state root would be caught.

It also has two problems that are fatal for an election.

### Problem 1 — one machine can stop the election

If `node1` dies, **the chain stops**. Not degrades — stops. The three healthy
replicas can copy blocks, but they have no mechanism to *propose* one. Nobody
can vote until node1 comes back.

For a system whose entire job is to accept votes during a fixed window, "one
server reboot ends the election" is not a survivable property.

### Problem 2 — one party decides what the chain contains

Detection is not prevention. A replica can prove that a block's state root
doesn't follow from its transactions. But it cannot stop node1 from:

- **omitting** a valid vote (censorship),
- **reordering** transactions,
- deciding, unilaterally, what the chain contains.

Whoever runs node1 decides the election's contents. In a real vote that party
is the electoral authority — and "trust the authority completely" is precisely
what a verifiable voting system is supposed to remove.

## 1.2 What we want instead

> No single party can stop the election.
> No single party can decide its contents.

That is what Byzantine Fault Tolerant consensus buys.

---

# Part II — The idea

## 2.1 From "one writer" to "a committee"

Instead of one machine that writes and three that watch, we have **four
machines that vote**. They take turns proposing blocks, and a block only
becomes real when a **majority-of-a-particular-size agrees** it should.

The four are the parties with a stake in the election:

| Node | Validator | Who it represents |
|---|---|---|
| node1 | `authority` | the electoral authority |
| node2 | `jvp` | a political party |
| node3 | `unp` | a political party |
| node4 | `sjb` | a political party |

Names are cosmetic to the protocol — the code only ever deals in addresses —
but the point is political, not technical: **the parties who would otherwise
have to trust the authority are inside the machine that decides.**

## 2.2 "Byzantine" — what the word means

It's from the *Byzantine Generals Problem*. Several generals surround a city
and must agree to attack or retreat. Messengers can be delayed. And some
generals may be **traitors** — actively lying, telling one general "attack"
and another "retreat" to split the loyal ones.

A system is *Byzantine fault tolerant* if the loyal generals still reach the
same decision despite that.

The distinction that matters:

| Fault type | Example | Harder? |
|---|---|---|
| **Crash** fault | a machine loses power | easier — it just goes quiet |
| **Byzantine** fault | a machine actively lies, and lies *differently* to different peers | much harder |

We handle the second. Not because we expect a party to run malicious software,
but because a system that only survives honest crashes has not actually
removed the need to trust anyone.

---

# Part III — Why four, why three

This is the question everything hinges on, so let's derive it rather than
assert it.

## 3.1 The two conflicting requirements

Say there are **N** validators and a block needs **Q** signatures to be final.
Say up to **f** validators may be faulty — crashed, unreachable, or lying.

**Requirement A — liveness.** The election must continue when f are down. The
remaining `N − f` must be able to reach Q:

```
Q ≤ N − f
```

**Requirement B — safety.** Two different blocks must never both be finalized
at the same height. Suppose block X gets Q signatures and block Y gets Q
signatures. Both groups are drawn from N validators, so they must overlap in
at least `2Q − N` members. If every overlapping member were a traitor, that
traitor could have signed both. So we need at least one *honest* validator in
the overlap:

```
2Q − N > f
```

## 3.2 Solving them

From A: `Q ≤ N − f`. Substituting into B:

```
2(N − f) − N > f   →   N − 2f > f   →   N > 3f
```

**You need more than three times as many validators as faults you want to
survive.** To survive one fault: `N > 3`, so `N = 4` is the minimum. And the
smallest Q satisfying both is:

```
Q = ⌈2N/3⌉ = ⌈8/3⌉ = 3
```

## 3.3 So: N = 4, Q = 3, f = 1

| N | Q = ⌈2N/3⌉ | f = N − Q | Verdict |
|---|---|---|---|
| 3 | 2 | 1 | ✗ fails safety: `2Q−N = 1`, not `> f` |
| **4** | **3** | **1** | ✓ the minimum that works |
| 7 | 5 | 2 | ✓ survives two |
| 10 | 7 | 3 | ✓ survives three |

Why three validators is *not* enough, concretely: with N=3, Q=2, two quorums
overlap in exactly one member. If that member is the traitor, it can sign for
block X with one peer and block Y with another — **two different blocks
finalized at the same height. The chain forks.** The fourth validator is what
guarantees the overlap contains someone honest.

## 3.4 What this actually gives you

| Validators compromised or down | What can happen |
|---|---|
| **1** | **Nothing.** Absorbed. The election continues normally. |
| **2** | Cannot finalize anything (2 < 3). **Can halt** the election by refusing to vote. |
| **3** | Controls ordering and censorship. |

Note what even three cannot do: **finalize a block with an invalid state
root.** Every honest validator re-executes before voting, so bad execution is
rejected no matter how many signatures it carries. They could censor; they
could not forge a vote count.

> **The security claim: you need three of four parties colluding.**
> Compare with before: one machine.

---

# Part IV — The keys

Now the question you asked.

## 4.1 What a validator key actually is

Each validator holds a **secp256k1 private key** — the same cryptography as an
Ethereum account key. But it is **not an account**:

- it holds no funds
- it never sends a transaction
- it never appears on-chain (the block's `Coinbase` field is the zero address)

Its only job is to **sign this validator's votes**. When `jvp` says "I checked
this block and it's valid", it signs that statement with its key. Everyone else
recovers the signer's address from the signature and checks it against the
known list.

> **Holding one of these four keys is what it means to be one of the four
> parties.** It is the identity badge, and nothing else.

## 4.2 Why four addresses were generated at the start

Every validator must be able to answer: *"is this signature from someone
entitled to vote?"*

To answer it, each node needs the **addresses** of all four validators. That
list is `VALIDATOR_SET`, and it's identical on all four machines:

```
authority:0x5417…,jvp:0xC6E4…,unp:0x4Cb1…,sjb:0x7F51…
```

So each of the four keys produces one address, and all four addresses go into
a list every node holds. Hence: four keys generated, four addresses published.

### The public/private split

| | Secret? | Where it lives |
|---|---|---|
| private key | **yes** | GitHub secret → `data_3001/keys/validator.key` (mode `0600`) on one host only |
| address | **no** | `gen_inventory.py`, committed to git, on all four hosts |

An address is derived from its key by a one-way function. Publishing it lets
everyone verify signatures; it does not let anyone produce them. This is
exactly how an Ethereum address relates to its private key.

## 4.3 Why order matters

`VALIDATOR_SET` is an ordered list, and the order is protocol-significant:

```
proposer for a block = validators[(height + round) % 4]
```

Every validator computes whose turn it is from that formula. There is no
election, no negotiation, no leader-election protocol — just arithmetic on the
block number. It works because all four have the same list in the same order.

**If two nodes had the same members in a different order, they would disagree
about whose turn it is at every height and the chain would never move.**

## 4.4 Why the key must match its listed address

The node checks at boot that its private key derives to the address
`VALIDATOR_SET` lists for its own `VALIDATOR_ID`, and refuses to start if not.

This looks pedantic. It isn't. If `jvp` held a key that derived to some other
address, its votes would verify as coming from a stranger and be **silently
dropped**. The cluster would run on three validators while believing it had
four — one failure from halting, with nothing in any log to say why.

Better to refuse to boot and name both values.

## 4.5 How the keys relate to the other secrets in this project

Easy to conflate. They are four different things:

| Key | Question it answers | Where |
|---|---|---|
| **Validator consensus key** | *whose vote counts?* | `data_3001/keys/validator.key` |
| mTLS certificate + key | *who may connect to port 4001?* | `data_3001/certs/` |
| `admin_relay_private_key` | an actual Ethereum account that **sends transactions and pays gas** | `group_vars/all.yml` |
| ZK circuit keys | voter privacy — unrelated to consensus | `packages/circuits/` |

The first two are the instructive pair:

> **mTLS decides who may speak. The consensus key decides whose word counts
> toward a quorum.**

Someone with a stolen certificate can connect and be completely ignored.

## 4.6 Losing a key

Not a disaster. Existing blocks are already final and signed — nothing is
retroactively at risk. That validator simply cannot vote until you issue a new
key, update `VALIDATOR_SET` on **all four** machines, and restart them
together.

That coordinated restart is why "the validator set is fixed at configuration"
is listed honestly as a limitation.

---

# Part V — What actually happens when someone votes

The full journey, for one vote.

```
 voter taps "Vote" in the app
        │
        ▼
 the app builds and signs a transaction, sends it to the ALB
        │
        ▼
 nginx on some node → that node's JSON-RPC on :3001
        │
        ▼
 ┌─ is this node the current proposer? ────────────────────────┐
 │  yes → keep it                                              │
 │  no  → forward to the proposer over :3001                   │
 │        (if the proposer is unreachable → keep it anyway;    │
 │         a round change will carry it — see 5.2)             │
 └─────────────────────────────────────────────────────────────┘
        │
        ▼
 PROPOSER: execute the transaction, build a block, DON'T save it
        │
        ▼
 broadcast PRE-PREPARE to the other three over mTLS :4001
        │
        ▼
 EACH VALIDATOR: re-execute the block independently.
   Does my state root match theirs? Do the receipts match?
        │  yes
        ▼
 broadcast PREPARE  ("I ran it myself, it's valid")
        │
        ▼
 count PREPAREs. At 3 → LOCK this block, broadcast COMMIT
        │
        ▼
 count COMMITs. At 3 → the block is FINAL
        │
        ▼
 save the block AND the 3 signatures that made it final
        │
        ▼
 the voter's receipt is returned
```

## 5.1 The two things worth noticing

**Every validator re-executes the block itself.** A PREPARE does not mean "the
proposer says it's fine". It means *"I ran this and reproduced every value in
its header."* This uses the exact same code as the offline auditor. No
validator ever takes another's word for anything — including when catching up
after a restart.

**The proposer executes the transaction twice** — once to build the candidate,
once to commit it through the same code path a follower uses. Deliberate: it
leaves exactly one way blocks get written to disk, so a block this node
proposed and a block it received are indistinguishable afterwards.

## 5.2 When the proposer doesn't do its job

If the proposer is dead or silent, nothing above happens. So every validator
runs a timer. When it expires:

```
broadcast ROUND-CHANGE ("this round isn't working, let's move on")
        │
        ▼
when 3 validators agree → round += 1
        │
        ▼
proposer = validators[(height + round) % 4]   ← a DIFFERENT machine
        │
        ▼
the new proposer proposes. The chain continues.
```

**This is the mechanism that makes "kill the authority and the election
continues" true.** Adding `round` to `height` is what makes the turn move; if
the schedule used height alone, a dead proposer would be re-elected every
round forever.

A round change requires **three** validators to agree, not one — otherwise a
single faulty node could skip the turn past honest proposers at will.

## 5.3 The lock — why a traitor can't fork the chain

The single most important rule:

> **The instant a validator broadcasts a COMMIT for a block, it locks onto
> that block for that height. It will never vote for a different block at that
> height, in any later round, ever.**

Why that's sufficient: any two groups of 3 out of 4 share at least 2 members,
and at most 1 is a traitor, so **at least one honest validator is in both**.
For two different blocks to both reach 3 commits, that honest validator would
have had to commit to both — which the lock forbids.

Hence: **two different blocks can never both be finalized at the same
height.** No forks, even with a traitor.

## 5.4 The commit certificate

When a block is finalized, the three signatures are stored alongside it. Ask
any node for them:

```bash
curl -s http://<node>:3001 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"zk_getCommitSeals","params":["latest"]}'
```

```json
{
  "number": "0x2a", "quorum": "0x3", "validatorSetSize": "0x4",
  "seals": [
    { "validator": "authority", "address": "0x5417…", "signature": "0x1b2c…" },
    { "validator": "jvp",       "address": "0xC6E4…", "signature": "0x8a41…" },
    { "validator": "unp",       "address": "0x4Cb1…", "signature": "0xc0de…" }
  ]
}
```

**This is the audit trail.** It is cryptographic proof that three named parties
independently verified and agreed to that block. The addresses are *recovered
from the signatures by the server*, not read from a config file — so a
scrutineer can check the arithmetic without trusting the node that served it.

### Why the signatures are stored *beside* the block, not inside it

Most IBFT chains pack seals into the block header. We can't, and the reason is
instructive: the block hash and state root are what the auditor, the replicas
and the replay engine all verify against. Putting signatures into the hashed
header would change **every block hash**, so the same votes would produce a
different chain, and the pre-existing verification code would all need a second
path.

So the certificate is a *sidecar*, keyed by block height and hash.

The honest cost of that choice: **a block's validity does not depend on its
seals.** Re-executing the chain proves the *state* is right; the seals prove
*who agreed to it*. Losing a seal record loses audit trail, not the block.
That's why a missing certificate returns `null` rather than an error.

---

# Part VI — How this maps to the AWS machines

## 6.1 The physical layout

Nothing new was provisioned. Same four `t3.small` EC2s in `ap-south-1`, same
ports, same certificates.

```
                    Internet
                       │
              ┌────────▼────────┐
              │  Application    │
              │  Load Balancer  │
              └───┬─────────┬───┘
         /chain-api│         │/
                   │         ▼
                   │   ┌───────────────┐
                   │   │  web EC2      │  Next.js
                   │   └───────────────┘
                   ▼
    ┌──────────────────────────────────────────────┐
    │   FOUR VALIDATOR EC2s — all co-equal          │
    │                                               │
    │   node1        node2        node3      node4  │
    │   authority    jvp          unp        sjb    │
    │                                               │
    │   each runs:  nginx :80  →  zk-node :3001     │
    │               zk-node :4001 (mTLS)            │
    │                                               │
    │   :4001 full mesh — every node ↔ every node   │
    │   ┌─────────────────────────────────────┐     │
    │   │  node1 ←→ node2 ←→ node3 ←→ node4   │     │
    │   │    ↕        ↕        ↕        ↕     │     │
    │   │    └────────┴────────┴────────┘     │     │
    │   └─────────────────────────────────────┘     │
    └──────────────────────────────────────────────┘
```

## 6.2 What changed on each machine

| | Before | After |
|---|---|---|
| `ROLE` | node1 `primary`, rest `replica` | **all four `primary`** |
| `CONSENSUS_MODE` | (didn't exist) | `bft` |
| `/health` reports | `"role":"primary"` / `"replica"` | `"role":"validator"` |
| :4001 traffic | node1 → replicas, one way | all ↔ all, both ways |
| Who can accept a vote | node1 only | **any of the four** |

There is no replica in a BFT cluster. A replica cannot propose, so a validator
configured as one would hold a key, be counted in the quorum, and never take
its turn — the node refuses to boot in that configuration.

## 6.3 Why the network needed no changes

The security group already had:

```hcl
ingress {
  description = "P2P between nodes"
  from_port   = 4001
  to_port     = 4003
  protocol    = "tcp"
  self        = true      # ← any member may reach any other member
}
```

`self = true` is membership-based, not pair-based, so **the full mesh already
existed at the network layer**. The single-sequencer design just never used it
in both directions.

## 6.4 How a machine knows who its peers are

Ansible generates the inventory from Terraform's output. In BFT mode, **every**
host gets its own peer list (previously only node1 got one):

```yaml
node2:
  validator_id: jvp
  consensus_peers:     "authority=https://10.0.1.11:4001,unp=https://10.0.1.13:4001,sjb=https://10.0.1.14:4001"
  validator_rpc_urls:  "authority=http://10.0.1.11:3001,unp=http://10.0.1.13:3001,sjb=http://10.0.1.14:3001"
```

- `consensus_peers` — where to send votes (mTLS, :4001)
- `validator_rpc_urls` — where to forward a transaction when this node isn't
  the proposer (:3001). Optional; without it everything still works, just one
  round slower.

## 6.5 Where the signing key lives on the machine

```
/opt/zk-voting/packages/blockchain/data_3001/keys/validator.key   mode 0600
```

Written by Ansible from a GitHub secret, with `no_log`. The systemd unit points
at it with `VALIDATOR_PRIVATE_KEY_FILE` rather than embedding the value, so the
key appears in **neither `ps -e` nor `systemctl show`**.

---

# Part VII — Demonstrating it

The whole value is that these are observable. Rehearse them.

## 7.1 Baseline — show it's really running

```bash
curl -s http://<node1>:3001/health
# {"status":"ok","role":"validator","chainId":9494,...}
```

`"role":"validator"` — not `"primary"` — is the proof consensus is live.

```bash
curl -s http://<node1>:3001 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"zk_consensusStatus","params":[]}'
```

```json
{"mode":"bft","self":"authority","height":12,"round":0,"proposer":"unp",
 "validators":["authority","jvp","unp","sjb"],"quorum":3,
 "synced":true,"faulty":[]}
```

Cast a vote, then show its certificate — **three seals, three distinct
addresses**.

> **Say out loud:** *"Three of the four parties independently re-executed this
> block and signed it. No one party put it there."*

## 7.2 Demo 1 — kill the authority; the election continues

```bash
ssh ubuntu@<node1>
sudo systemctl stop zk-node
```

Cast a vote from the app. **It lands.**

```bash
curl -s http://<node2>:3001 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"zk_consensusStatus","params":[]}'
# → "proposer" is no longer "authority"

curl -s http://<node2>:3001 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"zk_getCommitSeals","params":["latest"]}'
# → still three seals, none of them the authority's
```

> **Say out loud:** *"The electoral authority's server is off. Voting
> continues, and the authority's signature is not on this block. Under the old
> design this would have stopped the election entirely."*

## 7.3 Demo 2 — kill a second; it halts, safely

```bash
ssh ubuntu@<node2>
sudo systemctl stop zk-node
```

Cast a vote. After ~24 seconds:

```
consensus did not reach quorum for this transaction;
it was not mined — safe to resubmit
```

Show the heights on the two survivors: **frozen**. Show any block's seals:
**still three**.

> **Say out loud:** *"Two of four are gone. The system stops rather than
> letting two parties agree a result between themselves. This is the correct
> behaviour — a halted election can resume; a forged one cannot be undone."*

This is the most important demo. Anyone can build something that keeps going.
Stopping *for the right reason* is the engineering.

## 7.4 Demo 3 — restore one; it resumes

```bash
ssh ubuntu@<node2>
sudo systemctl start zk-node
```

It re-executes every block it missed — verifying each itself — then rejoins
voting. Resubmit the vote; it lands.

> **Say out loud:** *"It didn't trust the others' copies. It re-ran every block
> it missed and checked the results itself."*

## 7.5 Demo 4 — the audit still passes

```bash
ssh ubuntu@<node1>
sudo systemctl stop zk-node
cd /opt/zk-voting/packages/blockchain
go run ./cmd/audit -data-dir ./data_3001
sudo systemctl start zk-node
```

```
AUDIT OK height=… stateRoot=… blocks=… txs=…
```

> **Say out loud:** *"Consensus changed who decides the order. It did not touch
> execution — every block re-executes to the state root it always did."*

## 7.6 Demo 5 — a Byzantine validator (optional)

Covered by an automated test that mounts a real equivocation attack against
the production engine:

```bash
cd packages/blockchain
go test ./internal/consensus/ -run TestEquivocatingProposerCannotFinalizeTwoBlocks -v
```

A malicious proposer sends **two different blocks** for the same height to
different halves of the cluster — the textbook way to split a BFT network.
Result: no fork. To show it on real machines, `make build-byzantine` produces a
deliberately misbehaving binary (behind a build tag, never in a production
build).

## 7.7 Suggested running order

| # | Demo | Shows | ~Time |
|---|---|---|---|
| 0 | Baseline + a vote's seals | consensus is live and provable | 2 min |
| 1 | Kill the authority | **no single party can stop it** | 3 min |
| 2 | Kill a second | **safety over liveness** | 3 min |
| 3 | Restore one | self-healing, independent verification | 2 min |
| 4 | Audit | execution unchanged | 2 min |
| 5 | Byzantine test | resists active attack | 2 min |

---

# Part VIII — Likely questions

Honest answers, including where the system is weak.

**"Why not just use more replicas?"**
Replicas can't propose. Ten replicas and a dead primary is still a stopped
election. The problem isn't redundancy of *storage*, it's redundancy of
*authority*.

**"Why 4 and not 3?"**
With N=3, Q=2, two quorums overlap in exactly one validator. If that one is the
traitor it can sign for two different blocks and fork the chain. Four
guarantees the overlap contains someone honest. (Part III.)

**"What if two parties collude?"**
They cannot finalize anything — 2 < 3. They *can* halt the election by
refusing to vote. That's a denial of service, and it's the accepted cost of
choosing safety: the alternative would be letting a minority decide.

**"What if three collude?"**
They control ordering and can censor. They still cannot finalize an invalid
state root, because honest validators re-execute. The claim is "three of four
parties must collude" — not "unbreakable".

**"Is this the same as Bitcoin/Ethereum consensus?"**
No. Those are *permissionless* — anyone may join, so they use proof-of-work or
proof-of-stake to make participation costly. This is *permissioned*: exactly
four known parties. That allows a much more efficient and immediately-final
protocol. Bitcoin blocks get *probabilistically* safer; ours are final the
moment three signatures exist.

**"How do you know it works?"**
Two independent levels. Four consensus engines run in-process against four real
databases in the Go test suite, covering quorum signing, one-down liveness,
two-down safety, leader rotation and Byzantine equivocation. Then four **real
binaries over real mTLS on real sockets** run the same scenarios in
`make bft-cluster-test`, including killing and reviving processes. Both are in
CI.

**"What's the performance cost?"**
Four network round trips instead of zero, plus each validator executing every
transaction. Around 1–2 seconds per block versus near-instant. Irrelevant here:
generating a single ZK vote proof takes ~2.9 seconds, so consensus is not the
bottleneck.

**"Can you add or remove a validator?"**
Not at runtime. The set is configuration, and changing it is a coordinated
restart of all four. Doing it live means deciding at which block the set
changes, which affects the certificates of blocks either side. Listed as a
known limitation.

**"What happens if all four have the wrong time?"**
Timestamps must strictly increase, and validators reject a proposed block dated
more than 15 seconds ahead of their own clock. Not for chain integrity —
replay uses the *stored* timestamp — but because the voting contract's phase
deadlines are timestamp comparisons, so a far-future block would expire every
deadline at once, irreversibly.

---

# Part IX — Honest limitations

Every one of these is a deliberate trade.

| Limitation | Why we accepted it |
|---|---|
| Validator set fixed at configuration | on-chain membership changes need a rule for which blocks belong to which set; a coordinated restart is simpler and safer |
| Two down halts the election | correct by design: 2 of 4 must not be able to decide anything |
| Proposer executes each transaction twice | leaves exactly one durable write path, so proposed and received blocks are identical on disk and the auditor needs no new logic |
| Seals stored beside the block, not in it | keeps block hashes byte-identical, so the existing replay/audit/replica code was untouched and the feature is revertible |
| A write to a non-proposer waits for rotation if the proposer is down | at most N × round timeout; the forwarder makes the healthy path one hop |
| `evm_setNextBlockTimestamp` is best-effort | dev-only method; a round change can drop the pin |
| The audit doesn't verify seals | it re-executes the chain, which is the stronger check; seal verification is possible future work |
| One operator generated all four keys | a deployment convenience for this project. In a real election each party generates its own key on its own hardware and publishes only the address — **the protocol does not assume otherwise** |

That last row is worth stating in a viva. The cryptography is genuinely
four-party; the *key custody* in this deployment is not, and that's a
deployment property rather than a design flaw.

---

# Part X — One-paragraph summary

> The chain previously had a single writer, which meant one machine could stop
> the election and one party decided its contents. It now runs QBFT-style
> Byzantine fault tolerant consensus across four validators — the electoral
> authority and three political parties — each holding a cryptographic signing
> key. Validators take turns proposing blocks by a formula every node computes
> independently; each validator re-executes a proposed block itself before
> voting, and a block becomes final only when three of the four have signed a
> commit for it. Those three signatures are stored with the block as a
> verifiable certificate. With four validators and a threshold of three, the
> system survives any one validator failing — the election continues even with
> the authority's server switched off — and halts rather than weakening if two
> fail, because allowing two parties to agree a result would defeat the point.
> Forking is impossible even against an actively malicious validator, because
> any two groups of three share at least one honest member and an honest
> validator never commits to two blocks at the same height.

---

## Where to go next

- **Technical detail** → [`packages/blockchain/CONSENSUS.md`](packages/blockchain/CONSENSUS.md)
- **Deploying it** → [`infra/DEPLOY-BFT.md`](infra/DEPLOY-BFT.md)
- **The code** → `packages/blockchain/internal/consensus/`
- **The tests** → `go test ./internal/consensus/ -v` and `make bft-cluster-test`
