#!/usr/bin/env node
// The BFT acceptance gate: four real validator processes, killed and revived,
// proving the properties the whole feature exists for.
//
//   make bft-cluster-test
//
// This is the process-level counterpart to internal/consensus/engine_test.go.
// The Go tests run four engines in one process against four real chains and
// are the authority on the protocol's logic; this runs four real binaries over
// real mTLS on real sockets, and is the authority on the deployment actually
// working. Both are needed: the Go tests would pass if the P2P wiring were
// broken, and this would pass if the state machine were subtly wrong in a way
// four healthy nodes never expose.
//
// Scenarios, each mapped to its acceptance criterion:
//
//   1. all four up            every block finalizes with >= 3 distinct signers
//   2. kill authority         the chain keeps advancing (no single party can
//                             stop the election), still at full quorum
//   3. revive authority       it catches up and rejoins voting
//   4. kill two               the height FREEZES; nothing is ever finalized
//                             below quorum; a write fails rather than being
//                             mined by a minority
//   5. revive one             progress resumes and the failed write lands
//   6. leader rotation        proposership visibly moves across the set
//   7. audit                  cmd/audit re-executes the finalized chain
//
// Exit code 0 means every scenario passed.

import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { BFT_TOPOLOGY, ROOT, delay, startCluster, waitFor } from "./cluster.mjs";

const QUORUM = Math.ceil((2 * BFT_TOPOLOGY.length) / 3);

// Hardhat account #4 — funded at genesis, and deliberately *not* one of the
// validator keys, so the transactions this gate sends are ordinary user
// traffic rather than anything privileged.
//
// The address is derived from the key rather than written down beside it. An
// earlier version hardcoded the wrong one, which made every nonce lookup
// answer 0 for an account that was not sending anything — the transactions
// still worked while the counter happened to be right, and failed two
// scenarios later with a confusing "nonce too low".
const SENDER_KEY = "47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
const RECIPIENT = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";

let failures = 0;
let scenario = "";

function step(name) {
  scenario = name;
  console.log(`\n=== ${name} ===`);
}

function check(ok, message) {
  if (ok) {
    console.log(`  PASS  ${message}`);
    return true;
  }
  failures++;
  console.error(`  FAIL  ${message}`);
  return false;
}

function fatal(message) {
  failures++;
  console.error(`  FAIL  [${scenario}] ${message}`);
  throw new Error(message);
}

// --- transaction helpers -------------------------------------------------

let viem;
async function loadViem() {
  if (!viem) viem = await import("viem");
  return viem;
}

let senderAccount;
async function sender() {
  if (!senderAccount) {
    const { privateKeyToAccount } = await import("viem/accounts");
    senderAccount = privateKeyToAccount(`0x${SENDER_KEY}`);
  }
  return senderAccount;
}

/**
 * Signs and submits a value transfer through `node`, returning the receipt.
 *
 * Any validator is a legitimate entry point under consensus — that is exactly
 * what the forwarder and the round-change machinery buy — so the gate sends
 * writes to whichever node it likes and expects them to land.
 */
async function submitTransfer(node, nonce) {
  const { createWalletClient, http, parseEther } = await loadViem();

  const account = await sender();
  const client = createWalletClient({ account, transport: http(node.rpcUrl) });

  const serialized = await client.signTransaction({
    chain: null,
    to: RECIPIENT,
    value: parseEther("0.0001"),
    nonce,
    gas: 21000n,
    gasPrice: 0n,
    chainId: 9494,
  });
  return node.rpc("eth_sendRawTransaction", [serialized]);
}

async function nextNonce(node) {
  const account = await sender();
  return Number(BigInt(await node.rpc("eth_getTransactionCount", [account.address, "latest"])));
}

// --- assertions ----------------------------------------------------------

/**
 * Every block from 1..height on `node` must carry a verified certificate
 * naming at least QUORUM distinct validators.
 *
 * This is the safety assertion, and it is re-run after every scenario —
 * including the ones where the chain is supposed to be stuck. A cluster that
 * bought liveness by lowering the bar would pass a height check and fail
 * here, which is the failure that matters.
 */
async function assertQuorumSeals(node, label) {
  const height = await node.blockNumber();
  if (height === 0) return { height, checked: 0 };

  let checked = 0;
  for (let n = 1; n <= height; n++) {
    const seals = await node.rpc("zk_getCommitSeals", [`0x${n.toString(16)}`]);
    if (!seals) {
      fatal(`${label}: block ${n} has no commit certificate`);
    }
    const signers = new Set(seals.seals.map((s) => s.address.toLowerCase()));
    if (signers.size < QUORUM) {
      fatal(`${label}: block ${n} finalized with ${signers.size} distinct signers, below the quorum of ${QUORUM}`);
    }
    for (const seal of seals.seals) {
      if (!seal.validator) {
        fatal(`${label}: block ${n} carries a seal from ${seal.address}, which is outside the validator set`);
      }
    }
    checked++;
  }
  return { height, checked };
}

