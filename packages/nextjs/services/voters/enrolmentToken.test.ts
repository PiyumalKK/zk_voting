import { signEnrolmentToken, verifyEnrolmentToken } from "./enrolmentToken";
import { describe, expect, it, vi } from "vitest";

describe("enrolment claim tokens", () => {
  it("round-trips the nicHash and divisionId", () => {
    const token = signEnrolmentToken("0xabc123", 2);
    expect(verifyEnrolmentToken(token)).toEqual({ nicHash: "0xabc123", divisionId: 2 });
  });

  it("rejects a tampered payload", () => {
    const token = signEnrolmentToken("0xabc123", 2);
    const [payload, sig] = token.split(".");
    const tampered = `${payload}x.${sig}`;
    expect(verifyEnrolmentToken(tampered)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signEnrolmentToken("0xabc123", 2);
    const [payload] = token.split(".");
    expect(verifyEnrolmentToken(`${payload}.notarealsignature`)).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifyEnrolmentToken("not-a-token")).toBeNull();
    expect(verifyEnrolmentToken("")).toBeNull();
  });

  it("rejects an expired token", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = signEnrolmentToken("0xabc123", 2, 1000);
    vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
    expect(verifyEnrolmentToken(token)).toBeNull();
    vi.useRealTimers();
  });
});
