import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * The relay audit log (`01-AUTH-DESIGN.md` §4, step 5).
 *
 * One JSON object per line, append-only. JSONL rather than a single JSON array
 * so that appending is a single `write` with no read-modify-write — the log
 * stays correct under concurrent requests and survives a crash mid-append with
 * at worst one truncated final line.
 *
 * This is the record that answers "who made the chain do that?" once individual
 * wallets are gone: the chain sees only the relay's key, so the mapping from a
 * transaction back to a logged-in human exists here and nowhere else.
 */

export interface RelayAuditEntry {
  ts: string;
  role: string;
  username: string;
  target: string;
  fn: string;
  /** Stringified so `bigint` arguments survive JSON serialisation. */
  args: string[];
  txHash?: string;
  blockNumber?: string;
  /** `success`, `reverted`, or `rejected: <reason>`. */
  status: string;
}

export const defaultAuditLogPath = (): string =>
  process.env.RELAY_AUDIT_LOG?.trim() || path.join(process.cwd(), "data", "relay-audit.log");

/**
 * Renders arguments for the log: bigints as decimal strings, objects as JSON.
 *
 * `JSON.stringify` throws on a `bigint` anywhere in the structure, and relay
 * arguments routinely contain them once coerced (`startVoting(3600n)`) or
 * nested in arrays. Since this runs while building the audit record — before
 * the write is attempted — an uncaught throw here would take down the whole
 * relay call rather than just the logging, so every value is normalised first.
 */
export const serialiseArgs = (args: readonly unknown[]): string[] =>
  args.map(arg => {
    if (typeof arg === "bigint") return arg.toString();
    if (typeof arg !== "object" || arg === null) return String(arg);
    try {
      return JSON.stringify(arg, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    } catch {
      // Circular structures and anything else unserialisable: the audit line
      // still records that the argument was present.
      return "[unserialisable]";
    }
  });

/**
 * Appends one audit record.
 *
 * Failures are swallowed after being reported to the server console. A relay
 * call that already landed on-chain must not be reported to the operator as
 * failed because the log file was unwritable — the transaction is real either
 * way, and pretending otherwise invites a duplicate submission.
 */
export const appendAuditEntry = async (entry: RelayAuditEntry, filePath = defaultAuditLogPath()): Promise<void> => {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error("[relay] failed to write audit log entry", error);
  }
};