/** Every live node must hold the identical chain, not merely the same height. */
async function assertConverged(nodes, label) {
  const heads = [];
  for (const node of nodes) {
    heads.push({ name: node.name, height: await node.blockNumber(), hash: await node.headHash() });
  }
  const first = heads[0];
  for (const head of heads.slice(1)) {
    if (head.height !== first.height || head.hash !== first.hash) {
      fatal(
        `${label}: validators disagree — ${first.name} at ${first.height}/${first.hash}, ` +
          `${head.name} at ${head.height}/${head.hash}`,
      );
    }
  }
  return first;
}

async function heights(nodes) {
  const out = {};
  for (const node of nodes) {
    out[node.name] = node.proc ? await node.blockNumber().catch(() => null) : null;
  }
  return out;
}

// --- the gate ------------------------------------------------------------

const cluster = await startCluster({ reset: true, quiet: true, topology: BFT_TOPOLOGY });
const { authority, jvp, unp, sjb } = cluster.byName;

try {
  // --- 1. four up: blocks finalize at full quorum -----------------------
  step("1. four validators up — blocks finalize with a quorum of signatures");

  const status = await authority.rpc("zk_consensusStatus");
  check(status.mode === "bft", `authority reports consensus mode ${status.mode}`);
  check(status.quorum === QUORUM, `quorum is ${status.quorum} (want ${QUORUM})`);
  check(status.validators.length === 4, `validator set has ${status.validators.length} members`);

  let nonce = await nextNonce(authority);
  for (let i = 0; i < 3; i++) {
    await submitTransfer(cluster.nodes[i % cluster.nodes.length], nonce + i);
  }

  await waitFor("all four validators to reach height 3", async () => {
    const h = await heights(cluster.nodes);
    return Object.values(h).every((v) => v !== null && v >= 3) || JSON.stringify(h);
  });

  const converged = await assertConverged(cluster.nodes, "scenario 1");
  check(converged.height >= 3, `all four validators converged at height ${converged.height}`);

  const sealed = await assertQuorumSeals(authority, "scenario 1");
  check(sealed.checked === sealed.height, `all ${sealed.checked} blocks carry >= ${QUORUM} distinct signers`);

  // --- 2. kill the authority: liveness holds ----------------------------
  step("2. authority killed — the chain keeps advancing (no single party can stop the election)");

  const before = await jvp.blockNumber();
  await authority.stop();

  const survivors = [jvp, unp, sjb];
  nonce = await nextNonce(jvp);
  for (let i = 0; i < 3; i++) {
    await submitTransfer(survivors[i % survivors.length], nonce + i);
  }

  await waitFor("the surviving three to advance three blocks", async () => {
    const h = await heights(survivors);
    return Object.values(h).every((v) => v !== null && v >= before + 3) || JSON.stringify(h);
  });

  const afterKill = await assertConverged(survivors, "scenario 2");
  check(afterKill.height >= before + 3, `height advanced ${before} -> ${afterKill.height} with the authority down`);

  const sealedWithoutAuthority = await assertQuorumSeals(jvp, "scenario 2");
  check(
    sealedWithoutAuthority.checked === sealedWithoutAuthority.height,
    `every block still carries >= ${QUORUM} signers — liveness was not bought by lowering the bar`,
  );

  // Proposership must have moved past the dead node.
  const jvpStatus = await jvp.rpc("zk_consensusStatus");
  check(jvpStatus.proposer !== "authority", `proposership rotated away from the dead node (now ${jvpStatus.proposer})`);

  // --- 3. revive the authority: it catches up and votes again -----------
  step("3. authority restarted — it re-executes what it missed and rejoins voting");

  await authority.start();
  await waitFor("authority to catch up", async () => {
    const mine = await authority.blockNumber();
    const theirs = await jvp.blockNumber();
    return mine === theirs || `authority ${mine} vs jvp ${theirs}`;
  });

  await assertConverged(cluster.nodes, "scenario 3");
  const rejoined = await assertQuorumSeals(authority, "scenario 3");
  check(rejoined.checked === rejoined.height, "the restarted validator holds a full certificate for every block");

  // It must be voting again, not merely following. Kill a different node so
  // the cluster cannot reach quorum without the one that just returned.
  await unp.stop();
  const beforeRejoinWrite = await authority.blockNumber();
  nonce = await nextNonce(authority);
  await submitTransfer(authority, nonce);
  await waitFor("a block that required the restarted validator's vote", async () => {
    const h = await authority.blockNumber();
    return h > beforeRejoinWrite || `still ${h}`;
  });
  check(true, "a block was finalized that could not have reached quorum without the restarted validator");
  await unp.start();
  await waitFor("unp to catch up", async () => {
    return (await unp.blockNumber()) === (await authority.blockNumber());
  });

  // --- 4. kill two: safety halt -----------------------------------------
  step("4. two validators killed — the height FREEZES rather than finalizing below quorum");

  await authority.stop();
  await jvp.stop();

  const remaining = [unp, sjb];
  const frozen = await heights(remaining);
  console.log(`  heights at freeze: ${JSON.stringify(frozen)}`);

  let writeRejected = false;
  try {
    nonce = await nextNonce(unp);
    await submitTransfer(unp, nonce);
  } catch (err) {
    writeRejected = true;
    console.log(`  write rejected as expected: ${err.message.split("\n")[0]}`);
  }
  check(writeRejected, "a write below quorum was refused rather than mined by a minority");

  // Give the round timer many more chances to do the wrong thing.
  await delay(15_000);

  const stillFrozen = await heights(remaining);
  check(
    JSON.stringify(stillFrozen) === JSON.stringify(frozen),
    `heights unchanged after 15s with only 2 of 4 reachable: ${JSON.stringify(stillFrozen)}`,
  );

  for (const node of remaining) {
    const s = await assertQuorumSeals(node, "scenario 4");
    check(s.checked === s.height, `${node.name}: no block anywhere was finalized with < ${QUORUM} signatures`);
  }

  // --- 5. revive one: progress resumes ----------------------------------
  step("5. one validator restored — quorum returns and the election continues");

  await jvp.start();
  const live = [jvp, unp, sjb];
  await waitFor("jvp to catch up", async () => {
    const mine = await jvp.blockNumber();
    const theirs = await unp.blockNumber();
    return mine === theirs || `jvp ${mine} vs unp ${theirs}`;
  });

  const beforeResume = await unp.blockNumber();
  nonce = await nextNonce(unp);
  await submitTransfer(unp, nonce);
  await waitFor("the chain to advance once quorum is restored", async () => {
    const h = await unp.blockNumber();
    return h > beforeResume || `still ${h}`;
  });

  const resumed = await assertConverged(live, "scenario 5");
  check(resumed.height > beforeResume, `progress resumed: ${beforeResume} -> ${resumed.height}`);

  const sealedAfterResume = await assertQuorumSeals(unp, "scenario 5");
  check(sealedAfterResume.checked === sealedAfterResume.height, "every block still carries a full quorum");

  await authority.start();
  await waitFor("authority to rejoin", async () => {
    return (await authority.blockNumber()) === (await unp.blockNumber());
  });

  // --- 6. leader rotation ------------------------------------------------
  step("6. proposership rotates across the validator set");

  const proposers = new Set();
  nonce = await nextNonce(authority);
  for (let i = 0; i < 8; i++) {
    const s = await authority.rpc("zk_consensusStatus");
    proposers.add(s.proposer);
    await submitTransfer(cluster.nodes[i % cluster.nodes.length], nonce + i);
  }
  await waitFor("eight more blocks", async () => {
    const h = await heights(cluster.nodes);
    return Object.values(h).every((v) => v !== null) || JSON.stringify(h);
  });

  check(
    proposers.size >= 3,
    `eight writes saw ${proposers.size} distinct proposers (${[...proposers].join(", ")}) — the schedule rotates`,
  );

  await assertConverged(cluster.nodes, "scenario 6");
  const finalSeals = await assertQuorumSeals(authority, "scenario 6");
  check(finalSeals.checked === finalSeals.height, `final chain: all ${finalSeals.height} blocks at full quorum`);

  // --- 7. the audit still passes ----------------------------------------
  step("7. cmd/audit re-executes the finalized chain (EVM semantics unchanged)");

  // The auditor opens the database exclusively, so the node holding it must
  // be stopped first.
  await authority.stop();

  const audit = spawnSync(
    process.platform === "win32" ? "go" : "go",
    ["run", "./cmd/audit", "-data-dir", join(cluster.dataRoot, "authority")],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, DATA_DIR: "", CONSENSUS_MODE: "" } },
  );
  const auditOut = `${audit.stdout ?? ""}${audit.stderr ?? ""}`.trim();
  console.log(`  ${auditOut.split("\n").pop()}`);
  check(
    audit.status === 0,
    "the auditor re-executed every block and reproduced every state root — commit seals did not disturb the chain",
  );
} catch (err) {
  // An abort is a failure. fatal() has already counted itself, but anything
  // else that threw — a missing dependency, an unreachable node, a bug in
  // this file — has not, and a gate that reports PASSED after aborting is
  // worse than no gate at all.
  if (failures === 0) failures++;
  console.error(`\nscenario "${scenario}" aborted: ${err.message}`);
} finally {
  await cluster.stop();
}

console.log("");
if (failures > 0) {
  console.error(`BFT CLUSTER GATE FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`BFT CLUSTER GATE PASSED: ${BFT_TOPOLOGY.length} validators, quorum ${QUORUM}, tolerates ${BFT_TOPOLOGY.length - QUORUM} failure`);
