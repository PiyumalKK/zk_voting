#!/usr/bin/env node
// The M10 acceptance gate: a real 3-node cluster, driven end to end.
//
//   1. start 3 nodes -> deploy a contract to the primary -> all heads converge
//   2. write through a REPLICA's RPC (forwarded to the sequencer) -> lands everywhere
//   3. kill replica2 -> 20 writes -> restart it -> it catches up to the same head
//   4. reads (balance, code, eth_call, getLogs, receipt, block) identical on all 3
//   5. push a hand-crafted block with a wrong state root -> the replica refuses it
//
// Usage:
//   node cluster-test.mjs            # from packages/blockchain/e2e
//   VERBOSE=1 node cluster-test.mjs  # echo the nodes' own logs
// or, from packages/blockchain: `make cluster-test`
//
// Prerequisites: `make build` and `make gen-certs`. The cluster's data
// directories are wiped at the start of every run — the scenarios assume
// they know the whole history.
//
// A note on the contract used. M10's spec sketches this with the Voting
// stack; this uses e2e/diff/contracts/Probe.sol instead, whose artifact is
// committed, so the gate needs no Solidity toolchain and no `yarn compile`.
// What is being tested here is replication — that every node ends up with
// the same state, logs and receipts — and Probe exercises storage writes,
// indexed events and a view function, which is all this needs. The real
// Voting stack over the custom chain is M08's gate (`yarn test:custom`) and
// M14's full e2e.

import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPublicClient, createWalletClient, http, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { startCluster, waitFor, delay, ROOT } from "./cluster.mjs";
import { EMPTY_BLOOM, EMPTY_ROOT, encodeEmptyBlock, headerFields, headerHash } from "./lib/block-rlp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROBE = JSON.parse(readFileSync(join(here, "diff", "contracts", "Probe.json"), "utf8"));
const CERTS = join(ROOT, "certs");

// Hardhat test account #0 — genesis-prefunded (MASTER §3). Not a secret.
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(DEPLOYER_KEY);

const VERBOSE = process.env.VERBOSE === "1";

const steps = [];

function pass(name, detail) {
  steps.push({ name, ok: true });
  console.log(`[PASS] ${name}${detail ? " — " + detail : ""}`);
}

function fail(name, detail) {
  steps.push({ name, ok: false, detail });
  console.log(`[FAIL] ${name}${detail ? " — " + detail : ""}`);
}

