import { AccountStoreError, GnAccountStore, isValidUsername, normaliseUsername, toPublicAccount } from "./accounts";
import { verifyPassword } from "./crypto";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Tests for the GN account store.
 *
 * The acceptance gate greps `gn-accounts.json` for a 64-hex private key, so the
 * "no plaintext key on disk" case below is that gate expressed as code.
 */

const KEY = randomBytes(32);
const PRIVATE_KEY = `0x${"cd".repeat(32)}` as `0x${string}`;
const ADDRESS = "0x1234567890123456789012345678901234567890";

const newStore = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gn-accounts-"));
  const filePath = path.join(dir, "nested", "gn-accounts.json");
  return { store: new GnAccountStore(filePath, KEY), filePath };
};

const baseAccount = (overrides: Partial<Parameters<GnAccountStore["create"]>[0]> = {}) => ({
  username: "gn-colombo",
  password: "one-time-password",
  divisionId: 0,
  address: ADDRESS,
  privateKey: PRIVATE_KEY,
  ...overrides,
});

describe("username rules", () => {
  it("normalises case and surrounding whitespace", () => {
    expect(normaliseUsername("  GN-Colombo  ")).toBe("gn-colombo");
  });

  it("accepts reasonable names and rejects the rest", () => {
    expect(isValidUsername("gn-colombo")).toBe(true);
    expect(isValidUsername("gn.colombo_01")).toBe(true);
    expect(isValidUsername("ab")).toBe(false); // too short
    expect(isValidUsername("-leading-hyphen")).toBe(false);
    expect(isValidUsername("has space")).toBe(false);
    expect(isValidUsername("../../etc/passwd")).toBe(false);
    expect(isValidUsername("a".repeat(33))).toBe(false);
  });
});

