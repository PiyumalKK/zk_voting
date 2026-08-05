// Pure election cryptography and Merkle-path logic for the M14 e2e gate.
//
// Everything in this file is deterministic and side-effect free: no network,
// no chain, no filesystem. That is deliberate. The full election harness
// (../election.mjs) needs a running node, a compiled circuit and several
// minutes; the logic that is easiest to get subtly wrong needs neither, so it
// lives here and is unit-tested offline by ./election-core.test.mjs.
//
// Every function here MIRRORS code that already exists in the app. The mirror
// is intentional (M14 deliverable 1 says "reimport the merkle-path route's
// logic"), but a mirror that drifts is worse than no mirror at all, so each
// function names its counterpart and the harness asserts the derived root
// equals the root the Voting contract itself reports. That assertion is what
// makes drift a loud failure at the next gate run rather than a silent one.
//
//   generateCommitment / deriveFromSecrets   <- packages/mobile/src/services/crypto.ts
//   buildMerklePath                          <- packages/nextjs/app/api/merkle-path/route.ts
//   buildCircuitInputs / toBytes32           <- packages/mobile/src/services/zkproof.ts
//
// The circuit itself (packages/circuits/src/main.nr) is the authority for the
// shapes below:
//   PUBLIC : nullifier_hash, root, vote, depth
//   PRIVATE: nullifier, secret, index, siblings[16]

import { randomBytes } from "node:crypto";

import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon1, poseidon2 } from "poseidon-lite";

/** BN254 scalar field prime — the field the Noir circuit operates over. */
export const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * The circuit's fixed sibling-array length. The Noir circuit takes exactly 16
 * siblings whatever the tree's real depth is; shorter paths are zero-padded and
 * the real depth is passed separately as a public input.
 */
export const CIRCUIT_DEPTH = 16;

/** The LeanIMT hash: poseidon2 over a pair of field elements. */
export const hashPair = (a, b) => poseidon2([a, b]);

/**
 * A cryptographically secure random field element.
 *
 * Mirrors mobile's randomFieldElement(), including its modulo reduction. The
 * bias that `% FIELD_PRIME` introduces is negligible here (the prime is within
 * 2^-127 of 2^254) and matching the app matters more than improving on it —
 * this code exists to reproduce the app's behaviour, not to better it.
 */
export function randomFieldElement() {
  let value = 0n;
  for (const b of randomBytes(32)) value = (value << 8n) | BigInt(b);
  return value % FIELD_PRIME;
}

/**
 * Generate a fresh voter commitment, exactly as the mobile app does at
 * registration time.
 *
 * @returns {{nullifier: string, secret: string, commitment: string, nullifierHash: string}}
 *          all values as decimal strings, the form every consumer expects
 */
export function generateCommitment() {
  const nullifier = randomFieldElement();
  const secret = randomFieldElement();
  return {
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    commitment: poseidon2([nullifier, secret]).toString(),
    nullifierHash: poseidon1([nullifier]).toString(),
  };
}

/** Recompute commitment + nullifier hash from stored secrets (vote time). */
export function deriveFromSecrets(nullifier, secret) {
  const n = BigInt(nullifier);
  const s = BigInt(secret);
  return {
    commitment: poseidon2([n, s]).toString(),
    nullifierHash: poseidon1([n]).toString(),
  };
}

/**
 * Order a division's current-election leaves out of its raw `NewLeaf` logs.
 *
 * `Voting.resetElection()` bumps the election id and starts a fresh tree, but
 * the old elections' logs stay on chain forever — so the current tree is the
 * LAST `treeSize` leaves, not all of them. Within that window the leaves are
 * sorted by the index the contract emitted rather than by log order, because
 * the index is what the tree is built from and log order is only incidentally
 * the same.
 *
 * Mirrors /api/merkle-path. Throws rather than returning a short array: a
 * count mismatch means the log query and the contract disagree, which is a
 * node bug worth stopping on.
 *
 * @param {Array<{index: number|bigint, value: bigint}>} leafEvents decoded NewLeaf args
 * @param {number} treeSize the contract's reported current tree size
 * @returns {bigint[]} leaves, oldest first
 */
export function leavesFromEvents(leafEvents, treeSize) {
  if (!Number.isInteger(treeSize) || treeSize < 0) {
    throw new Error(`treeSize must be a non-negative integer, got ${treeSize}`);
  }
  // Handled before the slice below, not by it: `array.slice(-0)` is
  // `array.slice(0)`, which returns the WHOLE array rather than none of it.
  // An empty current election would otherwise be reported as a count mismatch
  // against every leaf every past election ever added.
  if (treeSize === 0) return [];

  const current = leafEvents
    .slice(-treeSize)
    .map((e) => ({ index: Number(e.index), value: BigInt(e.value) }))
    .sort((a, b) => a.index - b.index);

  if (current.length !== treeSize) {
    throw new Error(`NewLeaf event count ${current.length} does not match on-chain tree size ${treeSize}`);
  }
  return current.map((e) => e.value);
}

/** Rebuild the division's LeanIMT from its ordered leaves. */
export function rebuildTree(leaves) {
  const tree = new LeanIMT(hashPair);
  if (leaves.length > 0) tree.insertMany(leaves);
  return tree;
}

