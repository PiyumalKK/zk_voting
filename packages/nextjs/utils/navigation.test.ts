import { safeNextPath } from "./navigation";
import { describe, expect, it } from "vitest";

const FALLBACK = "/voting/admin";

describe("safeNextPath", () => {
  it("keeps a same-origin path, including its query string", () => {
    expect(safeNextPath("/gn/register?division=1", FALLBACK)).toBe("/gn/register?division=1");
  });

  it("falls back when the parameter is absent or blank", () => {
    expect(safeNextPath(null, FALLBACK)).toBe(FALLBACK);
    expect(safeNextPath(undefined, FALLBACK)).toBe(FALLBACK);
    expect(safeNextPath("   ", FALLBACK)).toBe(FALLBACK);
  });

  it("refuses an absolute URL — an operator must not be redirected off-site after typing a password", () => {
    expect(safeNextPath("https://evil.example/harvest", FALLBACK)).toBe(FALLBACK);
    expect(safeNextPath("http://evil.example", FALLBACK)).toBe(FALLBACK);
  });

  it("refuses a protocol-relative URL, which browsers resolve to another host", () => {
    expect(safeNextPath("//evil.example/harvest", FALLBACK)).toBe(FALLBACK);
  });

  it("refuses backslash variants that some browsers normalise to //", () => {
    expect(safeNextPath("/\\evil.example", FALLBACK)).toBe(FALLBACK);
    expect(safeNextPath("\\\\evil.example", FALLBACK)).toBe(FALLBACK);
  });

  it("refuses non-http schemes", () => {
    expect(safeNextPath("javascript:alert(1)", FALLBACK)).toBe(FALLBACK);
    expect(safeNextPath("data:text/html,<script>", FALLBACK)).toBe(FALLBACK);
  });

  it("refuses a relative path with no leading slash", () => {
    expect(safeNextPath("gn/register", FALLBACK)).toBe(FALLBACK);
  });

  it("refuses embedded control characters", () => {
    expect(safeNextPath("/gn\r\nSet-Cookie: x=1", FALLBACK)).toBe(FALLBACK);
    expect(safeNextPath(`/gn${String.fromCharCode(0)}`, FALLBACK)).toBe(FALLBACK);
    expect(safeNextPath(`/gn${String.fromCharCode(0x7f)}`, FALLBACK)).toBe(FALLBACK);
  });
});
