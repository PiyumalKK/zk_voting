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

vi.mock("./keystore", () => ({
  getAddress: async () => "0x000000000000000000000000000000000000dEaD",
  getSelectedDivision: async () => secureStore.value,
  setSelectedDivision: async (v: string) => {
    secureStore.value = v;
  },
}));

const { resolveVoterDivision } = await import("./division");

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