function check(name, condition, detail) {
  if (condition) pass(name, detail);
  else fail(name, detail);
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

// ---------------------------------------------------------------------------
// Cluster-wide helpers

/** Waits until every node reports the same head number and hash. */
async function waitForConvergence(cluster, what, timeoutMs = 30_000) {
  let last = "";
  await waitFor(
    what,
    async () => {
      const heads = await Promise.all(cluster.nodes.map(async (n) => ({ name: n.name, hash: await n.headHash() })));
      last = heads.map((h) => `${h.name}=${h.hash?.slice(0, 12)}`).join(" ");
      const first = heads[0].hash;
      return heads.every((h) => h.hash === first) || last;
    },
    timeoutMs,
  );
  return last;
}

async function heads(cluster) {
  return Promise.all(
    cluster.nodes.map(async (n) => ({ name: n.name, number: await n.blockNumber(), hash: await n.headHash() })),
  );
}

function clients(node) {
  return {
    publicClient: createPublicClient({ transport: http(node.rpcUrl) }),
    walletClient: createWalletClient({ account, transport: http(node.rpcUrl) }),
  };
}

// ---------------------------------------------------------------------------
// Scenario 1 — the cluster converges on the sequencer's chain

async function scenarioConverge(cluster, state) {
  section("1. deploy to the sequencer, all three nodes converge");

  const { publicClient, walletClient } = clients(cluster.primary);

  const deployHash = await walletClient.deployContract({ abi: PROBE.abi, bytecode: PROBE.bytecode, gas: 3_000_000n });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  check("Probe deployed on the sequencer", deployReceipt.status === "success", deployReceipt.contractAddress);
  state.probe = deployReceipt.contractAddress;

  const setHash = await walletClient.writeContract({
    address: state.probe,
    abi: PROBE.abi,
    functionName: "setValue",
    args: [42n],
    gas: 200_000n,
  });
  await publicClient.waitForTransactionReceipt({ hash: setHash });
  state.setValueTx = setHash;

  const manyHash = await walletClient.writeContract({
    address: state.probe,
    abi: PROBE.abi,
    functionName: "emitMany",
    args: [3n],
    gas: 400_000n,
  });
  await publicClient.waitForTransactionReceipt({ hash: manyHash });

  const detail = await waitForConvergence(cluster, "all three nodes to reach the sequencer's head");
  const all = await heads(cluster);
  check("all three nodes share the sequencer's head", new Set(all.map((h) => h.hash)).size === 1, detail);
  check(
    "replicas re-executed every block (heights match)",
    new Set(all.map((h) => h.number)).size === 1,
    all.map((h) => `${h.name}=${h.number}`).join(" "),
  );

  // /health on a replica must say more than "up": M10 deliverable 3.
  const health = await cluster.replicas[0].health();
  check(
    "replica /health reports primaryHeight and synced",
    health?.role === "replica" && typeof health.primaryHeight === "number" && health.synced === true,
    JSON.stringify(health),
  );
}

// ---------------------------------------------------------------------------
// Scenario 2 — writes sent to a replica are forwarded to the sequencer

async function scenarioForwardedWrite(cluster, state) {
  section("2. write through a replica's RPC (forwarding)");

  const replica = cluster.replicas[0];
  const { publicClient, walletClient } = clients(replica);

  // viem does the whole cycle against the replica: estimateGas and
  // getTransactionCount are answered locally, eth_sendRawTransaction is
  // forwarded to the sequencer, and the receipt is then polled from the
  // replica — which only ever sees it because the block came back by push.
  const hash = await walletClient.writeContract({
    address: state.probe,
    abi: PROBE.abi,
    functionName: "setValue",
    args: [77n],
    gas: 200_000n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  check("transaction submitted through a replica was mined", receipt.status === "success", hash);

  const value = await publicClient.readContract({ address: state.probe, abi: PROBE.abi, functionName: "value" });
  check("the replica reads back the value it forwarded", value === 77n, String(value));

  const detail = await waitForConvergence(cluster, "the forwarded write to appear on every node");
  check("the forwarded write is on all three nodes", true, detail);

  // The sequencer, not the replica, is what actually sealed it.
  const onPrimary = await cluster.primary.rpc("eth_getTransactionReceipt", [hash]);
  check("the sequencer holds the same receipt", onPrimary && onPrimary.transactionHash === hash, onPrimary?.blockNumber);

  // Dev methods are state mutations too, so they are forwarded as well —
  // a replica that served evm_mine locally would fork the cluster instantly.
  const before = await cluster.primary.blockNumber();
  await replica.rpc("evm_mine", []);
  await waitFor("evm_mine through a replica to advance the sequencer", async () => {
    return (await cluster.primary.blockNumber()) === before + 1;
  });
  pass("evm_mine through a replica is forwarded to the sequencer", `height ${before} -> ${before + 1}`);

  await waitForConvergence(cluster, "the mined block to reach every node");
}

// ---------------------------------------------------------------------------
// Scenario 3 — a replica that was down catches up

async function scenarioCatchUp(cluster, state) {
  section("3. stop a replica, write 20 blocks, restart it");

  const replica = cluster.replicas[1];
  await replica.stop();
  check("replica2 stopped", replica.proc === null);

  const { publicClient, walletClient } = clients(cluster.primary);
  const heightBefore = await cluster.primary.blockNumber();

  for (let i = 0; i < 20; i++) {
    const hash = await walletClient.writeContract({
      address: state.probe,
      abi: PROBE.abi,
      functionName: "setValue",
      args: [BigInt(100 + i)],
      gas: 200_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const heightAfter = await cluster.primary.blockNumber();
  check("20 blocks sealed while replica2 was down", heightAfter - heightBefore === 20, `${heightBefore} -> ${heightAfter}`);

  // The other replica must have kept up throughout — one node being down
  // must not stall the cluster.
  await waitFor("replica1 to stay current while replica2 was down", async () => {
    return (await cluster.replicas[0].blockNumber()) === heightAfter;
  });
  pass("the surviving replica stayed current", `height ${heightAfter}`);

  await replica.start();
  await waitFor(
    "replica2 to catch up after restarting",
    async () => (await replica.headHash()) === (await cluster.primary.headHash()),
    60_000,
  );

  const primaryHash = await cluster.primary.headHash();
  const replicaHash = await replica.headHash();
  check("restarted replica reached the sequencer's exact head", replicaHash === primaryHash, replicaHash);

  const health = await replica.health();
  check("restarted replica reports itself synced", health?.synced === true, JSON.stringify(health));
}

// ---------------------------------------------------------------------------
// Scenario 4 — every node answers reads identically

async function scenarioReadEquality(cluster, state) {
  section("4. reads are identical on all three nodes");

  const latest = await cluster.primary.blockNumber();
  const reads = [
    ["eth_getBalance", [account.address, "latest"]],
    ["eth_getCode", [state.probe, "latest"]],
    ["eth_getBlockByNumber", ["0x1", true]],
    ["eth_getTransactionReceipt", [state.setValueTx]],
    ["eth_getTransactionCount", [account.address, "latest"]],
    [
      "eth_call",
      [{ to: state.probe, data: "0x3fa4f245" /* value() */ }, "latest"],
    ],
    [
      "eth_getLogs",
      [{ fromBlock: "0x1", toBlock: `0x${latest.toString(16)}`, address: state.probe }],
    ],
  ];

  for (const [method, params] of reads) {
    const answers = await Promise.all(cluster.nodes.map((n) => n.rpc(method, params)));
    const encoded = answers.map((a) => JSON.stringify(a));
    const identical = encoded.every((a) => a === encoded[0]);
    const summary = encoded[0]?.length > 90 ? `${encoded[0].slice(0, 90)}…` : encoded[0];
    check(`${method} identical on all three nodes`, identical, identical ? summary : encoded.join("\n  vs  "));
  }

  // The logs are the app's audit trail, so they get a decoded comparison
  // rather than only a byte-for-byte one: the audit page reads VoteCast the
  // same way this reads ValueSet.
  const logSets = await Promise.all(
    cluster.nodes.map(async (n) => {
      const raw = await n.rpc("eth_getLogs", [
        { fromBlock: "0x1", toBlock: `0x${latest.toString(16)}`, address: state.probe },
      ]);
      return parseEventLogs({ abi: PROBE.abi, logs: raw });
    }),
  );
  const decoded = logSets.map((set) => set.map((l) => `${l.eventName}(${l.args.value})@${l.blockNumber}`).join(","));
  check(
    "decoded event streams are identical on all three nodes",
    decoded.every((d) => d === decoded[0]) && logSets[0].length > 0,
    `${logSets[0].length} events`,
  );
}

// ---------------------------------------------------------------------------
// Scenario 5 — a tampered block is refused
//
// This is the property the whole replica design exists for (MASTER §3): a
// replica re-executes every block and refuses any whose state root does not
// follow from its contents. A sequencer that quietly rewrote state would
// have to publish exactly such a block.
//
// The block is assembled here rather than taken from the primary, so the
// test is not merely re-sending something that was already accepted. To
// make sure a rejection means "the replica caught the tampering" and not
// "this script encoded a block wrong", the encoder is proved first: an
// existing block is re-encoded from its JSON-RPC representation and pushed,
// and the replica must recognise it as a duplicate — which it can only do if
// the bytes hash to the same block.

// The encoding itself lives in lib/block-rlp.mjs and has its own offline
// tests (lib/block-rlp.test.mjs), because a wrong field order and a caught
// tamper produce the same symptom here: the replica refusing the block.

/** POSTs to a node's mTLS P2P port using the primary's client certificate. */
function p2pPost(node, path, body) {
  const payload = JSON.stringify(body);
  const options = {
    host: "127.0.0.1",
    port: node.p2pPort,
    path,
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    cert: readFileSync(join(CERTS, "primary.crt")),
    key: readFileSync(join(CERTS, "primary.key")),
    ca: readFileSync(join(CERTS, "ca.crt")),
  };

  return new Promise((resolve, reject) => {
    const req = httpsRequest(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          /* leave null; the raw text is reported instead */
        }
        resolve({ status: res.statusCode, body: parsed, raw: data.trim() });
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function scenarioTamper(cluster) {
  section("5. a block with a wrong state root is refused");

  const replica = cluster.replicas[0];

  // (a) prove the encoder: re-encode a block the replica already has.
  const headNumber = await cluster.primary.blockNumber();
  const existing = await cluster.primary.rpc("eth_getBlockByNumber", [`0x${headNumber.toString(16)}`, false]);
  const rebuiltFields = headerFields(existing);
  const rebuiltHash = headerHash(rebuiltFields);

  check(
    "this script encodes a block header exactly as the node does",
    rebuiltHash === existing.hash,
    `${rebuiltHash} vs ${existing.hash}`,
  );
  if (rebuiltHash !== existing.hash) {
    fail("tamper test skipped", "the header encoder does not agree with the node, so a rejection would prove nothing");
    return;
  }

  if (existing.transactions.length === 0) {
    const duplicate = await p2pPost(replica, "/p2p/block", {
      number: headNumber,
      rlp: encodeEmptyBlock(rebuiltFields),
    });
    check(
      "re-encoded block is recognised as one the replica already has",
      duplicate.status === 200 && duplicate.body?.status === "duplicate",
      `${duplicate.status} ${duplicate.raw}`,
    );
  }

  // (b) the tampered block: correctly linked to the current head, correctly
  // numbered, plausible timestamp — and a state root that no execution
  // produces.
  const parent = await cluster.primary.rpc("eth_getBlockByNumber", ["latest", false]);
  const forgedNumber = Number(BigInt(parent.number)) + 1;
  const forgedFields = headerFields(parent, {
    parentHash: parent.hash,
    number: `0x${forgedNumber.toString(16)}`,
    timestamp: `0x${(Number(BigInt(parent.timestamp)) + 12).toString(16)}`,
    transactionsRoot: EMPTY_ROOT,
    receiptsRoot: EMPTY_ROOT,
    gasUsed: "0x0",
    logsBloom: EMPTY_BLOOM,
    stateRoot: "0xbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad0",
  });

  const before = await replica.headHash();
  const refused = await p2pPost(replica, "/p2p/block", {
    number: forgedNumber,
    rlp: encodeEmptyBlock(forgedFields),
  });

  check(
    "the replica refuses a block whose state root does not match its execution",
    refused.status === 409 && refused.body?.code === "state-mismatch",
    `${refused.status} ${refused.raw}`,
  );

  const after = await replica.headHash();
  check("the refused block left no trace on the replica", after === before, after);

  // And the cluster is still healthy afterwards: refusing a bad block must
  // not knock a replica out of service.
  await waitForConvergence(cluster, "the cluster to still agree after the tamper attempt", 15_000);
  const health = await replica.health();
  check("the replica is still synced after refusing the block", health?.synced === true, JSON.stringify(health));
}

// ---------------------------------------------------------------------------

async function main() {
  console.log("M10 cluster gate — starting a fresh 3-node cluster (this takes a few seconds)\n");
  const cluster = await startCluster({ reset: true, quiet: !VERBOSE });
  const state = {};

  try {
    // A moment for the replicas' boot catch-up to settle before the first
    // assertion, so a slow first poll is not reported as a failure.
    await delay(200);

    await scenarioConverge(cluster, state);
    await scenarioForwardedWrite(cluster, state);
    await scenarioCatchUp(cluster, state);
    await scenarioReadEquality(cluster, state);
    await scenarioTamper(cluster);
  } finally {
    console.log("\nstopping cluster...");
    await cluster.stop();
  }
}

main()
  .then(() => {
    const failed = steps.filter((s) => !s.ok);
    console.log(`\n${steps.length} checks: ${steps.length - failed.length} passed, ${failed.length} failed.`);
    if (failed.length > 0) {
      for (const f of failed) console.log(`  - ${f.name}: ${f.detail ?? ""}`);
      console.log("FAIL");
      process.exitCode = 1;
      return;
    }
    console.log("PASS");
  })
  .catch((err) => {
    console.error("\ncluster-test failed:", err?.shortMessage ?? err?.details ?? err?.message ?? err);
    if (err?.cause) console.error("cause:", err.cause?.shortMessage ?? err.cause?.message ?? err.cause);
    console.log("FAIL");
    process.exit(1);
  });
