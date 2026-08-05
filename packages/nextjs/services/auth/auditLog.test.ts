import { appendAuditEntry, serialiseArgs } from "./auditLog";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const newLogPath = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relay-audit-"));
  return path.join(dir, "nested", "relay-audit.log");
};

const entry = (overrides: Record<string, unknown> = {}) => ({
  ts: "2026-08-02T00:00:00.000Z",
  role: "gn",
  username: "gn-colombo",
  target: "0x3333333333333333333333333333333333333333",
  fn: "addVoters",
  args: ["0x5555555555555555555555555555555555555555"],
  status: "success",
  ...overrides,
});

describe("serialiseArgs", () => {
  it("renders bigints as decimal strings", () => {
    // Relay arguments are bigints once coerced (`startVoting(3600n)`), and
    // `String(bigint)` is the only safe rendering — JSON.stringify throws.
    expect(serialiseArgs([3600n])).toEqual(["3600"]);
  });

  it("renders bigints nested inside arrays and objects", () => {
    expect(serialiseArgs([[1n, 2n]])).toEqual(['["1","2"]']);
    expect(serialiseArgs([{ duration: 3600n }])).toEqual(['{"duration":"3600"}']);
  });

  it("renders ordinary values", () => {
    expect(serialiseArgs(["Kandy", true, 42, null, undefined])).toEqual(["Kandy", "true", "42", "null", "undefined"]);
  });

  it("does not throw on a circular structure", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(serialiseArgs([circular])).toEqual(["[unserialisable]"]);
  });
});

describe("appendAuditEntry", () => {
  it("writes one JSON object per line, creating the directory", async () => {
    const filePath = await newLogPath();
    await appendAuditEntry(entry(), filePath);
    await appendAuditEntry(entry({ fn: "reserveNicHash", status: "rejected: not your division" }), filePath);

    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).fn).toBe("addVoters");
    expect(JSON.parse(lines[1]).status).toBe("rejected: not your division");
  });

  it("never throws when the log cannot be written", async () => {
    // A relay call that already landed on-chain must not be reported as failed
    // because the log file was unwritable — the transaction is real either way.
    const unwritable = path.join(await newLogPath(), "file.log", "deeper.log");
    await expect(appendAuditEntry(entry(), unwritable)).resolves.toBeUndefined();
  });
});
