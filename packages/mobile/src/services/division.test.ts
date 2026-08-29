import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DivisionState } from "./api";

/**
 * Which division a voter acts in is now derived from the on-chain allowlist
 * rather than picked by the voter, so `resolveVoterDivision` decides the target
 * of every register and vote transaction. That makes it wire-deciding logic in
 * the same sense as `chain.ts`, and worth pinning.
 *
 * The three properties that matter:
 *
 *  1. A voter on no allowlist resolves to null. The old picker defaulted to
 *     divisions[0], which sent the registration to a contract that would revert
 *     with "not allowed to vote" — a confusing failure a long way from its
 *     cause. Null is what lets the UI say "your GN officer hasn't added you".
 *  2. The cache can never override the chain. It only breaks ties.
 *  3. When *no* division could be read (offline, registry down) we fall back to
 *     the cached division instead of claiming the voter is not enrolled.
 */

const secureStore = vi.hoisted(() => ({ value: null as string | null }));
const apiMock = vi.hoisted(() => ({ getElection: vi.fn() }));

vi.mock("./api", async importOriginal => ({
  ...(await importOriginal<typeof import("./api")>()),
  api: apiMock,
}));

vi.mock("./keystore", () => ({
  getAddress: async () => "0x000000000000000000000000000000000000dEaD",
  getSelectedDivision: async () => secureStore.value,
  setSelectedDivision: async (v: string) => {
    secureStore.value = v;
  },
}));

const { resolveVoterDivision, loadVoterDivision } = await import("./division");

const A = "0xAAAAaaaAAaAaAAaAAAaAaaaAAAAaaAAAAAaAAaAA";
const B = "0xBbBBBbbBBBbbbBBBbbbbbBBBBbbbbbbBBBbBbbBB";
const C = "0xcCCcCCCCcccCCCCCCCcCcccCcCCCCcCccccccCCC";

const division = (contract: string, voterAllowlisted?: boolean): DivisionState =>
  ({
    name: `Division ${contract.slice(0, 4)}`,
    votingContract: contract as `0x${string}`,
    voterAllowlisted,
  }) as DivisionState;

beforeEach(() => {
  secureStore.value = null;
  apiMock.getElection.mockReset();
});

describe("resolveVoterDivision", () => {
  it("picks the division whose allowlist contains the voter", async () => {
    const div = await resolveVoterDivision([division(A, false), division(B, true), division(C, false)]);
    expect(div?.votingContract).toBe(B);
  });

  it("caches the resolved division so other screens agree", async () => {
    await resolveVoterDivision([division(A, false), division(B, true)]);
    expect(secureStore.value).toBe(B);
  });

  it("returns null when the voter is on no allowlist", async () => {
    // The old behaviour was divisions[0]; that is the bug this replaces.
    expect(await resolveVoterDivision([division(A, false), division(B, false)])).toBeNull();
  });

  it("does not let a stale cache override the chain", async () => {
    secureStore.value = A;
    const div = await resolveVoterDivision([division(A, false), division(B, true)]);
    expect(div?.votingContract).toBe(B);
  });

  it("clears nothing but resolves null when the cached division no longer lists the voter", async () => {
    secureStore.value = A;
    expect(await resolveVoterDivision([division(A, false)])).toBeNull();
  });

  it("uses the cache only to break ties between multiple allowlists", async () => {
    secureStore.value = C;
    const div = await resolveVoterDivision([division(A, true), division(C, true)]);
    expect(div?.votingContract).toBe(C);
  });

  it("matches the cached address case-insensitively", async () => {
    secureStore.value = B.toLowerCase();
    const div = await resolveVoterDivision([division(A, true), division(B, true)]);
    expect(div?.votingContract).toBe(B);
  });

  it("falls back to the cached division when no division could be read", async () => {
    // Every division unreachable: the API omits the allowlist fields entirely.
    // Reporting "not enrolled" here would be a network outage misread as a
    // missing enrolment.
    secureStore.value = B;
    const div = await resolveVoterDivision([division(A), division(B)]);
    expect(div?.votingContract).toBe(B);
  });

  it("returns null when nothing could be read and there is no cache", async () => {
    expect(await resolveVoterDivision([division(A), division(B)])).toBeNull();
  });

  it("ignores unreadable divisions when at least one answered", async () => {
    const div = await resolveVoterDivision([division(A), division(B, true)]);
    expect(div?.votingContract).toBe(B);
  });

  it("returns null for an empty registry", async () => {
    expect(await resolveVoterDivision([])).toBeNull();
  });
});


/**
 * A replaced phone is the one enrolment state that the allowlist cannot express.
 *
 * `reissueDevice` supersedes the old device in the NicRegistry but nothing
 * obliges the GN officer to also revoke its allowlist entry — supersession is
 * what actually stops it registering. So `voterAllowlisted` stays true, every
 * "are you enrolled" check says yes, and without `voterDevice` the app would
 * cheerfully walk the voter through a biometric prompt, a fresh commitment and
 * a transaction, only to have the chain refuse it.
 */
describe("loadVoterDivision — device standing", () => {
  const electionWith = (voterDevice?: unknown) => ({
    divisions: [division(A, true)],
    ...(voterDevice ? { voterDevice } : {}),
  });

  it("flags a superseded device even though it is still allowlisted", async () => {
    apiMock.getElection.mockResolvedValue(electionWith({ status: "superseded", nicRegistered: false }));

    const result = await loadVoterDivision();

    expect(result.division?.votingContract).toBe(A);
    expect(result.notEnrolled).toBe(false);
    expect(result.deviceSuperseded).toBe(true);
  });

  it("reports when the replacement phone has already registered", async () => {
    apiMock.getElection.mockResolvedValue(electionWith({ status: "superseded", nicRegistered: true }));

    const result = await loadVoterDivision();

    expect(result.deviceSuperseded).toBe(true);
    expect(result.device?.nicRegistered).toBe(true);
  });

  it("leaves a live device alone", async () => {
    apiMock.getElection.mockResolvedValue(electionWith({ status: "live", nicRegistered: false }));

    const result = await loadVoterDivision();

    expect(result.deviceSuperseded).toBe(false);
    expect(result.deviceEnrolled).toBe(true);
    expect(result.device?.status).toBe("live");
  });

  it("flags an allowlisted device that no officer ever enrolled", async () => {
    // Enrolment is mandatory: `register()` refuses an unbound device however it
    // reached the roll. The voter is allowlisted, so every other check says they
    // are fine — this is the only signal that they are not.
    apiMock.getElection.mockResolvedValue(electionWith({ status: "unbound", nicRegistered: false }));

    const result = await loadVoterDivision();

    expect(result.division?.votingContract).toBe(A);
    expect(result.notEnrolled).toBe(false);
    expect(result.deviceSuperseded).toBe(false);
    expect(result.deviceEnrolled).toBe(false);
  });

  it("treats a missing voterDevice as nothing special to say", async () => {
    // No NicRegistry on this chain, or the read failed. Supplementary data —
    // its absence must never present a working device as a replaced one.
    apiMock.getElection.mockResolvedValue(electionWith());

    const result = await loadVoterDivision();

    expect(result.device).toBeNull();
    expect(result.deviceSuperseded).toBe(false);
    // Permissive when the chain said nothing: `register()` enforces the rule
    // anyway, so a failed read must not lock out a properly enrolled voter.
    expect(result.deviceEnrolled).toBe(true);
    expect(result.division?.votingContract).toBe(A);
  });
});
