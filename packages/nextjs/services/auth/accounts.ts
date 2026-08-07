import { AuthCryptoError, decryptSecret, encryptSecret, hashPassword, parseEncryptionKey } from "./crypto";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The GN officer account store (`01-AUTH-DESIGN.md` §2).
 *
 * A JSON file rather than a database because the deployment is a single
 * Next.js server with a handful of officer accounts, and because a plain file
 * is auditable by eye — the acceptance gate literally greps it for leaked key
 * material. Everything that could compromise that guarantee is contained here:
 * private keys are AES-256-GCM sealed before they ever reach the encoder, and
 * `toPublicAccount()` is the only shape handed to route responses.
 *
 * Server-only (`node:fs`). Never import from a client component or middleware.
 */

/** On-disk record. `encryptedPrivateKey` is an envelope from `crypto.ts`, never raw hex. */
export interface GnAccountRecord {
  id: string;
  /** Lowercase, unique. The login name and the AAD binding the encrypted key to this record. */
  username: string;
  passwordHash: string;
  /** Index into `ElectionRegistry.getAllDivisions()`. */
  divisionId: number;
  /**
   * Address derived from the sealed key — the value the admin passes to
   * `setGNOfficer`. Typed `string` because this project registers abitype's
   * `AddressType` as `string` (`types/abitype/abi.d.ts`), so the format is
   * validated at write time instead of by the type system.
   */
  address: string;
  encryptedPrivateKey: string;
  createdAt: string;
  disabled: boolean;
}

/** The safe projection: everything the UI needs, nothing that can sign. */
export interface PublicGnAccount {
  id: string;
  username: string;
  divisionId: number;
  address: string;
  createdAt: string;
  disabled: boolean;
}

interface StoreFile {
  version: 1;
  accounts: GnAccountRecord[];
}

const EMPTY_STORE: StoreFile = { version: 1, accounts: [] };

export class AccountStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountStoreError";
  }
}

export const toPublicAccount = (account: GnAccountRecord): PublicGnAccount => ({
  id: account.id,
  username: account.username,
  divisionId: account.divisionId,
  address: account.address,
  createdAt: account.createdAt,
  disabled: account.disabled,
});

/** Usernames are case-insensitive and restricted so they cannot collide with path or JSON tricks. */
export const normaliseUsername = (raw: string): string => raw.trim().toLowerCase();

export const isValidUsername = (raw: string): boolean => /^[a-z0-9][a-z0-9._-]{2,31}$/.test(normaliseUsername(raw));

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export interface CreateAccountInput {
  username: string;
  password: string;
  divisionId: number;
  address: string;
  /** Raw `0x`-prefixed private key. Encrypted here; never stored or logged as given. */
  privateKey: `0x${string}`;
}

/**
 * A file-backed account store.
 *
 * Constructed with an explicit path and key so tests can point it at a temp
 * directory — the module-level singleton below is just this class wired to the
 * real environment.
 */
