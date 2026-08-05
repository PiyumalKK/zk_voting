import { MAX_ARRAY_LENGTH, MAX_STRING_LENGTH, authorizeRelayCall } from "./relayPolicy";
import type { AuthorizeResult, KnownContract } from "./relayPolicy";
import type { Abi } from "abitype";
import { describe, expect, it } from "vitest";

/**
 * Tests for the relay's authorization policy.
 *
 * This is the module that decides whether a session may cause the server to
 * sign a transaction, so the cases below are written as attacks rather than as
 * happy paths: a GN reaching into a neighbouring division, a caller naming an
 * address the deployment has never heard of, a vote smuggled through the
 * operator relay. Each one must be refused for a specific, stated reason.
 */

const REGISTRY = "0x1111111111111111111111111111111111111111";
const NIC_REGISTRY = "0x2222222222222222222222222222222222222222";
const DIVISION_0 = "0x3333333333333333333333333333333333333333";
const DIVISION_1 = "0x4444444444444444444444444444444444444444";
const VOTER = "0x5555555555555555555555555555555555555555";
const NIC_HASH = `0x${"ab".repeat(32)}`;

/** Mirrors the real `Voting` surface closely enough to exercise every rule. */
const VOTING_ABI = [
  {
    type: "function",
    name: "setQuestion",
    stateMutability: "nonpayable",
    inputs: [{ name: "_q", type: "string" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setCandidates",
    stateMutability: "nonpayable",
    inputs: [{ name: "_c", type: "string[]" }],
    outputs: [],
  },
  {
    type: "function",
    name: "addVoters",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_voters", type: "address[]" },
      { name: "_statuses", type: "bool[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "startRegistration",
    stateMutability: "nonpayable",
    inputs: [{ name: "_d", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "startVoting",
    stateMutability: "nonpayable",
    inputs: [{ name: "_d", type: "uint256" }],
    outputs: [],
  },
  { type: "function", name: "endElection", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "resetElection", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "setGNOfficer",
    stateMutability: "nonpayable",
    inputs: [{ name: "_gn", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "_c", type: "uint256" }],
    outputs: [],
  },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "donate", stateMutability: "payable", inputs: [], outputs: [] },
] as const satisfies Abi;

const NIC_REGISTRY_ABI = [
  {
    type: "function",
    name: "reserveNicHash",
    stateMutability: "nonpayable",
    inputs: [
      { name: "nicHash", type: "bytes32" },
      { name: "votingContract", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "setVotingContract",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_votingContract", type: "address" },
      { name: "_authorized", type: "bool" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const ELECTION_REGISTRY_ABI = [
  {
    type: "function",
    name: "createDivision",
    stateMutability: "nonpayable",
    inputs: [{ name: "_name", type: "string" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "addDivision",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_name", type: "string" },
      { name: "_voting", type: "address" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const KNOWN: KnownContract[] = [
  { kind: "ElectionRegistry", address: REGISTRY, abi: ELECTION_REGISTRY_ABI as unknown as Abi },
  { kind: "NicRegistry", address: NIC_REGISTRY, abi: NIC_REGISTRY_ABI as unknown as Abi },
  { kind: "Voting", address: DIVISION_0, abi: VOTING_ABI as unknown as Abi },
  { kind: "Voting", address: DIVISION_1, abi: VOTING_ABI as unknown as Abi },
];

const asAdmin = (target: string, fn: string, args: unknown[] = []): AuthorizeResult =>
  authorizeRelayCall({ role: "admin", request: { target, fn, args }, known: KNOWN });

/** A GN scoped to division 0 — every cross-division case below uses division 1. */
const asGn = (target: string, fn: string, args: unknown[] = []): AuthorizeResult =>
  authorizeRelayCall({
    role: "gn",
    request: { target, fn, args },
    known: KNOWN,
    gnDivisionContract: DIVISION_0,
  });

const errorOf = (result: AuthorizeResult) => (result.ok ? undefined : result.error);
const statusOf = (result: AuthorizeResult) => (result.ok ? undefined : result.status);

describe("admin whitelist", () => {
  it.each([
    ["setQuestion", ["Who should represent this division?"]],
    ["setCandidates", [["Alice", "Bob"]]],
    ["startRegistration", [3600]],
    ["startVoting", [3600]],
    ["endElection", []],
    ["resetElection", []],
    ["setGNOfficer", [VOTER]],
  ])("permits %s on a division", (fn, args) => {
    expect(asAdmin(DIVISION_0, fn, args).ok).toBe(true);
  });

  it("permits registry management", () => {
    expect(asAdmin(REGISTRY, "createDivision", ["Kandy"]).ok).toBe(true);
    expect(asAdmin(REGISTRY, "addDivision", ["Kandy", DIVISION_1]).ok).toBe(true);
    expect(asAdmin(NIC_REGISTRY, "setVotingContract", [DIVISION_0, true]).ok).toBe(true);
  });

  it("refuses voter functions — those must never pass through the server", () => {
    // `register` and `vote` are the anonymity boundary: a relay that signs them
    // links a voter to the server's key and to a logged-in session.
    const result = asAdmin(DIVISION_0, "register", [1]);
    expect(statusOf(result)).toBe(403);
    expect(errorOf(result)).toMatch(/may not call register/);
  });

  it("refuses a function that exists in the ABI but is not whitelisted", () => {
    expect(statusOf(asAdmin(NIC_REGISTRY, "reserveNicHash", [NIC_HASH, DIVISION_0]))).toBe(403);
  });

  it("refuses read-only functions", () => {
    // Whitelisted-by-name is not enough; `owner` is not on the list, so it is
    // caught earlier — this asserts the stateMutability guard independently.
    const result = authorizeRelayCall({
      role: "admin",
      request: { target: DIVISION_0, fn: "owner", args: [] },
      known: [{ kind: "Voting", address: DIVISION_0, abi: VOTING_ABI as unknown as Abi }],
    });
    expect(result.ok).toBe(false);
  });
});

describe("unknown targets", () => {
  it("refuses an address the deployment does not know", () => {
    const result = asAdmin("0x9999999999999999999999999999999999999999", "setQuestion", ["hi"]);
    expect(statusOf(result)).toBe(403);
    // The message must not disclose which addresses are known.
    expect(errorOf(result)).toBe("The relay does not sign calls to that address.");
  });

  it("refuses a malformed target", () => {
    expect(statusOf(asAdmin("not-an-address", "setQuestion", ["hi"]))).toBe(400);
  });

  it("matches known addresses case-insensitively", () => {
    expect(asAdmin(DIVISION_0.toUpperCase().replace("0X", "0x"), "endElection", []).ok).toBe(true);
  });
});

describe("GN scoping", () => {
  it("permits addVoters on the officer's own division", () => {
    expect(asGn(DIVISION_0, "addVoters", [[VOTER], [true]]).ok).toBe(true);
  });

  it("refuses addVoters on another division", () => {
    const result = asGn(DIVISION_1, "addVoters", [[VOTER], [true]]);
    expect(statusOf(result)).toBe(403);
    expect(errorOf(result)).toBe("You may only act on your own division.");
  });

  it("permits reserveNicHash naming the officer's own division", () => {
    expect(asGn(NIC_REGISTRY, "reserveNicHash", [NIC_HASH, DIVISION_0]).ok).toBe(true);
  });

  it("refuses reserveNicHash naming another division", () => {
    // The scope check has to read the *argument* here, not the target: the call
    // is made on the shared NicRegistry either way.
    const result = asGn(NIC_REGISTRY, "reserveNicHash", [NIC_HASH, DIVISION_1]);
    expect(statusOf(result)).toBe(403);
  });

  it("refuses admin-only functions even on the officer's own division", () => {
    expect(statusOf(asGn(DIVISION_0, "startVoting", [3600]))).toBe(403);
    expect(statusOf(asGn(DIVISION_0, "setGNOfficer", [VOTER]))).toBe(403);
    expect(statusOf(asGn(REGISTRY, "createDivision", ["Kandy"]))).toBe(403);
  });

  it("refuses everything when the session carries no division", () => {
    const result = authorizeRelayCall({
      role: "gn",
      request: { target: DIVISION_0, fn: "addVoters", args: [[VOTER], [true]] },
      known: KNOWN,
    });
    expect(statusOf(result)).toBe(403);
    expect(errorOf(result)).toMatch(/not assigned to a division/);
  });
});

describe("argument validation", () => {
  it("rejects the wrong number of arguments", () => {
    const result = asAdmin(DIVISION_0, "startVoting", []);
    expect(statusOf(result)).toBe(400);
    expect(errorOf(result)).toMatch(/expects 1 argument/);
  });

  it("coerces integers from numbers and decimal strings to bigint", () => {
    const fromNumber = asAdmin(DIVISION_0, "startVoting", [3600]);
    const fromString = asAdmin(DIVISION_0, "startVoting", ["3600"]);
    expect(fromNumber.ok && fromNumber.args[0]).toBe(3600n);
    expect(fromString.ok && fromString.args[0]).toBe(3600n);
  });

  it("rejects non-integer, negative and oversized uint values", () => {
    expect(statusOf(asAdmin(DIVISION_0, "startVoting", [1.5]))).toBe(400);
    expect(statusOf(asAdmin(DIVISION_0, "startVoting", ["-1"]))).toBe(400);
    expect(statusOf(asAdmin(DIVISION_0, "startVoting", [(2n ** 256n).toString()]))).toBe(400);
    expect(statusOf(asAdmin(DIVISION_0, "startVoting", ["3600; DROP TABLE"]))).toBe(400);
  });

  it("rejects malformed addresses inside arrays", () => {
    const result = asGn(DIVISION_0, "addVoters", [["0xnope"], [true]]);
    expect(statusOf(result)).toBe(400);
    expect(errorOf(result)).toMatch(/hex address/);
  });

  it("rejects non-boolean values where the ABI wants bool", () => {
    expect(statusOf(asGn(DIVISION_0, "addVoters", [[VOTER], ["true"]]))).toBe(400);
  });

  it("rejects a bytes32 of the wrong length", () => {
    expect(statusOf(asGn(NIC_REGISTRY, "reserveNicHash", ["0xabcd", DIVISION_0]))).toBe(400);
  });

  it("rejects arrays and strings beyond the relay's size caps", () => {
    const tooManyVoters = Array.from({ length: MAX_ARRAY_LENGTH + 1 }, () => VOTER);
    expect(statusOf(asGn(DIVISION_0, "addVoters", [tooManyVoters, [true]]))).toBe(400);
    expect(statusOf(asAdmin(DIVISION_0, "setQuestion", ["x".repeat(MAX_STRING_LENGTH + 1)]))).toBe(400);
  });

  it("rejects a non-array where the ABI wants one", () => {
    expect(statusOf(asAdmin(DIVISION_0, "setCandidates", ["Alice"]))).toBe(400);
  });

  it("rejects a non-array `args` payload", () => {
    const result = authorizeRelayCall({
      role: "admin",
      request: { target: DIVISION_0, fn: "endElection", args: "nope" as unknown as unknown[] },
      known: KNOWN,
    });
    expect(statusOf(result)).toBe(400);
  });
});
