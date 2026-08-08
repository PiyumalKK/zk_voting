#!/usr/bin/env node
// Local 3-node cluster launcher (MASTER blockchain-v2 M10 deliverable 5).
//
// Starts one sequencer and two read replicas as child processes, each with
// its own data directory, RPC port and P2P port, all sharing the certificate
// authority `make gen-certs` produced:
//
//   primary   RPC :9545   P2P :9546   data-cluster/primary
//   replica1  RPC :9555   P2P :9556   data-cluster/replica1
//   replica2  RPC :9565   P2P :9566   data-cluster/replica2
//
// Usage:
//   node cluster.mjs                 # start and stay up until Ctrl+C
//   node cluster.mjs --reset         # wipe the cluster's data directories first
//   node cluster.mjs --quiet         # don't echo node logs
// or, from packages/blockchain: `make run-cluster`
//
// It is also a module: cluster-test.mjs imports startCluster() and drives the
// same processes, including stopping and restarting one of them mid-test.
// That is the reason this is Node rather than a shell script — the gate needs
// programmatic process control, and writing it twice (once for the launcher,
// once for the test) is how the two drift apart.
//
// Prerequisites, both checked with a real error message rather than a crash:
//   - the node binary is built            (`make build`)
//   - certificates exist in ../certs      (`make gen-certs`)

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");

const BINARY = join(ROOT, "bin", process.platform === "win32" ? "zk-blockchain-node.exe" : "zk-blockchain-node");
const CERTS = join(ROOT, "certs");
const DATA_ROOT = join(ROOT, "data-cluster");
// A separate root so a BFT run and a solo run can coexist on one machine
// without one inheriting the other's chain.
const BFT_DATA_ROOT = join(ROOT, "data-cluster-bft");

const CHAIN_ID = "9494";
// The cluster runs with the dev namespaces on: it is a development cluster,
// and the gate drives evm_mine through a replica to prove dev methods are
// forwarded rather than served locally.
const DEV_RPC = "true";

const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** The cluster's topology. Replica count is data, not code (MASTER §3). */
export const TOPOLOGY = [
  { name: "primary", role: "primary", rpcPort: 9545, p2pPort: 9546 },
  { name: "replica1", role: "replica", rpcPort: 9555, p2pPort: 9556 },
  { name: "replica2", role: "replica", rpcPort: 9565, p2pPort: 9566 },
];

const PRIMARY = TOPOLOGY[0];