/**
 * Find the index the Noir circuit needs.
 *
 * The circuit's binary_merkle_root walks the path using the little-endian bits
 * of `index` to decide left/right at each level. A LeanIMT is not a full binary
 * tree — it collapses lone right-hand nodes — so its leaf index is not always
 * the bit pattern the circuit needs. Rather than reimplement LeanIMT's
 * collapsing rules (and own that bug forever), both the app and this harness
 * brute-force the small search space: at most 2^depth candidates, and depth is
 * the number of siblings, which for any realistic division is well under 20.
 *
 * Mirrors /api/merkle-path's loop exactly, including its bit order.
 *
 * @returns {number} the circuit index, or -1 if no candidate reproduces the root
 */
export function findCircuitIndex(commitment, siblings, root) {
  const leaf = BigInt(commitment);
  const sibs = siblings.map(BigInt);
  const target = BigInt(root);
  const max = 1 << sibs.length;

  for (let candidate = 0; candidate < max; candidate++) {
    let current = leaf;
    for (let level = 0; level < sibs.length; level++) {
      const isRight = (candidate >> level) & 1;
      current = isRight ? poseidon2([sibs[level], current]) : poseidon2([current, sibs[level]]);
    }
    if (current === target) return candidate;
  }
  return -1;
}

/**
 * Pad a sibling list to the circuit's fixed length with zeros.
 * Returns decimal strings, which is what Noir's ABI encoder accepts.
 */
export function padSiblings(siblings, length = CIRCUIT_DEPTH) {
  const padded = siblings.map((s) => BigInt(s).toString());
  if (padded.length > length) {
    throw new Error(`path of ${padded.length} siblings exceeds the circuit's ${length}`);
  }
  while (padded.length < length) padded.push("0");
  return padded;
}

/**
 * Build the full inclusion proof for `commitment` from a division's NewLeaf
 * events — the whole of /api/merkle-path, minus the HTTP.
 *
 * @param {object} args
 * @param {Array<{index: number|bigint, value: bigint}>} args.leafEvents decoded NewLeaf args
 * @param {number} args.treeSize the contract's current tree size
 * @param {string|bigint} args.commitment the leaf to prove
 * @returns {{leafIndex: number, circuitIndex: number, depth: number, root: string,
 *            siblings: string[], treeSize: number}}
 */
export function buildMerklePath({ leafEvents, treeSize, commitment }) {
  if (treeSize === 0) throw new Error("no voters registered in this division yet");

  const leaves = leavesFromEvents(leafEvents, treeSize);
  const target = BigInt(commitment);

  const leafIndex = leaves.findIndex((v) => v === target);
  if (leafIndex === -1) throw new Error("commitment not found in this division's tree");

  const tree = rebuildTree(leaves);
  const proof = tree.generateProof(leafIndex);
  const siblings = proof.siblings.map((s) => BigInt(s));
  const root = BigInt(proof.root);

  const circuitIndex = findCircuitIndex(target, siblings, root);
  if (circuitIndex === -1) throw new Error("could not derive a circuit index that reproduces the root");

  return {
    leafIndex,
    circuitIndex,
    depth: siblings.length,
    root: root.toString(),
    siblings: padSiblings(siblings),
    treeSize,
  };
}

/**
 * Assemble the witness inputs in the exact shape the circuit declares.
 * Mirrors mobile's buildCircuitInputs().
 */
export function buildCircuitInputs({ nullifier, secret, circuitIndex, siblings, root, candidateIndex, depth }) {
  const { nullifierHash } = deriveFromSecrets(nullifier, secret);
  return {
    // public
    nullifier_hash: nullifierHash,
    root: BigInt(root).toString(),
    vote: String(candidateIndex),
    depth: String(depth),
    // private
    nullifier: BigInt(nullifier).toString(),
    secret: BigInt(secret).toString(),
    index: String(circuitIndex),
    siblings: padSiblings(siblings),
  };
}

/**
 * A decimal (or hex) field value as a 32-byte hex word, the encoding
 * `Voting.vote()` takes for its four public inputs.
 */
export function toBytes32(value) {
  const n = BigInt(value);
  if (n < 0n) throw new Error(`cannot encode a negative value as bytes32: ${value}`);
  const hex = n.toString(16);
  if (hex.length > 64) throw new Error(`value does not fit in 32 bytes: ${value}`);
  return `0x${hex.padStart(64, "0")}`;
}

/**
 * Turn circuit inputs plus raw proof bytes into the five arguments
 * `Voting.vote()` expects, in order.
 */
export function buildVoteArgs(inputs, proofHex) {
  if (typeof proofHex !== "string" || !/^0x[0-9a-fA-F]*$/.test(proofHex)) {
    throw new Error("proof must be a 0x-prefixed hex string");
  }
  return {
    proof: proofHex,
    nullifierHash: toBytes32(inputs.nullifier_hash),
    root: toBytes32(inputs.root),
    vote: toBytes32(inputs.vote),
    depth: toBytes32(inputs.depth),
  };
}
