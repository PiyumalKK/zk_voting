import * as Crypto from "expo-crypto";
import { poseidon1, poseidon2 } from "poseidon-lite";

/**
 * ZK commitment crypto — MUST match the Noir circuit (main.nr) exactly:
 *   nullifier_hash = poseidon1([nullifier])
 *   commitment     = poseidon2([nullifier, secret])
 *
 * The tree leaf stored on-chain is the commitment. At vote time the voter proves,
 * in zero knowledge, that they know (nullifier, secret) for a leaf in the tree and
 * reveals only nullifier_hash (to prevent double voting).
 */

// BN254 scalar field prime — the field the circuit operates over.
const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Cryptographically secure random field element. */
function randomFieldElement(): bigint {
  const bytes = Crypto.getRandomBytes(32);
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  return value % FIELD_PRIME;
}

export interface VoterCommitment {
  nullifier: string;
  secret: string;
  commitment: string;
  nullifierHash: string;
}

/** Generate a fresh voter commitment (called once, during registration). */
export function generateCommitment(): VoterCommitment {
  const nullifier = randomFieldElement();
  const secret = randomFieldElement();
  const commitment = poseidon2([nullifier, secret]);
  const nullifierHash = poseidon1([nullifier]);
  return {
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    commitment: commitment.toString(),
    nullifierHash: nullifierHash.toString(),
  };
}

/** Recompute the commitment + nullifier hash from stored secrets (vote time). */
export function deriveFromSecrets(nullifier: string, secret: string): { commitment: string; nullifierHash: string } {
  const n = BigInt(nullifier);
  const s = BigInt(secret);
  return {
    commitment: poseidon2([n, s]).toString(),
    nullifierHash: poseidon1([n]).toString(),
  };
}
