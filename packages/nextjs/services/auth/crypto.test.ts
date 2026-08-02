import {
  AuthCryptoError,
  decryptSecret,
  encryptSecret,
  generatePassword,
  hashPassword,
  parseEncryptionKey,
  safeEquals,
  verifyPassword,
} from "./crypto";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

const KEY = randomBytes(32);
const PRIVATE_KEY = `0x${"ab".repeat(32)}`;

describe("parseEncryptionKey", () => {
  it("accepts 64 hex characters, with or without 0x", () => {
    const hex = KEY.toString("hex");
    expect(parseEncryptionKey(hex).equals(KEY)).toBe(true);
    expect(parseEncryptionKey(`0x${hex}`).equals(KEY)).toBe(true);
  });

  it("accepts base64", () => {
    expect(parseEncryptionKey(KEY.toString("base64")).equals(KEY)).toBe(true);
  });

  it("rejects a missing key rather than defaulting to one", () => {
    expect(() => parseEncryptionKey(undefined)).toThrow(AuthCryptoError);
    expect(() => parseEncryptionKey("   ")).toThrow(AuthCryptoError);
  });

  it("rejects a short passphrase instead of stretching it", () => {
    // The dangerous failure mode: silently deriving a weak key would make
    // "encrypted at rest" meaningless while still appearing to work.
    expect(() => parseEncryptionKey("hunter2")).toThrow(/32 bytes/);
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a private key", () => {
    const sealed = encryptSecret(PRIVATE_KEY, KEY, "gn-colombo");
    expect(decryptSecret(sealed, KEY, "gn-colombo")).toBe(PRIVATE_KEY);
  });

  it("never leaves the plaintext in the envelope", () => {
    const sealed = encryptSecret(PRIVATE_KEY, KEY, "gn-colombo");
    expect(sealed).not.toContain(PRIVATE_KEY.slice(2));
    expect(sealed.startsWith("v1:")).toBe(true);
  });

  it("produces a different ciphertext each time (fresh IV)", () => {
    const first = encryptSecret(PRIVATE_KEY, KEY, "gn-colombo");
    const second = encryptSecret(PRIVATE_KEY, KEY, "gn-colombo");
    expect(first).not.toBe(second);
    expect(decryptSecret(second, KEY, "gn-colombo")).toBe(PRIVATE_KEY);
  });

  it("fails with the wrong key", () => {
    const sealed = encryptSecret(PRIVATE_KEY, KEY, "gn-colombo");
    expect(() => decryptSecret(sealed, randomBytes(32), "gn-colombo")).toThrow(AuthCryptoError);
  });

  it("fails when the envelope is bound to a different account", () => {
    // This is what stops an encrypted key being copied onto another record in
    // gn-accounts.json to hijack that officer's signing identity.
    const sealed = encryptSecret(PRIVATE_KEY, KEY, "gn-colombo");
    expect(() => decryptSecret(sealed, KEY, "gn-kandy")).toThrow(AuthCryptoError);
  });

  it("detects a tampered ciphertext", () => {
    const sealed = encryptSecret(PRIVATE_KEY, KEY, "gn-colombo");
    const parts = sealed.split(":");
    const flipped = parts[3].startsWith("a") ? `b${parts[3].slice(1)}` : `a${parts[3].slice(1)}`;
    expect(() => decryptSecret([parts[0], parts[1], parts[2], flipped].join(":"), KEY, "gn-colombo")).toThrow(
      AuthCryptoError,
    );
  });

  it("rejects a malformed envelope", () => {
    expect(() => decryptSecret("not-an-envelope", KEY, "gn-colombo")).toThrow(AuthCryptoError);
    expect(() => decryptSecret("v2:aa:bb:cc", KEY, "gn-colombo")).toThrow(AuthCryptoError);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => encryptSecret(PRIVATE_KEY, randomBytes(16), "gn")).toThrow(AuthCryptoError);
  });
});

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("Correct horse battery staple", hash)).toBe(false);
  });

  it("returns false rather than throwing on a corrupted hash", async () => {
    expect(await verifyPassword("anything", "not-a-bcrypt-hash")).toBe(false);
  });
});

describe("safeEquals", () => {
  it("compares equal strings as equal", () => {
    expect(safeEquals("admin", "admin")).toBe(true);
  });

  it("rejects differing strings and differing lengths", () => {
    expect(safeEquals("admin", "adm1n")).toBe(false);
    expect(safeEquals("admin", "administrator")).toBe(false);
    expect(safeEquals("", "admin")).toBe(false);
  });
});

describe("generatePassword", () => {
  it("avoids characters that are ambiguous when dictated aloud", () => {
    const password = generatePassword(200);
    expect(password).not.toMatch(/[0O1lI]/);
    expect(password).toHaveLength(200);
  });

  it("does not repeat itself", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});