describe("GnAccountStore", () => {
  it("reports an empty list before the file exists", async () => {
    const { store } = await newStore();
    expect(await store.list()).toEqual([]);
  });

  it("creates an account and finds it case-insensitively", async () => {
    const { store } = await newStore();
    const created = await store.create(baseAccount());

    expect(created.username).toBe("gn-colombo");
    expect(await store.findByUsername("GN-COLOMBO")).toBeDefined();
  });

  it("stores no plaintext private key on disk", async () => {
    const { store, filePath } = await newStore();
    await store.create(baseAccount());

    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain(PRIVATE_KEY);
    expect(raw).not.toContain(PRIVATE_KEY.slice(2));
    // The gate's grep: no bare 64-hex string anywhere in the file.
    expect(raw).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  it("stores the password only as a bcrypt hash", async () => {
    const { store, filePath } = await newStore();
    await store.create(baseAccount({ password: "sup3r-secret-value" }));

    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain("sup3r-secret-value");

    const account = await store.findByUsername("gn-colombo");
    expect(await verifyPassword("sup3r-secret-value", account!.passwordHash)).toBe(true);
  });

  it("round-trips the signing key through encryption", async () => {
    const { store } = await newStore();
    await store.create(baseAccount());

    const account = await store.findByUsername("gn-colombo");
    expect(store.decryptPrivateKey(account!)).toBe(PRIVATE_KEY);
  });

  it("refuses to decrypt a key moved onto another account", async () => {
    const { store } = await newStore();
    await store.create(baseAccount());
    await store.create(baseAccount({ username: "gn-kandy", divisionId: 1 }));

    const colombo = await store.findByUsername("gn-colombo");
    const kandy = await store.findByUsername("gn-kandy");
    // Splice Colombo's sealed key into Kandy's record, as an attacker with file
    // access would. The AAD binding makes it unusable.
    expect(() => store.decryptPrivateKey({ ...kandy!, encryptedPrivateKey: colombo!.encryptedPrivateKey })).toThrow();
  });

  it("rejects duplicate usernames", async () => {
    const { store } = await newStore();
    await store.create(baseAccount());
    await expect(store.create(baseAccount({ username: "GN-Colombo" }))).rejects.toThrow(AccountStoreError);
  });

  it("rejects invalid usernames and division ids", async () => {
    const { store } = await newStore();
    await expect(store.create(baseAccount({ username: "no" }))).rejects.toThrow(AccountStoreError);
    await expect(store.create(baseAccount({ divisionId: -1 }))).rejects.toThrow(AccountStoreError);
    await expect(store.create(baseAccount({ divisionId: 1.5 }))).rejects.toThrow(AccountStoreError);
  });

  it("rejects malformed addresses and private keys before sealing them", async () => {
    // `Address` is registered as plain `string` in this project
    // (`types/abitype/abi.d.ts`), so the format has to be checked at runtime.
    const { store } = await newStore();
    await expect(store.create(baseAccount({ address: "0xnope" }))).rejects.toThrow(/hex address/);
    await expect(store.create(baseAccount({ privateKey: "0x1234" as `0x${string}` }))).rejects.toThrow(/32-byte hex/);
  });

  it("serialises concurrent creates instead of losing one", async () => {
    // Two route handlers creating accounts at the same time is a plain
    // read-modify-write race; without the mutex one account silently vanishes.
    const { store } = await newStore();
    await Promise.all([
      store.create(baseAccount({ username: "gn-one", divisionId: 0 })),
      store.create(baseAccount({ username: "gn-two", divisionId: 1 })),
      store.create(baseAccount({ username: "gn-three", divisionId: 2 })),
    ]);

    expect((await store.list()).map(account => account.username).sort()).toEqual(["gn-one", "gn-three", "gn-two"]);
  });

  it("keeps working after a rejected mutation", async () => {
    const { store } = await newStore();
    await store.create(baseAccount());
    await expect(store.create(baseAccount())).rejects.toThrow();

    // A failed write must not wedge the queue behind a rejected promise.
    await store.create(baseAccount({ username: "gn-kandy", divisionId: 1 }));
    expect(await store.list()).toHaveLength(2);
  });

  it("disables and removes accounts", async () => {
    const { store } = await newStore();
    await store.create(baseAccount());

    expect((await store.setDisabled("gn-colombo", true)).disabled).toBe(true);
    await store.remove("gn-colombo");
    expect(await store.list()).toEqual([]);
  });

  it("reports a clear error when removing or disabling an unknown account", async () => {
    const { store } = await newStore();
    await expect(store.remove("nobody")).rejects.toThrow(AccountStoreError);
    await expect(store.setDisabled("nobody", true)).rejects.toThrow(AccountStoreError);
  });

  it("refuses to overwrite a corrupt store", async () => {
    const { store, filePath } = await newStore();
    await store.create(baseAccount());
    await writeFile(filePath, "{ this is not json", "utf8");

    // Starting fresh here would delete every officer account on the next write.
    await expect(store.list()).rejects.toThrow(AccountStoreError);
  });

  it("refuses a store file with an unrecognised layout", async () => {
    const { store, filePath } = await newStore();
    await store.create(baseAccount());
    await writeFile(filePath, JSON.stringify({ version: 99, accounts: [] }), "utf8");

    await expect(store.list()).rejects.toThrow(AccountStoreError);
  });

  it("leaves no temporary files behind", async () => {
    const { store, filePath } = await newStore();
    await store.create(baseAccount());

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(path.dirname(filePath));
    expect(entries.filter(name => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("toPublicAccount", () => {
  it("omits every field that could sign or authenticate", async () => {
    const { store } = await newStore();
    await store.create(baseAccount());
    const account = await store.findByUsername("gn-colombo");

    const shape = toPublicAccount(account!) as unknown as Record<string, unknown>;
    expect(Object.keys(shape).sort()).toEqual(["address", "createdAt", "disabled", "divisionId", "id", "username"]);
    expect(shape.passwordHash).toBeUndefined();
    expect(shape.encryptedPrivateKey).toBeUndefined();
  });
});

afterEach(() => {
  // Temp directories are per-test and left to the OS; nothing global to undo.
});