// --- BFT (CONSENSUS_MODE=bft) -------------------------------------------
//
// The four validators of the deployed cluster. Every one is ROLE=primary:
// there is no replica in a BFT cluster, because a replica cannot propose, so
// a validator configured as one would hold a key, be counted in the quorum,
// and never take its turn — leaving the cluster permanently one short.
//
// The keys are Hardhat's well-known accounts #0–#3, from the public
// "test test … junk" mnemonic that ships in Hardhat's own documentation.
// They are NOT secrets and are used here for the same reason
// cluster-test.mjs already uses account #0 to sign test transactions: a local
// cluster needs deterministic identities. Production validator keys come from
// GitHub Actions secrets, are written to a 0600 file on each host, and never
// enter this repository — see CONSENSUS.md.
export const BFT_TOPOLOGY = [
  {
    name: "authority",
    role: "primary",
    rpcPort: 9545,
    p2pPort: 9546,
    key: "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  },
  {
    name: "jvp",
    role: "primary",
    rpcPort: 9555,
    p2pPort: 9556,
    key: "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  },
  {
    name: "unp",
    role: "primary",
    rpcPort: 9565,
    p2pPort: 9566,
    key: "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  },
  {
    name: "sjb",
    role: "primary",
    rpcPort: 9575,
    p2pPort: 9576,
    key: "7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  },
];

/** VALIDATOR_SET as every validator must see it — same members, same order. */
function validatorSetEnv(topology) {
  return topology.map((n) => `${n.name}:${n.address}`).join(",");
}

const ROUND_TIMEOUT_MS = process.env.BFT_ROUND_TIMEOUT_MS ?? "1500";

/** One node process. */
export class ClusterNode {
  constructor(spec, { quiet = false, topology = TOPOLOGY, dataRoot = DATA_ROOT, binary = BINARY } = {}) {
    this.name = spec.name;
    this.role = spec.role;
    this.spec = spec;
    this.topology = topology;
    this.bft = topology === BFT_TOPOLOGY || Boolean(spec.key);
    this.binary = binary;
    this.rpcPort = spec.rpcPort;
    this.p2pPort = spec.p2pPort;
    this.rpcUrl = `http://127.0.0.1:${spec.rpcPort}`;
    this.p2pUrl = `https://127.0.0.1:${spec.p2pPort}`;
    this.dataDir = join(dataRoot, spec.name);
    this.quiet = quiet;
    this.proc = null;
    this.exited = null;
    // A validator reports role "validator" on /health even though it is
    // configured ROLE=primary, so waitForHealth has to expect that.
    this.healthRole = this.bft ? "validator" : spec.role;
  }

  env() {
    const base = {
      // Inherit PATH etc., but not the caller's chain configuration: a stale
      // ROLE or DATA_DIR in the parent environment would otherwise silently
      // reconfigure a node here.
      ...process.env,
      CHAIN_ID,
      ROLE: this.role,
      RPC_PORT: String(this.rpcPort),
      P2P_PORT: String(this.p2pPort),
      DATA_DIR: this.dataDir,
      DEV_RPC,
      TLS_CERT: join(CERTS, `${this.name}.crt`),
      TLS_KEY: join(CERTS, `${this.name}.key`),
      TLS_CA: join(CERTS, "ca.crt"),
      LOG_FORMAT: "json",
      LOG_LEVEL: process.env.CLUSTER_LOG_LEVEL ?? "info",
      // Explicitly cleared rather than left unset: a leftover .env or an
      // exported variable would otherwise reach the child.
      PEERS: "",
      PRIMARY_RPC_URL: "",
      REPLICA_PULL_URL: "",
      // Cleared for the same reason as the above: a solo node refuses to
      // boot if any validator variable is set, so a leftover export from a
      // previous BFT run must not reach a solo child.
      CONSENSUS_MODE: "",
      VALIDATOR_ID: "",
      VALIDATOR_PRIVATE_KEY: "",
      VALIDATOR_PRIVATE_KEY_FILE: "",
      VALIDATOR_SET: "",
      CONSENSUS_PEERS: "",
      VALIDATOR_RPC_URLS: "",
      QUORUM: "",
    };

    if (this.bft) {
      const others = this.topology.filter((n) => n.name !== this.name);
      base.CONSENSUS_MODE = "bft";
      base.VALIDATOR_ID = this.name;
      base.VALIDATOR_PRIVATE_KEY = this.spec.key;
      base.VALIDATOR_SET = validatorSetEnv(this.topology);
      base.CONSENSUS_PEERS = others.map((n) => `${n.name}=https://127.0.0.1:${n.p2pPort}`).join(",");
      // Optional in production, set here so the happy path is one hop and
      // the gate is not dominated by round timeouts.
      base.VALIDATOR_RPC_URLS = others.map((n) => `${n.name}=http://127.0.0.1:${n.rpcPort}`).join(",");
      base.ROUND_TIMEOUT_MS = ROUND_TIMEOUT_MS;
      return base;
    }

    if (this.role === "primary") {
      base.PEERS = TOPOLOGY.filter((n) => n.role === "replica")
        .map((n) => `https://127.0.0.1:${n.p2pPort}`)
        .join(",");
    } else {
      base.PRIMARY_RPC_URL = `http://127.0.0.1:${PRIMARY.rpcPort}`;
      base.REPLICA_PULL_URL = `https://127.0.0.1:${PRIMARY.p2pPort}`;
    }
    return base;
  }

  async start() {
    if (this.proc) throw new Error(`${this.name} is already running`);

    const proc = spawn(this.binary, [], { cwd: ROOT, env: this.env(), stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    this.exited = new Promise((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));

    const echo = (stream) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        if (this.quiet) return;
        for (const line of chunk.split("\n")) {
          if (line.trim()) console.log(`[${this.name}] ${line}`);
        }
      });
    };
    echo(proc.stdout);
    echo(proc.stderr);

    proc.once("exit", () => {
      this.proc = null;
    });

    await this.waitForHealth(STARTUP_TIMEOUT_MS);
    return this;
  }

  async stop() {
    if (!this.proc) return;
    const exited = this.exited;
    this.proc.kill();
    await Promise.race([exited, delay(SHUTDOWN_TIMEOUT_MS)]);
    this.proc = null;
  }

  /** Reads /health. Returns null while the node is not answering yet. */
  async health() {
    try {
      const resp = await fetch(`${this.rpcUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }

  async waitForHealth(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.proc === null) throw new Error(`${this.name} exited during startup (see its log above)`);
      const health = await this.health();
      if (health && health.role === this.healthRole) return health;
      await delay(100);
    }
    throw new Error(`${this.name} did not become healthy within ${timeoutMs} ms`);
  }

  /** One JSON-RPC call against this node. */
  async rpc(method, params = []) {
    const resp = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await resp.json();
    if (body.error) {
      const err = new Error(`${this.name} ${method}: ${body.error.message}`);
      err.rpcError = body.error;
      throw err;
    }
    return body.result;
  }

  async blockNumber() {
    return Number(BigInt(await this.rpc("eth_blockNumber")));
  }

  async headHash() {
    const block = await this.rpc("eth_getBlockByNumber", ["latest", false]);
    return block.hash;
  }
}

/**
 * Starts the whole cluster.
 *
 * Solo: the primary first, then the replicas (which connect to it at boot).
 * BFT: every validator, in order. Startup order does not matter there — a
 * validator that comes up first simply has nobody to talk to yet, buffers
 * nothing, and starts participating when the others appear. That is the same
 * code path a validator restarted mid-election takes.
 */
export async function startCluster({ reset = false, quiet = false, topology = TOPOLOGY, binary = BINARY } = {}) {
  const bft = topology === BFT_TOPOLOGY;
  const dataRoot = bft ? BFT_DATA_ROOT : DATA_ROOT;

  requirePrerequisites(topology, binary);
  if (reset) resetClusterData(dataRoot);

  const nodes = topology.map((spec) => new ClusterNode(spec, { quiet, topology, dataRoot, binary }));
  const cluster = {
    nodes,
    bft,
    dataRoot,
    byName: Object.fromEntries(nodes.map((n) => [n.name, n])),
    primary: nodes[0],
    replicas: nodes.slice(1),
    validators: nodes,
    async stop() {
      // Replicas first: stopping the primary out from under a replica mid-pull
      // produces a burst of alarming (and meaningless) connection errors.
      for (const node of [...nodes].reverse()) await node.stop();
    },
  };

  try {
    for (const node of nodes) await node.start();
  } catch (err) {
    await cluster.stop();
    throw err;
  }
  return cluster;
}

export function resetClusterData(dataRoot = DATA_ROOT) {
  rmSync(dataRoot, { recursive: true, force: true });
}

function requirePrerequisites(topology = TOPOLOGY, binary = BINARY) {
  if (!existsSync(binary)) {
    const how = binary === BINARY ? "make build" : "make build-byzantine";
    throw new Error(`node binary not found at ${binary}\nBuild it first:  ${how}`);
  }
  const required = ["ca.crt", ...topology.map((n) => `${n.name}.crt`), ...topology.map((n) => `${n.name}.key`)];
  const missing = required.filter((file) => !existsSync(join(CERTS, file)));
  if (missing.length > 0) {
    throw new Error(`missing certificates in ${CERTS}: ${missing.join(", ")}\nGenerate them first:  make gen-certs`);
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls cond() until it is truthy, or fails with `what` in the message. */
export async function waitFor(what, cond, timeoutMs = 30_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "";
  while (Date.now() < deadline) {
    const result = await cond();
    if (result === true) return;
    if (typeof result === "string") lastDetail = result;
    else if (result) return;
    await delay(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${lastDetail ? ` (last: ${lastDetail})` : ""}`);
}

// --- CLI ---------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const reset = process.argv.includes("--reset");
  const quiet = process.argv.includes("--quiet");
  const bft = process.argv.includes("--bft");

  const cluster = await startCluster({ reset, quiet, topology: bft ? BFT_TOPOLOGY : TOPOLOGY });

  console.log(`\n${bft ? "BFT validator cluster" : "cluster"} up:`);
  for (const node of cluster.nodes) {
    console.log(`  ${node.name.padEnd(9)} rpc ${node.rpcUrl}   p2p ${node.p2pUrl}   data ${node.dataDir}`);
  }
  if (bft) {
    console.log(
      `\n${cluster.nodes.length} validators, quorum ${Math.ceil((2 * cluster.nodes.length) / 3)}: ` +
        `writes may go to ANY node, and the chain survives losing one. Ctrl+C to stop.\n`,
    );
  } else {
    console.log("\nPoint the app at the primary for writes, at any node for reads. Ctrl+C to stop.\n");
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\nstopping cluster...");
    await cluster.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
