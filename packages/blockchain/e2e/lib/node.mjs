// Single-node lifecycle control for the M14 e2e gate.
//
// cluster.mjs (M10) already does this for a 3-node cluster, but every node it
// starts is a cluster member: it wants certificates, a P2P port and peers.
// M14's election runs against ONE standalone node, and it has to stop and
// restart that node mid-run to prove the chain survives a restart — so it
// needs the process control without the cluster.
//
// The two files share `delay` and `waitFor` rather than reimplementing them;
// everything else here is deliberately separate, because a standalone node's
// configuration is defined by what it does NOT set (no PEERS, no TLS material,
// no P2P port) and expressing that as a special case of the cluster launcher
// would make both harder to read.

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ROOT, delay } from "../cluster.mjs";

const BINARY = join(ROOT, "bin", process.platform === "win32" ? "zk-blockchain-node.exe" : "zk-blockchain-node");
const AUDIT_BINARY = join(ROOT, "bin", process.platform === "win32" ? "zk-blockchain-audit.exe" : "zk-blockchain-audit");

const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;

export { BINARY as NODE_BINARY, AUDIT_BINARY };

/**
 * One standalone sequencer, started and stopped by us.
 *
 * The data directory is its own (`data-e2e` by default), never the `data/`
 * directory M08/M09/M11 leave behind: this gate resets the chain it runs on,
 * and destroying the chain those gates audited would be an unpleasant
 * surprise.
 */
export class ElectionNode {
  constructor({
    rpcPort = 9545,
    chainId = 9494,
    dataDir = join(ROOT, "data-e2e"),
    devRpc = true,
    quiet = false,
  } = {}) {
    this.rpcPort = rpcPort;
    this.chainId = chainId;
    this.dataDir = dataDir;
    this.devRpc = devRpc;
    this.quiet = quiet;
    this.rpcUrl = `http://127.0.0.1:${rpcPort}`;
    this.proc = null;
    this.exited = null;
    this.logLines = [];
    // Set by stop(); read by the restart check, which must not confuse a
    // deliberately abrupt kill with a node that lost data it had flushed.
    this.stopWasGraceful = null;
  }

  env() {
    return {
      ...process.env,
      CHAIN_ID: String(this.chainId),
      ROLE: "primary",
      RPC_PORT: String(this.rpcPort),
      DATA_DIR: this.dataDir,
      DEV_RPC: this.devRpc ? "true" : "false",
      LOG_FORMAT: "json",
      LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? "info",
      // Cleared explicitly. A stale PEERS from a leftover packages/blockchain/.env
      // or an exported variable turns this into a cluster sequencer, which then
      // fails to find certificates and exits — a confusing failure that
      // RUNNING-GATES §7 has already had to document once.
      PEERS: "",
      PRIMARY_RPC_URL: "",
      REPLICA_PULL_URL: "",
    };
  }

  /** Delete this node's chain state. Only ever touches `this.dataDir`. */
  reset() {
    rmSync(this.dataDir, { recursive: true, force: true });
  }

  async start() {
    if (this.proc) throw new Error("node is already running");
    if (!existsSync(BINARY)) {
      throw new Error(`node binary not found at ${BINARY}\nBuild it first:  make build`);
    }
    await this.requirePortFree();

    const proc = spawn(BINARY, [], { cwd: ROOT, env: this.env(), stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    this.exited = new Promise((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
    proc.once("exit", () => {
      this.proc = null;
    });

    const echo = (stream) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          // Kept whatever `quiet` says: a startup failure is diagnosed from
          // these lines, and they are worthless if we only capture them when
          // someone thought to ask.
          this.logLines.push(line);
          if (!this.quiet) console.log(`[node] ${line}`);
        }
      });
    };
    echo(proc.stdout);
    echo(proc.stderr);

    try {
      await this.waitForHealth(STARTUP_TIMEOUT_MS);
    } catch (err) {
      // A node that started but never became healthy would otherwise outlive
      // the harness, holding both the port and the Pebble lock — so the next
      // run fails with "something is already serving :9545" and the real cause
      // is two screens further up.
      await this.stop();
      throw err;
    }
    return this;
  }

  /**
   * Stop the node, preferring a graceful shutdown.
   *
   * This distinction turned out to matter a great deal, so it is worth stating
   * plainly. `cmd/node` handles SIGTERM/os.Interrupt: it shuts the RPC server
   * down and calls `db.Close()`, which flushes Pebble's write-ahead log. Killed
   * abruptly it does neither, and go-ethereum's Pebble wrapper commits with
   * Sync disabled — so the most recently sealed blocks can still be sitting in
   * an unflushed buffer and are simply gone on the next open. The node then
   * correctly reopens at the last head it can prove, which is what M09's
   * `TestChainRecoversFromAPartialWrite` describes.
   *
   * Node.js cannot send a POSIX signal to a child on Windows — `kill()` there
   * "will be killed forcefully and abruptly (similar to SIGKILL)" whatever
   * signal is named. So `stopWasGraceful` records which of the two actually
   * happened, and the restart check reads it rather than assuming.
   *
   * @returns {Promise<boolean>} whether the shutdown was graceful
   */
  async stop() {
    if (!this.proc) {
      this.stopWasGraceful = true;
      return true;
    }
    const exited = this.exited;

    if (process.platform === "win32") {
      // No graceful path exists here. Documented rather than silently accepted:
      // a caller that needs a clean stop needs to know it did not get one.
      this.stopWasGraceful = false;
      this.proc.kill();
    } else {
      this.stopWasGraceful = true;
      this.proc.kill("SIGTERM");
    }

    const outcome = await Promise.race([exited.then(() => "exited"), delay(SHUTDOWN_TIMEOUT_MS).then(() => "timeout")]);
    if (outcome === "timeout") {
      // It ignored SIGTERM. Escalate, and stop claiming the stop was clean.
      this.stopWasGraceful = false;
      try {
        this.proc?.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      await Promise.race([exited, delay(2_000)]);
    }

    this.proc = null;
    // Pebble releases its directory lock on exit, and `make audit` opens the
    // same directory. Give the OS a moment to finish the close before anyone
    // races us for the lock.
    await delay(250);
    return this.stopWasGraceful;
  }

  /**
   * Refuse to start on an occupied port instead of racing whatever is there.
   *
   * Without this, a `make run` left over in another terminal answers our health
   * check, the harness cheerfully drives *that* node, and the restart and audit
   * steps then operate on a data directory nobody is writing to. The failure
   * that produces is almost impossible to read backwards.
   */
  async requirePortFree() {
    const health = await this.health();
    if (health) {
      throw new Error(
        `something is already serving ${this.rpcUrl} (health: ${JSON.stringify(health)}).\n` +
          `Stop it, or run with --rpc-url to drive it instead of managing a node here.`,
      );
    }
  }

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
      if (this.proc === null) {
        throw new Error(`the node exited during startup:\n${this.logLines.slice(-10).join("\n")}`);
      }
      const health = await this.health();
      if (health) return health;
      await delay(100);
    }
    throw new Error(`the node did not become healthy within ${timeoutMs} ms`);
  }
}
