import { authoriseNicHashSession } from "./nicHashAuth";
import { describe, expect, it } from "vitest";

// `as const` matters: `DivisionSummary.gnOfficers` is typed `0x${string}`[], and a
// plain `string` constant is not assignable to it.
const GN_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const OTHER_ADDRESS = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

const gnSession = { role: "gn" as const, username: "gn.kaduwela", divisionId: 0 };
const account = { address: GN_ADDRESS, divisionId: 0, disabled: false };
const divisions = [
  { id: 0, gnOfficers: [GN_ADDRESS] },
  { id: 1, gnOfficers: [OTHER_ADDRESS] },
];

describe("authoriseNicHashSession", () => {
  it("admits the officer the chain currently recognises", () => {
    const result = authoriseNicHashSession({ session: gnSession, account, divisions });

    expect(result).toEqual({ ok: true, gnAddress: GN_ADDRESS, divisionId: 0 });
  });

  it("matches the on-chain officer case-insensitively", () => {
    const result = authoriseNicHashSession({
      session: gnSession,
      account,
      divisions: [{ id: 0, gnOfficers: [GN_ADDRESS.toLowerCase() as `0x${string}`] }],
    });

    expect(result.ok).toBe(true);
  });

  it("refuses an admin session — enrolment must be attributable to a GN", () => {
    const result = authoriseNicHashSession({
      session: { role: "admin", username: "returning-officer" },
      account,
      divisions,
    });

    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a session whose account has been deleted", () => {
    const result = authoriseNicHashSession({ session: gnSession, account: undefined, divisions });

    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses a suspended account immediately, without waiting for the cookie to expire", () => {
    const result = authoriseNicHashSession({
      session: gnSession,
      account: { ...account, disabled: true },
      divisions,
    });

    expect(result).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("suspended") });
  });

  it("trusts the stored division over the one baked into an 8-hour-old cookie", () => {
    // The cookie still says division 0; the admin has since moved this officer
    // to division 1, where they are the recognised GN.
    const result = authoriseNicHashSession({
      session: { ...gnSession, divisionId: 0 },
      account: { address: OTHER_ADDRESS, divisionId: 1, disabled: false },
      divisions,
    });

    expect(result).toEqual({ ok: true, gnAddress: OTHER_ADDRESS, divisionId: 1 });
  });

  it("refuses an officer whose division no longer exists on this chain", () => {
    const result = authoriseNicHashSession({
      session: gnSession,
      account: { ...account, divisionId: 7 },
      divisions,
    });

    expect(result).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("Division 7") });
  });

  it("refuses an officer the chain has replaced, even though their login still works", () => {
    const result = authoriseNicHashSession({
      session: gnSession,
      account,
      divisions: [{ id: 0, gnOfficers: [OTHER_ADDRESS] }],
    });

    expect(result).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("no longer") });
  });

  it("refuses a division with no officer assigned at all", () => {
    const result = authoriseNicHashSession({
      session: gnSession,
      account,
      divisions: [{ id: 0, gnOfficers: [] }],
    });

    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("admits an officer who is one of several assigned to the same division", () => {
    const result = authoriseNicHashSession({
      session: gnSession,
      account,
      divisions: [{ id: 0, gnOfficers: [OTHER_ADDRESS, GN_ADDRESS] }],
    });

    expect(result).toEqual({ ok: true, gnAddress: GN_ADDRESS, divisionId: 0 });
  });
});
