# Deploying BFT Consensus to AWS

A one-time runbook for switching the four blockchain EC2s from the
single-sequencer topology to 2/3 Byzantine-fault-tolerant consensus.

| If you want | Read |
|---|---|
| to understand what this is and why — keys, quorum, demos | [`../packages/blockchain/02-BFT-CONSENSUS.md`](../packages/blockchain/02-BFT-CONSENSUS.md) |
| the protocol's technical detail | [`../packages/blockchain/CONSENSUS.md`](../packages/blockchain/CONSENSUS.md) |
| an ordinary (non-BFT) deployment | [`DEPLOY_STEPS.md`](DEPLOY_STEPS.md) |

---

## What changes

| | Before | After |
|---|---|---|
| Who may seal a block | node1 only | any of the four, in turn |
| Signatures to finalize | 1 (implicit) | 3 of 4, cryptographic |
| If one node dies | **chain stops** | chain continues |
| If two nodes die | chain stops | chain stops (safely, never below quorum) |

No new infrastructure. Same four EC2s, same ports, same mTLS. Port 4001 is
already `self = true` in the security group, so the full mesh consensus needs
already exists at the network layer.

---

## Two things that will trip you up

Read these before starting; both have bitten people.

### 1. The servers clone `Piyumal`, not your branch

`group_vars/all.yml` sets `branch: "Piyumal"`, and the blockchain role clones
*that* branch onto each EC2. Running a deploy workflow from
`feature/bft-consensus` still puts **Piyumal's code** on the servers.

> **You must merge to `Piyumal` before deploying.** This is not optional.

### 2. Deploying the nodes wipes the chain

The blockchain role does `file: path=/opt/zk-voting state=absent` before
re-cloning, and `DATA_DIR` (`.../data_3001`) lives inside it. This is
pre-existing behaviour, not something consensus introduced.

Consequences:

- **All existing votes and registrations are erased.** Capture anything you
  need for a presentation *before* you start.
- **The deployed contracts are erased with them.** They must be redeployed in
  the same run, or the web app builds against addresses that no longer exist.
  This is why Part 3 uses the *Full* deploy rather than nodes-only.

For this particular rollout the wipe is actually convenient: all four
validators start from one shared genesis together, so there is no state
migration to think about.

---

## Part 1 — Codebase

### Step 1. Generate four matched validator keys

```powershell
cd packages\blockchain\e2e
node -e "const {generatePrivateKey,privateKeyToAccount}=require('viem/accounts');const names=['authority','jvp','unp','sjb'];const k=[],a=[];for(const n of names){const p=generatePrivateKey();k.push([n,p]);a.push(privateKeyToAccount(p).address)}k.forEach(([n,p],i)=>console.log('VALIDATOR_KEY_NODE'+(i+1)+' ('+n+') = '+p.slice(2)));console.log('\nVALIDATOR_ADDRESSES=\n'+a.join(','))"
```

Keep the output for Step 5. **Order matters** and is fixed:

```
node1 = authority    node2 = jvp    node3 = unp    node4 = sjb
```

These keys are *consensus signing keys*, not accounts: they hold no funds,
send no transactions, and never appear on-chain. Their only job is to sign
PREPARE/COMMIT votes. Holding one is what it means to be one of the four
parties.

> The addresses are **public** — every node needs every other node's to check
> signatures. Only the private halves are secret.

### Step 2. Put the addresses in the repo

Edit `DEFAULT_VALIDATOR_ADDRESSES` in
[`scripts/gen_inventory.py`](scripts/gen_inventory.py) with your four
addresses, in the same order.

The committed defaults are Hardhat's **published test accounts** — correct for
the local cluster, wrong for anything real, because their private keys are in
Hardhat's documentation.

### Step 3. Commit and push

```powershell
git add infra/scripts/gen_inventory.py
git commit -m "chore: real validator addresses for the deployed cluster"
git push -u origin feature/bft-consensus
```

### Step 4. Open a PR into `Piyumal` and wait for green

`blockchain-test.yml` runs automatically on the PR: unit tests, the
four-validator acceptance gate, and the solo-mode gate. This is the safety
net — do not skip ahead to the merge.

### Step 5. Merge

Until this lands on `Piyumal`, the servers cannot get the consensus code.

---

## Part 2 — Secrets

### Step 6. Add four repository secrets

GitHub → **Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value (hex, no `0x`) |
|---|---|
| `VALIDATOR_KEY_NODE1` | authority's key from Step 1 |
| `VALIDATOR_KEY_NODE2` | jvp's key |
| `VALIDATOR_KEY_NODE3` | unp's key |
| `VALIDATOR_KEY_NODE4` | sjb's key |

The keys are passed to Ansible as `--extra-vars` with `no_log`, written to
`data_3001/keys/validator.key` mode `0600`, and read via
`VALIDATOR_PRIVATE_KEY_FILE` — so they appear in neither `ps -e` nor
`systemctl show`, and never enter git.

If a key does not match the address you set in Step 2, the node refuses to
boot and names both values. That check exists because a validator signing with
an unlisted identity is otherwise invisible: its messages verify as coming
from a stranger and are silently dropped, leaving the cluster one vote short
with nothing in any log to explain why.

---

## Part 3 — Deploy

### Step 7. Run **Deploy Application (Full)**

Actions tab → *Deploy Application (Full)* → Run workflow → branch `Piyumal`.