export class GnAccountStore {
  private readonly filePath: string;
  private readonly encryptionKey: Buffer;
  /**
   * Serialises every mutation.
   *
   * Reads and writes are a read-modify-write cycle; two concurrent
   * `createAccount` calls interleaving would silently drop one of the two
   * accounts. Next.js route handlers do run concurrently, so this is not
   * theoretical. Chaining onto a single promise costs nothing at this scale.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string, encryptionKey: Buffer) {
    this.filePath = filePath;
    this.encryptionKey = encryptionKey;
  }

  /** Reads the store, treating "file absent" as "no accounts yet". */
  private async read(): Promise<StoreFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_STORE, accounts: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Refusing to start from scratch is deliberate: silently replacing a
      // corrupt store would delete every officer account on the next write.
      throw new AccountStoreError(`GN account store at ${this.filePath} is not valid JSON — refusing to overwrite it.`);
    }
    const file = parsed as Partial<StoreFile>;
    if (file?.version !== 1 || !Array.isArray(file.accounts)) {
      throw new AccountStoreError(`GN account store at ${this.filePath} has an unrecognised layout.`);
    }
    return { version: 1, accounts: file.accounts };
  }

  /**
   * Writes the store atomically.
   *
   * Write-to-temp-then-rename means a crash mid-write leaves the previous file
   * intact rather than a truncated one; `rename` is atomic within a filesystem.
   * Mode 0600 keeps the sealed keys off other local accounts.
   */
  private async write(file: StoreFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, this.filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  /** Runs `fn` with exclusive access to the store. */
  private mutate<T>(fn: (file: StoreFile) => Promise<T> | T): Promise<T> {
    const next = this.queue.then(async () => {
      const file = await this.read();
      return fn(file);
    });
    // Keep the chain alive after a rejection, otherwise one failed write wedges
    // every later call behind a permanently rejected promise.
    this.queue = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<PublicGnAccount[]> {
    const { accounts } = await this.read();
    return accounts.map(toPublicAccount);
  }

  /** Full record including the sealed key — for the login and relay paths only. */
  async findByUsername(username: string): Promise<GnAccountRecord | undefined> {
    const target = normaliseUsername(username);
    const { accounts } = await this.read();
    return accounts.find(account => account.username === target);
  }

  async create(input: CreateAccountInput): Promise<PublicGnAccount> {
    const username = normaliseUsername(input.username);
    if (!isValidUsername(username)) {
      throw new AccountStoreError(
        "Username must be 3–32 characters: letters, digits, dot, underscore or hyphen, starting alphanumeric.",
      );
    }
    if (!Number.isInteger(input.divisionId) || input.divisionId < 0) {
      throw new AccountStoreError("divisionId must be a non-negative integer.");
    }
    if (!ADDRESS_PATTERN.test(input.address)) {
      throw new AccountStoreError("address must be a 20-byte hex address.");
    }
    if (!PRIVATE_KEY_PATTERN.test(input.privateKey)) {
      // Caught before encryption, so a malformed key can never be sealed into
      // the store and then fail confusingly at signing time instead.
      throw new AccountStoreError("privateKey must be a 32-byte hex value.");
    }
    const passwordHash = await hashPassword(input.password);
    const encryptedPrivateKey = encryptSecret(input.privateKey, this.encryptionKey, username);

    return this.mutate(async file => {
      if (file.accounts.some(account => account.username === username)) {
        throw new AccountStoreError(`A GN account named "${username}" already exists.`);
      }
      const record: GnAccountRecord = {
        id: randomBytes(16).toString("hex"),
        username,
        passwordHash,
        divisionId: input.divisionId,
        address: input.address,
        encryptedPrivateKey,
        createdAt: new Date().toISOString(),
        disabled: false,
      };
      await this.write({ ...file, accounts: [...file.accounts, record] });
      return toPublicAccount(record);
    });
  }

  async setDisabled(username: string, disabled: boolean): Promise<PublicGnAccount> {
    const target = normaliseUsername(username);
    return this.mutate(async file => {
      const record = file.accounts.find(account => account.username === target);
      if (!record) throw new AccountStoreError(`No GN account named "${target}".`);
      const updated = { ...record, disabled };
      await this.write({
        ...file,
        accounts: file.accounts.map(account => (account.username === target ? updated : account)),
      });
      return toPublicAccount(updated);
    });
  }

  async remove(username: string): Promise<void> {
    const target = normaliseUsername(username);
    await this.mutate(async file => {
      const remaining = file.accounts.filter(account => account.username !== target);
      if (remaining.length === file.accounts.length) throw new AccountStoreError(`No GN account named "${target}".`);
      await this.write({ ...file, accounts: remaining });
    });
  }

  /**
   * Deletes every account, returning how many were removed.
   *
   * Only the "start a new election" path uses this. Each account carries a
   * `divisionId` that is an index into `ElectionRegistry.getAllDivisions()`, so
   * once that list is cleared every stored account points at a division that no
   * longer exists — keeping them would leave officers able to sign in and land
   * on a portal bound to nothing.
   */
  async clear(): Promise<number> {
    return this.mutate(async file => {
      const removed = file.accounts.length;
      if (removed > 0) await this.write({ ...file, accounts: [] });
      return removed;
    });
  }

  /**
   * Unseals a GN's signing key.
   *
   * The AAD is the username, so a record whose `encryptedPrivateKey` was copied
   * from another account fails here instead of signing with the wrong identity.
   */
  decryptPrivateKey(account: GnAccountRecord): `0x${string}` {
    const key = decryptSecret(account.encryptedPrivateKey, this.encryptionKey, account.username);
    if (!PRIVATE_KEY_PATTERN.test(key)) {
      throw new AuthCryptoError(`Stored key for "${account.username}" is not a well-formed private key.`);
    }
    return key as `0x${string}`;
  }
}

/** Default location — gitignored, alongside the relay audit log. See `.env.example`. */
export const defaultAccountsPath = (): string =>
  process.env.GN_ACCOUNTS_FILE?.trim() || path.join(process.cwd(), "data", "gn-accounts.json");

let singleton: GnAccountStore | null = null;

/**
 * The process-wide store.
 *
 * Built lazily so that importing this module in hardhat mode — where
 * `GN_KEY_ENCRYPTION_KEY` is legitimately unset — does not throw at import
 * time and break the build.
 */
export const getAccountStore = (): GnAccountStore => {
  singleton ??= new GnAccountStore(defaultAccountsPath(), parseEncryptionKey(process.env.GN_KEY_ENCRYPTION_KEY));
  return singleton;
};
