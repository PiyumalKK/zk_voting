import { compare, hash } from "bcryptjs";
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Cryptographic primitives for no-wallet auth (custom-chain mode, M12).
 *
 * Two independent jobs live here, both server-only:
 *
 * 1. **Password hashing** (bcrypt) — admin and GN credentials.
 * 2. **Secret encryption** (AES-256-GCM) — GN private keys at rest in
 *    `data/gn-accounts.json`. `01-AUTH-DESIGN.md` §2 requires that file to
 *    contain no plaintext key material; this module is the only thing that
 *    encrypts or decrypts it.
 *
 * This file imports `node:crypto` and therefore must never be pulled into the
 * Edge middleware bundle — keep it out of `services/auth/session.ts`, which is
 * the one auth module the middleware is allowed to import.
 */

/**
 * bcrypt work factor.
 *
 * 12 is the current OWASP floor; at ~250 ms/hash on commodity hardware it is
 * comfortably affordable for a system with a handful of operator logins, and
 * the deliberate cost is what makes the 5-attempt lockout meaningful rather
 * than decorative.
 */
export const BCRYPT_COST = 12;

/** Prefix identifying the ciphertext envelope layout, so the format can evolve. */
const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12; // 96-bit nonce — the size GCM is specified and fastest for.
const KEY_BYTES = 32; // AES-256.

let decoyHash: Promise<string> | null = null;

export class AuthCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthCryptoError";
  }
}

/** Hashes a plaintext password for storage. */
export const hashPassword = (password: string): Promise<string> => hash(password, BCRYPT_COST);

/**
 * Verifies a password against a stored hash.
 *
 * Returns `false` rather than throwing on a malformed hash: a corrupted record
 * must fail the login, not crash the route and leak a stack trace.
 */
export const verifyPassword = async (password: string, passwordHash: string): Promise<boolean> => {
  try {
    return await compare(password, passwordHash);
  } catch {
    return false;
  }
};

/**
 * Burns one bcrypt verification against a throwaway hash.
 *
 * Login handlers call this when the supplied username does not exist, so a
 * missing account costs the same wall-clock time as a wrong password —
 * otherwise response latency alone enumerates valid usernames. The decoy hash
 * is computed once per process and reused; the cost that matters is the
 * `compare`, which is what a real login would also pay.
 */
export const burnPasswordComparison = async (): Promise<void> => {
  decoyHash ??= hash(randomBytes(16).toString("hex"), BCRYPT_COST);
  await verifyPassword("not-the-password", await decoyHash);
};

/**
 * Constant-time string comparison, used for the admin username.
 *
 * Length differences are unavoidably observable (the buffers must match in
 * size for `timingSafeEqual`), but the byte comparison itself does not
 * short-circuit on the first mismatch.
 */
export const safeEquals = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

/**
 * Parses `GN_KEY_ENCRYPTION_KEY` into a 32-byte key.
 *
 * Accepts 64 hex characters or 44-character base64 — both are natural outputs
 * of `openssl rand`. Anything else throws at the point of use with an
 * actionable message, rather than silently deriving a weak key from a short
 * passphrase (the failure mode that turns "encrypted at rest" into theatre).
 */
export const parseEncryptionKey = (raw: string | undefined): Buffer => {
  const value = raw?.trim();
  if (!value) {
    throw new AuthCryptoError("GN_KEY_ENCRYPTION_KEY is not set — GN accounts cannot be read or written without it.");
  }
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value.replace(/^0x/, ""), "hex");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === KEY_BYTES) return decoded;
  throw new AuthCryptoError(
    `GN_KEY_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64); got ${decoded.length} bytes after decoding.`,
  );
};

/**
 * Encrypts a secret with AES-256-GCM.
 *
 * `aad` (additional authenticated data) is not encrypted but is covered by the
 * auth tag. Callers pass the owning account's username, which binds each
 * ciphertext to its record: moving an encrypted key onto another account in
 * the JSON file makes decryption fail instead of silently handing that account
 * someone else's signing key.
 *
 * Envelope: `v1:<iv-hex>:<tag-hex>:<ciphertext-hex>`.
 */
export const encryptSecret = (plaintext: string, key: Buffer, aad: string): string => {
  if (key.length !== KEY_BYTES) throw new AuthCryptoError("Encryption key must be exactly 32 bytes.");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_VERSION, iv.toString("hex"), tag.toString("hex"), ciphertext.toString("hex")].join(":");
};

/**
 * Decrypts an envelope produced by {@link encryptSecret}.
 *
 * Throws on a wrong key, a tampered ciphertext, a swapped `aad`, or a
 * malformed envelope — GCM's auth tag makes all four indistinguishable to the
 * caller, which is the point.
 */
export const decryptSecret = (envelope: string, key: Buffer, aad: string): string => {
  if (key.length !== KEY_BYTES) throw new AuthCryptoError("Encryption key must be exactly 32 bytes.");
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new AuthCryptoError("Unrecognised encrypted-secret envelope.");
  }
  const [, ivHex, tagHex, ciphertextHex] = parts;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]).toString("utf8");
  } catch {
    throw new AuthCryptoError("Failed to decrypt secret — wrong key or the stored value has been tampered with.");
  }
};

/**
 * Generates a one-time password shown to the admin when a GN account is created.
 *
 * Alphabet excludes characters that are ambiguous when read off a screen and
 * typed by hand (`0/O`, `1/l/I`) — these get dictated across a desk during
 * officer onboarding. 20 characters from a 58-symbol alphabet is ~117 bits.
 */
export const generatePassword = (length = 20): string => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
};