> **Use the Full deploy, not "Deploy Blockchain Nodes Only".**
> Nodes-only wipes the chain but never redeploys the contracts, leaving the
> web app pointing at dead addresses. The Full workflow runs
> nodes → web with `redeploy_contracts=true` → health check, which is exactly
> what a fresh chain needs.

The run takes roughly 10–15 minutes.

### Step 8. Verify

The health-check job prints `/health` and `zk_consensusStatus` for all four
nodes. You are looking for:

```json
{"status":"ok","role":"validator","chainId":9494,"height":0,...}
```

```json
{"mode":"bft","self":"authority","height":1,"round":0,"proposer":"jvp",
 "validators":["authority","jvp","unp","sjb"],"quorum":3,
 "synced":true,"faulty":[]}
```

`"role":"validator"` rather than `"primary"` is the signal that consensus is
genuinely live — in solo mode every node reports its old role.

Then cast one vote through the app and confirm it carries a certificate:

```bash
curl -s http://<node1>:3001 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"zk_getCommitSeals","params":["latest"]}'
```

Three seals, three **distinct** addresses, each naming a validator.

---

## Part 4 — Demonstrating the guarantees

The whole point is that these are observable on real machines. Full script in
§11 of [`CONSENSUS.md`](../packages/blockchain/CONSENSUS.md).

### One validator down — the election continues

```bash
ssh ubuntu@<node1-ip>
sudo systemctl stop zk-node          # the AUTHORITY
```

Cast a vote from the web app. **It lands.**

```bash
curl -s http://<node2-ip>:3001 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"zk_consensusStatus","params":[]}'
# → "proposer" is no longer "authority": the schedule rotated past it

curl -s http://<node2-ip>:3001 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"zk_getCommitSeals","params":["latest"]}'
# → still three seals, none of them the authority's
```

This is the property the single-sequencer design did not have: stopping node1
used to stop the chain.

### Two validators down — the election halts, safely

```bash
ssh ubuntu@<node2-ip>
sudo systemctl stop zk-node          # now two are down
```

Cast a vote. It fails after roughly `ROUND_TIMEOUT_MS × (N+2)` ≈ 24s:

```
consensus did not reach quorum for this transaction;
it was not mined — safe to resubmit
```

Check heights on the two survivors: frozen. Check any block's seals: still
three. **Nothing anywhere is ever finalized with fewer than three signatures.**
The chain stopped rather than letting two parties agree a result between
themselves.

### Restore one — it resumes

```bash
ssh ubuntu@<node2-ip>
sudo systemctl start zk-node
```

Node2 re-executes every block it missed — verifying each itself, never
trusting a peer — then rejoins voting. Resubmit the vote; it lands. Bring
node1 back the same way.

### The audit still passes

```bash
ssh ubuntu@<node1-ip>
sudo systemctl stop zk-node          # the auditor needs the database exclusively
cd /opt/zk-voting/packages/blockchain
go run ./cmd/audit -data-dir ./data_3001
sudo systemctl start zk-node
```

Every block re-executes to the same state root it always did. Consensus
decided *ordering and finality*; it did not touch execution.

---

## Reverting

Consensus is behind one environment variable and the revert is not a rebuild.

**Quick, one node:** edit `/etc/systemd/system/zk-node.service`, set
`CONSENSUS_MODE=solo`, then `systemctl daemon-reload && systemctl restart zk-node`.

**Proper, whole cluster:** regenerate the inventory in solo mode and redeploy.

```bash
CONSENSUS_MODE=solo python infra/scripts/gen_inventory.py infra/terraform \
  > infra/ansible/inventory.yml
```

You get the old primary/replica topology back, unchanged. Existing blocks stay
valid under either mode — they were verified by re-execution, which consensus
never touched — and their commit certificates simply become inert records.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Deploy stops: *"no signing key was provided for node2"* | secrets missing or misnamed | Step 6; names are exactly `VALIDATOR_KEY_NODE1..4` |
| Node exits: *"key derives to 0xA… but VALIDATOR_SET lists authority as 0xB…"* | key/address mismatch or wrong order | regenerate as a matched set (Step 1) and redo Steps 2 and 6 |
| Node exits: *"VALIDATOR_ID is set but CONSENSUS_MODE is solo"* | inventory generated in solo mode against a bft unit file | regenerate the inventory, redeploy |
| `/health` says `"role":"primary"` on all four | still the solo topology — usually the merge in Step 5 was skipped | confirm `Piyumal` has the consensus code, redeploy |
| Chain never advances, logs full of *"round timed out"* | validators cannot reach each other on 4001 | check the security group and that `consensus_peers` lists all three others per host |
| `zk_getCommitSeals` returns `null` | that block predates consensus, or was synced from a peer with no certificate | expected; a block's validity comes from re-execution, not from its seals |
| App shows no election / contract calls revert | chain was wiped without redeploying contracts | run the **Full** deploy, or re-run the web deploy with `redeploy_contracts=true` |

---

## Checklist

```
[ ] 1. Four matched keys generated, kept safe
[ ] 2. Addresses in gen_inventory.py, correct order
[ ] 3. Committed and pushed
[ ] 4. PR opened, blockchain-test.yml green
[ ] 5. Merged to Piyumal
[ ] 6. Four secrets set in GitHub
[ ] 7. "Deploy Application (Full)" run on Piyumal
[ ] 8. All four report role=validator, quorum=3
[ ] 9. A vote lands and shows 3 distinct seals
[ ] 10. Kill-one and kill-two demos rehearsed
```

Do the whole rollout well ahead of any demonstration day, not on it.
