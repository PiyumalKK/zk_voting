// The real UltraHonk prover, in Node.
//
// M14 deliverable 1 requires the e2e election to generate a REAL proof — not a
// fixture, not a stub. A vote that carries a canned proof proves nothing about
// the chain: `Voting.vote()` calls `HonkVerifier.verify()`, that call is the
// single most gas-heavy and EVM-sensitive thing the whole application does, and
// it is exactly what a chain reimplementation is most likely to break.
//
// This is the same pipeline the app uses, deliberately: Noir executes the
// circuit to a witness, Barretenberg's UltraHonk backend proves it with the
// keccak oracle, because that is the flavour `HonkVerifier.sol` was generated
// for. Any divergence here would produce a proof that fails on chain for
// reasons that have nothing to do with the chain.
//   web voter UI + mobile WebView prover: packages/nextjs/app/prover/page.tsx
//
// Prerequisite worth knowing about before the first run: bb.js downloads its
// structured reference string (~300 MB of ignition points, trimmed to the
// circuit's size) from aztec-ignition.s3.amazonaws.com and caches it in
// ~/.bb-crs. So the FIRST proof needs internet access and takes noticeably
// longer than later ones. loadCircuit() checks nothing about this; the failure
// is a plain network error naming that host, and this comment is where to look
// when it appears.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../cluster.mjs";

/**
 * The compiled circuit, read from where the Next.js app serves it.
 *
 * Read at runtime rather than vendored, for the same reason smoke-deploy.mjs
 * reads contract artifacts out of packages/hardhat: a copy is a thing that can
 * drift from what the app actually proves against, and a gate running against
 * a stale circuit is worse than no gate.
 */
export const CIRCUIT_PATH = join(ROOT, "..", "nextjs", "public", "circuits.json");

export function loadCircuit(path = CIRCUIT_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `could not read the compiled circuit at ${path}: ${err.message}\n` +
        `It is produced by \`nargo compile\` in packages/circuits and served by the Next.js app.`,
    );
  }
  const circuit = JSON.parse(raw);
  if (!circuit.bytecode || !circuit.abi) {
    throw new Error(`${path} does not look like a compiled Noir circuit (no bytecode/abi)`);
  }
  return circuit;
}

/**
 * Check that the proving stack is installed, without loading it.
 *
 * The two WASM modules are imported lazily inside generateVoteProof, which is
 * right — they are large and a run that never proves should not pay for them —
 * but it means a missing dependency surfaces only after a deploy, five
 * registrations and a phase lifecycle have already run. Several minutes in, to
 * be told to run `npm install`. `import.meta.resolve` answers the same question
 * from the module map alone, in microseconds, at preflight.
 *
 * @returns {string[]} the specifiers that could not be resolved
 */
export function missingProverDependencies() {
  return ["@noir-lang/noir_js", "@aztec/bb.js"].filter((specifier) => {
    try {
      import.meta.resolve(specifier);
      return false;
    } catch {
      return true;
    }
  });
}

/**
 * Execute the circuit and prove it.
 *
 * @param {object} circuit the compiled circuit (from loadCircuit)
 * @param {object} inputs witness inputs, as built by election-core's buildCircuitInputs
 * @returns {Promise<{proof: `0x${string}`, publicInputs: string[], witnessMs: number, proveMs: number}>}
 */
export async function generateVoteProof(circuit, inputs) {
  // Imported here rather than at module scope so that a run which never proves
  // (--help, a preflight failure, the offline unit tests) does not pay for
  // loading two large WASM modules.
  const { Noir } = await import("@noir-lang/noir_js");
  const { UltraHonkBackend } = await import("@aztec/bb.js");

  const witnessStart = Date.now();
  const noir = new Noir(circuit);
  const { witness } = await noir.execute(inputs);
  const witnessMs = Date.now() - witnessStart;

  // threads: 1 matches the WebView prover the mobile app actually runs, so the
  // timing this harness reports is comparable to what a voter experiences
  // rather than to what a many-core server can do.
  const backend = new UltraHonkBackend(circuit.bytecode, { threads: 1 });

  // bb.js writes progress chatter straight to console.log. The app's prover
  // page silences it the same way; here it would drown the [PASS]/[FAIL] lines
  // that are this harness's actual output.
  const realLog = console.log;
  console.log = () => {};
  const proveStart = Date.now();
  try {
    const { proof, publicInputs } = await backend.generateProof(witness, { keccak: true });
    const proveMs = Date.now() - proveStart;
    return {
      proof: `0x${Buffer.from(proof).toString("hex")}`,
      publicInputs,
      witnessMs,
      proveMs,
    };
  } finally {
    console.log = realLog;
    // Barretenberg keeps worker threads alive; without this the process hangs
    // after the last check instead of exiting. Wrapped rather than written as
    // `destroy?.().catch(…)`: if a future bb.js makes destroy synchronous, that
    // form calls .catch on undefined and turns a successful proof into a
    // TypeError thrown from a finally block, which would mask the real result.
    try {
      await backend.destroy?.();
    } catch {
      // A backend that will not shut down cleanly is not a reason to fail a
      // proof that already succeeded; the process exits either way.
    }
  }
}
