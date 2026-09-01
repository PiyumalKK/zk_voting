import { CsvRowSource, RowSourceError, buildRowSource } from "./rowSource";
import { describe, expect, it, vi } from "vitest";

describe("CsvRowSource", () => {
  it("parses a header row and lower-cases its keys", async () => {
    const rows = await new CsvRowSource("Username,Division\nalice,Kaduwela\nbob,Gampaha").fetchRows();
    expect(rows).toEqual([
      { username: "alice", division: "Kaduwela" },
      { username: "bob", division: "Gampaha" },
    ]);
  });

  it("handles quoted fields containing commas", async () => {
    const rows = await new CsvRowSource('nic,division\n200012345678,"Colombo, Central"').fetchRows();
    expect(rows).toEqual([{ nic: "200012345678", division: "Colombo, Central" }]);
  });

  it("unescapes doubled quotes inside a quoted field", async () => {
    const rows = await new CsvRowSource('name\n"Say ""hi"""').fetchRows();
    expect(rows).toEqual([{ name: 'Say "hi"' }]);
  });

  it("skips blank lines", async () => {
    const rows = await new CsvRowSource("a,b\n1,2\n\n3,4\n").fetchRows();
    expect(rows).toHaveLength(2);
  });

  it("returns an empty array for a header-only CSV", async () => {
    const rows = await new CsvRowSource("username,division").fetchRows();
    expect(rows).toEqual([]);
  });

  it("returns no rows for an empty string", async () => {
    const rows = await new CsvRowSource("").fetchRows();
    expect(rows).toEqual([]);
  });
});

describe("buildRowSource", () => {
  it("rejects an empty CSV body", () => {
    expect(() => buildRowSource({ source: "csv", csv: "" })).toThrow(RowSourceError);
  });

  it("rejects an empty API url", () => {
    expect(() => buildRowSource({ source: "api", url: "" })).toThrow(RowSourceError);
  });

  it("rejects an unknown source", () => {
    // @ts-expect-error - deliberately malformed input
    expect(() => buildRowSource({ source: "ftp" })).toThrow(RowSourceError);
  });

  it("builds a RemoteApiRowSource that sends a bearer token when an apiKey is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ NIC: "912345678V", Phone: "0771234567" }],
    });
    vi.stubGlobal("fetch", fetchMock);

    const source = buildRowSource({ source: "api", url: "https://example.com/rows", apiKey: "secret" });
    const rows = await source.fetchRows();

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/rows", {
      headers: { Authorization: "Bearer secret" },
      method: "GET",
    });
    expect(rows).toEqual([{ nic: "912345678V", phone: "0771234567" }]);

    vi.unstubAllGlobals();
  });

  it("rejects a non-array JSON response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ not: "an array" }) }));
    const source = buildRowSource({ source: "api", url: "https://example.com/rows" });
    await expect(source.fetchRows()).rejects.toThrow(RowSourceError);
    vi.unstubAllGlobals();
  });

  it("wraps a non-ok HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    const source = buildRowSource({ source: "api", url: "https://example.com/rows" });
    await expect(source.fetchRows()).rejects.toThrow(RowSourceError);
    vi.unstubAllGlobals();
  });
});
