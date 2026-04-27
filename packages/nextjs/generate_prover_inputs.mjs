// Generate valid Prover.toml inputs for the ZK voting circuit
// Uses the same Poseidon hash as the Noir circuit (BN254)

import { poseidon1, poseidon2 } from "poseidon-lite";

// --- Arbitrary private values ---
const nullifier = 42n;
const secret = 123n;

// --- Compute nullifier_hash = poseidon1(nullifier) ---
const nullifier_hash = poseidon1([nullifier]);

// --- Compute commitment = poseidon2(nullifier, secret) ---
const commitment = poseidon2([nullifier, secret]);

console.log("nullifier      =", nullifier.toString());
console.log("secret         =", secret.toString());
console.log("nullifier_hash =", nullifier_hash.toString());
console.log("commitment     =", commitment.toString());

// --- Build a depth-3 Merkle tree (8 leaves) with commitment at index 2 ---
// The binary_merkle_root function in the circuit works bottom-up:
//   - index bits (little-endian) determine left/right placement
//   - hash_2([left, right]) combines siblings
//
// For depth=3, index=2:
//   index 2 in binary = 010, little-endian bits = [0, 1, 0]
//   Level 0: bit=0 → commitment is LEFT child, sibling[0] is RIGHT
//   Level 1: bit=1 → node is RIGHT child, sibling[1] is LEFT
//   Level 2: bit=0 → node is LEFT child, sibling[2] is RIGHT

// Pick arbitrary sibling values (just dummy leaves/nodes)
const sibling0 = 111n; // sibling at level 0 (leaf next to commitment)
const sibling1 = 222n; // sibling at level 1 (sibling subtree hash)
const sibling2 = 333n; // sibling at level 2 (sibling subtree hash)

// Compute root step by step, matching the circuit's binary_merkle_root logic:
// Level 0: bit=0 → hash(commitment, sibling0)
const node0 = poseidon2([commitment, sibling0]);
console.log("\nLevel 0: hash2([commitment, sibling0]) =", node0.toString());

// Level 1: bit=1 → hash(sibling1, node0)
const node1 = poseidon2([sibling1, node0]);
console.log("Level 1: hash2([sibling1, node0])      =", node1.toString());

// Level 2: bit=0 → hash(node1, sibling2)
const root = poseidon2([node1, sibling2]);
console.log("Level 2: hash2([node1, sibling2])       =", root.toString());

console.log("\nroot           =", root.toString());

// --- Format siblings array (padded to 16 with zeros) ---
const siblings = [sibling0, sibling1, sibling2, ...Array(13).fill(0n)];

// --- Output Prover.toml ---
console.log("\n========== Prover.toml ==========\n");
console.log(`depth = "3"`);
console.log(`index = "2"`);
console.log(`nullifier = "${nullifier}"`);
console.log(`nullifier_hash = "${nullifier_hash}"`);
console.log(`root = "${root}"`);
console.log(`secret = "${secret}"`);
console.log(`siblings = [${siblings.map(s => `"${s}"`).join(", ")}]`);
console.log(`vote = "1"`);
