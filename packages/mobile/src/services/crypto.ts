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

/**
 * The two random values a voter's identity is built from.
 *
 * Generated once, when the identity itself is created — nothing about them is
 * specific to registration, and minting them at identity-creation time is what
 * lets registration be a read-only operation on the keystore (one biometric
 * prompt instead of two). See `keystore.createIdentity`.
 */
export function generateSecrets(): { nullifier: string; secret: string } {
  return {
    nullifier: randomFieldElement().toString(),
    secret: randomFieldElement().toString(),
  };
}

/** Generate a fresh voter commitment. */
export function generateCommitment(): VoterCommitment {
  const { nullifier, secret } = generateSecrets();
  return { nullifier, secret, ...deriveFromSecrets(nullifier, secret) };
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
