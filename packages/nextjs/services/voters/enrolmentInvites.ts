import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The voter enrolment-invite store — bulk-imported eligibility rows waiting
 * to be claimed by a citizen's own device (see `app/api/self-enrol/route.ts`).
 *
 * Same shape as `services/auth/accounts.ts`'s `GnAccountStore` deliberately:
 * a JSON file, atomic write-temp-then-rename, one mutation queue serialising
 * every write. The scale and the auditability requirement are the same —
 * a handful of divisions' worth of pending invites, not a production-grade
 * voter database.
 *
 * Only the NIC's peppered hash is ever stored here, never the plaintext NIC —
 * the same guarantee `NicRegistry` and the GN enrolment flow already hold.
 */

export interface EnrolmentInviteRecord {
  /** Peppered NIC hash (`services/nic/nicHash.ts`) — also this record's key. */
  nicHash: string;
  phone: string;
  divisionId: number;
  status: "pending" | "claimed";
  createdAt: string;
  claimedAt?: string;
}

interface StoreFile {
  version: 1;
  invites: EnrolmentInviteRecord[];
}

const EMPTY_STORE: StoreFile = { version: 1, invites: [] };

export class EnrolmentInviteStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrolmentInviteStoreError";
  }
}

export class EnrolmentInviteStore {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async read(): Promise<StoreFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_STORE, invites: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new EnrolmentInviteStoreError(
        `Enrolment invite store at ${this.filePath} is not valid JSON — refusing to overwrite it.`,
      );
    }
    const file = parsed as Partial<StoreFile>;
    if (file?.version !== 1 || !Array.isArray(file.invites)) {
      throw new EnrolmentInviteStoreError(`Enrolment invite store at ${this.filePath} has an unrecognised layout.`);
    }
    return { version: 1, invites: file.invites };
  }

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

  private mutate<T>(fn: (file: StoreFile) => Promise<T> | T): Promise<T> {
    const next = this.queue.then(async () => {
      const file = await this.read();
      return fn(file);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<EnrolmentInviteRecord[]> {
    return (await this.read()).invites;
  }

  async findByNicHash(nicHash: string): Promise<EnrolmentInviteRecord | undefined> {
    return (await this.read()).invites.find(invite => invite.nicHash === nicHash);
  }

  /** Creates or replaces the pending invite for a NIC — re-importing the same NIC just refreshes it. */
  async upsertPending(input: { nicHash: string; phone: string; divisionId: number }): Promise<EnrolmentInviteRecord> {
    return this.mutate(async file => {
      const existing = file.invites.find(invite => invite.nicHash === input.nicHash);
      if (existing?.status === "claimed") {
        throw new EnrolmentInviteStoreError("This NIC has already claimed its enrolment invite.");
      }
      const record: EnrolmentInviteRecord = {
        nicHash: input.nicHash,
        phone: input.phone,
        divisionId: input.divisionId,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      const invites = existing
        ? file.invites.map(invite => (invite.nicHash === input.nicHash ? record : invite))
        : [...file.invites, record];
      await this.write({ ...file, invites });
      return record;
    });
  }

  /**
   * Marks a pending invite claimed — the one-time-use gate for `/api/self-enrol`.
   *
   * Runs the "still pending?" check and the write inside the same mutation, so
   * two near-simultaneous claims of the same invite (a forwarded link opened
   * twice) can't both read "pending" before either writes "claimed".
   */
  async claim(nicHash: string): Promise<EnrolmentInviteRecord> {
    return this.mutate(async file => {
      const invite = file.invites.find(candidate => candidate.nicHash === nicHash);
      if (!invite) throw new EnrolmentInviteStoreError("No enrolment invite for this NIC.");
      if (invite.status === "claimed") throw new EnrolmentInviteStoreError("This invite has already been claimed.");
      const updated: EnrolmentInviteRecord = { ...invite, status: "claimed", claimedAt: new Date().toISOString() };
      await this.write({
        ...file,
        invites: file.invites.map(candidate => (candidate.nicHash === nicHash ? updated : candidate)),
      });
      return updated;
    });
  }

  async clear(): Promise<number> {
    return this.mutate(async file => {
      const removed = file.invites.length;
      if (removed > 0) await this.write({ ...file, invites: [] });
      return removed;
    });
  }
}

export const defaultEnrolmentInvitesPath = (): string =>
  process.env.ENROLMENT_INVITES_FILE?.trim() || path.join(process.cwd(), "data", "enrolment-invites.json");

let singleton: EnrolmentInviteStore | null = null;

export const getEnrolmentInviteStore = (): EnrolmentInviteStore => {
  singleton ??= new EnrolmentInviteStore(defaultEnrolmentInvitesPath());
  return singleton;
};
