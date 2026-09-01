import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /api/election?voter=` — specifically, the `voterDevice` field.
 *
 * This is a contract between two packages: the route computes it, and the voter
 * app in `packages/mobile` branches on it to decide whether to let someone try
 * to register. Nothing else connects them, so a rename or a shape change here
 * fails silently over there — the app would simply stop noticing that a phone
 * had been replaced and go back to letting the voter spend a biometric prompt, a
 * commitment and a transaction on a registration the chain will refuse.
 *
 * The case that matters most is the one the allowlist cannot express: a
 * superseded device is usually *still allowlisted*, because nothing obliges the
 * GN officer to revoke the old address — supersession in the NicRegistry is what
 * actually stops it. So `voterAllowlisted: true` and `status: "superseded"` are
 * the correct, and initially surprising, combination.
 */

const CHAIN_ID = 9494;
const REGISTRY = "0x0000000000000000000000000000000000000aa0";
const NIC_REGISTRY = "0x0000000000000000000000000000000000000bb0";
const DIVISION = "0x0000000000000000000000000000000000000cc0";
const VOTER = "0x00000000000000000000000000000000000000d1";
const NIC_HASH = `0x${"ab".repeat(32)}`;

const mocks = vi.hoisted(() => ({ readContract: vi.fn() }));

vi.mock("viem", async importOriginal => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: () => ({ readContract: mocks.readContract }),
  http: () => ({}),
}));

vi.mock("~~/utils/serverChain", () => ({
  serverChainConfig: { chainId: CHAIN_ID, rpcUrl: "http://127.0.0.1:9545" },
}));

vi.mock("~~/contracts/deployedContracts", () => ({
  default: {
    [CHAIN_ID]: {
      ElectionRegistry: { address: REGISTRY },
      NicRegistry: { address: NIC_REGISTRY },
    },
  },
}));

const { GET } = await import("./route");

/** getVotingData's tuple, in the order the route indexes it. */
const VOTING_DATA = ["Question?", "0x0", 1, 0, 0, 3n, 2n, 42n, 2n];

interface ChainStubs {
  /** `[allowlisted, registered]` from Voting.getVoterData. */
  voterData?: [boolean, boolean];
  /** `[statusIndex, nicHash]` from NicRegistry.getDeviceStatus. */
  deviceStatus?: [number, string] | Error;
  /** `[votingContract, device, committed, issueCount]` from NicRegistry.getEnrolment. */
  enrolment?: [string, string, boolean, number];
}

const stubChain = ({ voterData = [true, false], deviceStatus, enrolment }: ChainStubs = {}) =>
  mocks.readContract.mockImplementation(({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case "getAllDivisions":
        return Promise.resolve([{ name: "Kaduwela", votingContract: DIVISION, gnOfficer: "0x0", active: true }]);
      case "getVotingData":
        return Promise.resolve(VOTING_DATA);
      case "getCandidates":
        return Promise.resolve(["Alice", "Bob"]);
      case "getVoteCounts":
        return Promise.resolve([1n, 2n]);
      case "getGNOfficers":
        return Promise.resolve(["0x0"]);
      case "getVoterData":
        return Promise.resolve(voterData);
      case "getDeviceStatus":
        return deviceStatus instanceof Error ? Promise.reject(deviceStatus) : Promise.resolve(deviceStatus);
      case "getEnrolment":
        return Promise.resolve(enrolment ?? [DIVISION, VOTER, false, 0]);
      default:
        return Promise.resolve(undefined);
    }
  });

const get = async (query: string) => {
  const response = await GET({ nextUrl: new URL(`http://localhost/api/election${query}`) } as never);
  return response.json();
};

// Braces matter: `mockReset()` returns the mock, and a value returned from
// `beforeEach` is taken as its teardown callback — so the concise-body form
// hands Vitest the mock itself to call, with no arguments, after every test.
beforeEach(() => {
  mocks.readContract.mockReset();
});

describe("GET /api/election — voterDevice", () => {
  it("is omitted entirely when no voter was asked about", async () => {
    stubChain({ deviceStatus: [1, NIC_HASH] });

    const body = await get("");

    expect(body.voterDevice).toBeUndefined();
    // And the registry was never consulted — no wasted reads on the public path.
    expect(mocks.readContract.mock.calls.some(([c]) => c.functionName === "getDeviceStatus")).toBe(false);
  });

  it("reports a live device", async () => {
    stubChain({ deviceStatus: [1, NIC_HASH] });

    const body = await get(`?voter=${VOTER}`);

    expect(body.voterDevice).toEqual({ status: "live", nicRegistered: false });
  });

  it("reports a superseded device that is still on the allowlist", async () => {
    // The combination the whole field exists for.
    stubChain({ voterData: [true, false], deviceStatus: [2, NIC_HASH] });

    const body = await get(`?voter=${VOTER}`);

    expect(body.divisions[0].voterAllowlisted).toBe(true);
    expect(body.divisions[0].voterRegistered).toBe(false);
    expect(body.voterDevice).toEqual({ status: "superseded", nicRegistered: false });
  });

  it("reports that the citizen has registered on their replacement phone", async () => {
    // `voterRegistered` is false for *this* address and always will be; only the
    // NIC's own record can say the person is done.
    stubChain({
      voterData: [true, false],
      deviceStatus: [2, NIC_HASH],
      enrolment: [DIVISION, "0x00000000000000000000000000000000000000d2", true, 1],
    });

    const body = await get(`?voter=${VOTER}`);

    expect(body.voterDevice).toEqual({ status: "superseded", nicRegistered: true });
  });

  it("skips the second read for an unbound device", async () => {
    // Nothing to look up: no NIC, so no registration record.
    stubChain({ deviceStatus: [0, `0x${"00".repeat(32)}`] });

    const body = await get(`?voter=${VOTER}`);

    expect(body.voterDevice).toEqual({ status: "unbound", nicRegistered: false });
    expect(mocks.readContract.mock.calls.some(([c]) => c.functionName === "getEnrolment")).toBe(false);
  });

  it("never returns the nicHash", async () => {
    // It is an HMAC under a server-held pepper. A public endpoint that echoed it
    // would let anyone build an address → NIC map from addresses they collect.
    stubChain({ deviceStatus: [2, NIC_HASH] });

    const body = await get(`?voter=${VOTER}`);

    expect(JSON.stringify(body)).not.toContain(NIC_HASH.slice(2));
  });

  it("serves the election anyway when the registry read fails", async () => {
    // A chain whose NicRegistry predates device binding, or a flaky RPC.
    // Supplementary data must not turn a working payload into a 500.
    stubChain({ deviceStatus: new Error("execution reverted") });

    const body = await get(`?voter=${VOTER}`);

    expect(body.voterDevice).toBeUndefined();
    expect(body.divisions).toHaveLength(1);
    expect(body.divisions[0].name).toBe("Kaduwela");
  });

  it("ignores a malformed voter address", async () => {
    stubChain({ deviceStatus: [2, NIC_HASH] });

    const body = await get("?voter=not-an-address");

    expect(body.voterDevice).toBeUndefined();
    expect(body.divisions[0].voterAllowlisted).toBeUndefined();
  });
});
