import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /api/election/history` — the log reconstruction.
 *
 * This route exists because no contract stores a finished election:
 * `resetElection()` blanks the question and deletes the candidates, and
 * `clearDivisions()` empties the division array. The only durable record is the
 * event log, so the whole feature rests on replaying it correctly.
 *
 * The cases below are the ones where a plausible-looking implementation is
 * silently wrong rather than broken — it still returns a result, just not the
 * one that happened:
 *
 *   - votes counted across an `ElectionReset` boundary, merging two ballots;
 *   - the live election (after the final clear) leaking into "past elections";
 *   - a revised candidate list counted under the superseded one;
 *   - divisions attributed to the wrong cycle.
 */

const CHAIN_ID = 9494;
const REGISTRY = "0x0000000000000000000000000000000000000aa0";
const DIV_A = "0x0000000000000000000000000000000000000cc0";
const DIV_B = "0x0000000000000000000000000000000000000cc1";

const mocks = vi.hoisted(() => ({
  getLogs: vi.fn(),
  getBlockNumber: vi.fn(),
  getBlock: vi.fn(),
}));

vi.mock("viem", async importOriginal => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: () => ({
    getLogs: mocks.getLogs,
    getBlockNumber: mocks.getBlockNumber,
    getBlock: mocks.getBlock,
  }),
  http: () => ({}),
}));

vi.mock("~~/utils/serverChain", () => ({
  serverChainConfig: { chainId: CHAIN_ID, rpcUrl: "http://127.0.0.1:9545" },
}));

vi.mock("~~/contracts/deployedContracts", () => ({
  default: { [CHAIN_ID]: { ElectionRegistry: { address: REGISTRY } } },
}));

type StubLog = {
  address: string;
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
};

let block = 0;
/** Each stub log gets its own increasing block, mirroring one tx per action. */
const log = (address: string, eventName: string, args: Record<string, unknown>): StubLog => ({
  address,
  eventName,
  args,
  blockNumber: BigInt(++block),
  logIndex: 0,
});

/**
 * Route the mocked `getLogs` the way the node would: by contract address, and
 * by which event(s) the filter asked for.
 */
const stubChain = (logs: StubLog[]) => {
  mocks.getBlockNumber.mockResolvedValue(BigInt(block + 10));
  mocks.getBlock.mockImplementation(({ blockNumber }: { blockNumber: bigint }) =>
    Promise.resolve({ timestamp: 1_700_000_000n + blockNumber }),
  );
  mocks.getLogs.mockImplementation(({ address, event, events }: any) => {
    const wanted = new Set<string>(event ? [event.name] : ((events ?? []) as { name: string }[]).map(e => e.name));
    return Promise.resolve(
      logs.filter(l => l.address.toLowerCase() === String(address).toLowerCase() && wanted.has(l.eventName)),
    );
  });
};

/** Re-import per test so the route's in-module response cache starts empty. */
const callRoute = async () => {
  vi.resetModules();
  const { GET } = await import("./route");
  return (await GET()).json();
};

beforeEach(() => {
  vi.clearAllMocks();
  block = 0;
});

describe("GET /api/election/history", () => {
  it("reports no past elections before the first clear", async () => {
    stubChain([
      log(REGISTRY, "DivisionAdded", { divisionId: 0n, name: "Kaduwela", votingContract: DIV_A, gnOfficer: "0x0" }),
      log(DIV_A, "CandidatesUpdated", { candidates: ["Alice", "Bob"] }),
      log(DIV_A, "VoteCast", { candidate: 0n }),
    ]);

    const body = await callRoute();

    expect(body.cycleCount).toBe(0);
    expect(body.cycles).toEqual([]);
  });

  it("reconstructs a completed election from its logs", async () => {
    stubChain([
      log(REGISTRY, "DivisionAdded", { divisionId: 0n, name: "Kaduwela", votingContract: DIV_A, gnOfficer: "0x0" }),
      log(DIV_A, "QuestionUpdated", { question: "Who governs?" }),
      log(DIV_A, "CandidatesUpdated", { candidates: ["Alice", "Bob"] }),
      log(DIV_A, "NewLeaf", { index: 0n, value: 1n }),
      log(DIV_A, "NewLeaf", { index: 1n, value: 2n }),
      log(DIV_A, "NewLeaf", { index: 2n, value: 3n }),
      log(DIV_A, "VoteCast", { candidate: 0n }),
      log(DIV_A, "VoteCast", { candidate: 0n }),
      log(DIV_A, "VoteCast", { candidate: 1n }),
      log(DIV_A, "ElectionReset", { electionId: 1n }),
      log(REGISTRY, "DivisionsCleared", { count: 1n }),
    ]);

    const body = await callRoute();

    expect(body.cycleCount).toBe(1);
    const [cycle] = body.cycles;
    expect(cycle.question).toBe("Who governs?");
    expect(cycle.results).toEqual([
      { candidate: "Alice", votes: 2 },
      { candidate: "Bob", votes: 1 },
    ]);
    expect(cycle.totalVotes).toBe(3);
    expect(cycle.registeredVoters).toBe(3);
    expect(cycle.turnout).toBe(1);
    expect(cycle.divisions).toHaveLength(1);
    expect(cycle.divisions[0].votingContract).toBe(DIV_A);
  });

  it("excludes the live election that follows the last clear", async () => {
    stubChain([
      log(REGISTRY, "DivisionAdded", { divisionId: 0n, name: "Kaduwela", votingContract: DIV_A, gnOfficer: "0x0" }),
      log(DIV_A, "CandidatesUpdated", { candidates: ["Alice", "Bob"] }),
      log(DIV_A, "VoteCast", { candidate: 0n }),
      log(DIV_A, "ElectionReset", { electionId: 1n }),
      log(REGISTRY, "DivisionsCleared", { count: 1n }),
      // A brand-new election starts and takes votes — this is /results, not history.
      log(REGISTRY, "DivisionAdded", { divisionId: 0n, name: "Kaduwela", votingContract: DIV_B, gnOfficer: "0x0" }),
      log(DIV_B, "CandidatesUpdated", { candidates: ["Carol", "Dave"] }),
      log(DIV_B, "VoteCast", { candidate: 0n }),
      log(DIV_B, "VoteCast", { candidate: 0n }),
    ]);

    const body = await callRoute();

    expect(body.cycleCount).toBe(1);
    expect(body.cycles[0].results).toEqual([
      { candidate: "Alice", votes: 1 },
      { candidate: "Bob", votes: 0 },
    ]);
    // Carol must not appear anywhere in the history.
    expect(JSON.stringify(body)).not.toContain("Carol");
  });

  it("does not merge votes across a mid-cycle reset of one division", async () => {
    stubChain([
      log(REGISTRY, "DivisionAdded", { divisionId: 0n, name: "Kaduwela", votingContract: DIV_A, gnOfficer: "0x0" }),
      log(DIV_A, "QuestionUpdated", { question: "First run" }),
      log(DIV_A, "CandidatesUpdated", { candidates: ["Alice", "Bob"] }),
      log(DIV_A, "VoteCast", { candidate: 0n }),
      log(DIV_A, "VoteCast", { candidate: 0n }),
      // Operator scraps it and reruns the same division.
      log(DIV_A, "ElectionReset", { electionId: 1n }),
      log(DIV_A, "QuestionUpdated", { question: "Second run" }),
      log(DIV_A, "CandidatesUpdated", { candidates: ["Alice", "Bob"] }),
      log(DIV_A, "VoteCast", { candidate: 1n }),
      log(DIV_A, "ElectionReset", { electionId: 2n }),
      log(REGISTRY, "DivisionsCleared", { count: 1n }),
    ]);

    const body = await callRoute();

    const [cycle] = body.cycles;
    const elections = cycle.divisions[0].elections;
    expect(elections).toHaveLength(2);
    expect(elections[0]).toMatchObject({ electionId: 0, question: "First run", voteCounts: [2, 0] });
    expect(elections[1]).toMatchObject({ electionId: 1, question: "Second run", voteCounts: [0, 1] });
  });

  it("counts votes under the final candidate list when the ballot was revised", async () => {
    stubChain([
      log(REGISTRY, "DivisionAdded", { divisionId: 0n, name: "Kaduwela", votingContract: DIV_A, gnOfficer: "0x0" }),
      log(DIV_A, "CandidatesUpdated", { candidates: ["Wrong", "List"] }),
      log(DIV_A, "CandidatesUpdated", { candidates: ["Alice", "Bob", "Carol"] }),
      log(DIV_A, "VoteCast", { candidate: 2n }),
      log(DIV_A, "ElectionReset", { electionId: 1n }),
      log(REGISTRY, "DivisionsCleared", { count: 1n }),
    ]);

    const body = await callRoute();

    const election = body.cycles[0].divisions[0].elections[0];
    expect(election.candidates).toEqual(["Alice", "Bob", "Carol"]);
    expect(election.voteCounts).toEqual([0, 0, 1]);
  });

  it("keeps separate cycles apart and returns them newest first", async () => {
    stubChain([
      log(REGISTRY, "DivisionAdded", { divisionId: 0n, name: "Kaduwela", votingContract: DIV_A, gnOfficer: "0x0" }),
      log(DIV_A, "QuestionUpdated", { question: "Election one" }),
      log(DIV_A, "CandidatesUpdated", { candidates: ["Alice", "Bob"] }),
      log(DIV_A, "VoteCast", { candidate: 0n }),
      log(DIV_A, "ElectionReset", { electionId: 1n }),
      log(REGISTRY, "DivisionsCleared", { count: 1n }),

      log(REGISTRY, "DivisionAdded", { divisionId: 0n, name: "Matara", votingContract: DIV_B, gnOfficer: "0x0" }),
      log(DIV_B, "QuestionUpdated", { question: "Election two" }),
      log(DIV_B, "CandidatesUpdated", { candidates: ["Carol", "Dave"] }),
      log(DIV_B, "VoteCast", { candidate: 1n }),
      log(DIV_B, "VoteCast", { candidate: 1n }),
      log(DIV_B, "ElectionReset", { electionId: 1n }),
      log(REGISTRY, "DivisionsCleared", { count: 1n }),
    ]);

    const body = await callRoute();

    expect(body.cycleCount).toBe(2);
    // Newest first.
    expect(body.cycles[0].question).toBe("Election two");
    expect(body.cycles[0].divisions.map((d: { name: string }) => d.name)).toEqual(["Matara"]);
    expect(body.cycles[1].question).toBe("Election one");
    expect(body.cycles[1].divisions.map((d: { name: string }) => d.name)).toEqual(["Kaduwela"]);
  });

  it("aggregates divisions of one cycle by candidate name", async () => {
    stubChain([
      log(REGISTRY, "DivisionAdded", { divisionId: 0n, name: "Kaduwela", votingContract: DIV_A, gnOfficer: "0x0" }),
      log(REGISTRY, "DivisionAdded", { divisionId: 1n, name: "Matara", votingContract: DIV_B, gnOfficer: "0x0" }),
      log(DIV_A, "CandidatesUpdated", { candidates: ["Alice", "Bob"] }),
      log(DIV_A, "VoteCast", { candidate: 0n }),
      // Same people, listed in the opposite order in this division. Matching by
      // index rather than name would credit these votes to the wrong candidate.
      log(DIV_B, "CandidatesUpdated", { candidates: ["Bob", "Alice"] }),
      log(DIV_B, "VoteCast", { candidate: 0n }),
      log(DIV_B, "VoteCast", { candidate: 0n }),
      log(REGISTRY, "DivisionsCleared", { count: 2n }),
    ]);

    const body = await callRoute();

    expect(body.cycles[0].results).toEqual([
      { candidate: "Bob", votes: 2 },
      { candidate: "Alice", votes: 1 },
    ]);
    expect(body.cycles[0].totalVotes).toBe(3);
  });
});
