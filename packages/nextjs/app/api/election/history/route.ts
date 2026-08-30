import { NextResponse } from "next/server";
import { Log, createPublicClient, http, parseAbiItem } from "viem";
import deployedContracts from "~~/contracts/deployedContracts";
import { serverChainConfig } from "~~/utils/serverChain";

/**
 * GET /api/election/history
 *
 * Past elections, newest first, reconstructed from event logs.
 *
 * Nothing on-chain stores a finished election as such. `resetElection()` blanks
 * the question and deletes the candidate list, and `clearDivisions()` empties
 * the division array — so by the time an election is over, the contracts no
 * longer describe it. What survives is the log: `CandidatesUpdated`,
 * `QuestionUpdated`, `VoteCast` and `NewLeaf` were all emitted while it ran, and
 * no contract call can delete a log. This route replays them.
 *
 * That is why this works on contracts deployed long before the feature existed,
 * and why it recovers elections that have already been reset and wiped.
 *
 * The reconstruction is a two-level partition:
 *
 *   1. `DivisionsCleared` on the registry splits the chain into election
 *      *cycles*. The trailing range after the last clear is the live election —
 *      excluded here, because that one is `/results`.
 *   2. Within a cycle, each division's own `ElectionReset` events split its logs
 *      further. Normally there is exactly one election per division per cycle,
 *      but an operator who reset a single division mid-cycle produces two, and
 *      folding their tallies together would invent a result that never happened.
 */

const { chainId: CHAIN_ID, rpcUrl: RPC_URL } = serverChainConfig;

/**
 * `eth_getLogs` is capped at `LOG_RANGE_LIMIT` blocks (100,000 by default on
 * the Go node). An election chain is orders of magnitude shorter than that, so
 * this paging never actually engages today — it is here so that a long-lived
 * deployment degrades into more requests rather than into a `-32000`.
 */
const BLOCK_CHUNK = 45_000n;

/** Reconstruction walks the whole chain, so hold the result briefly. */
const CACHE_TTL_MS = 30_000;

const DIVISION_ADDED = parseAbiItem(
  "event DivisionAdded(uint256 indexed divisionId, string name, address votingContract, address gnOfficer)",
);
const DIVISIONS_CLEARED = parseAbiItem("event DivisionsCleared(uint256 count)");

// `createDivision` emits DivisionCreated *and* DivisionAdded, while
// `addDivision` emits only DivisionAdded — so DivisionAdded alone covers both
// registration paths without double-counting the factory case.
const VOTING_EVENTS = [
  parseAbiItem("event QuestionUpdated(string question)"),
  parseAbiItem("event CandidatesUpdated(string[] candidates)"),
  parseAbiItem("event ElectionReset(uint256 indexed electionId)"),
  parseAbiItem("event NewLeaf(uint256 index, uint256 value)"),
  parseAbiItem(
    "event VoteCast(bytes32 indexed nullifierHash, address indexed voter, uint256 indexed candidate, uint256 timestamp, uint256 newCount)",
  ),
] as const;

interface ReconstructedElection {
  electionId: number;
  question: string;
  candidates: string[];
  voteCounts: number[];
  totalVotes: number;
  registeredVoters: number;
  archivedAt: number;
}

interface ReconstructedDivision {
  name: string;
  votingContract: string;
  gnOfficer: string;
  elections: ReconstructedElection[];
}

/**
 * A log after viem has decoded it against a known event. `viem`'s bare `Log`
 * carries no `args`/`eventName` — those appear only once an `event`/`events`
 * filter has been supplied, which every query here does.
 */
type DecodedLog = Log & { args: Record<string, any>; eventName: string };

/** Ordering within a block matters: a clear and an add can share one block. */
type Positioned = { blockNumber: bigint | null; logIndex: number | null };

const before = (log: Positioned, boundary: Positioned) => {
  const lb = log.blockNumber ?? 0n;
  const bb = boundary.blockNumber ?? 0n;
  if (lb !== bb) return lb < bb;
  return (log.logIndex ?? 0) < (boundary.logIndex ?? 0);
};

const after = (log: Positioned, boundary: Positioned) => !before(log, boundary) && !sameSpot(log, boundary);

const sameSpot = (a: Positioned, b: Positioned) => a.blockNumber === b.blockNumber && a.logIndex === b.logIndex;

let cache: { at: number; payload: unknown } | null = null;

export async function GET() {
  try {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return NextResponse.json(cache.payload);
    }

    const registry = (deployedContracts as Record<number, any>)[CHAIN_ID]?.ElectionRegistry;
    if (!registry?.address) {
      return NextResponse.json({ error: `ElectionRegistry not deployed on chain ${CHAIN_ID}` }, { status: 404 });
    }

    const client = createPublicClient({ transport: http(RPC_URL) });
    const registryAddress = registry.address as `0x${string}`;
    const head = await client.getBlockNumber();

    const [addedLogs, clearedLogs] = await Promise.all([
      getLogsPaged(client, { address: registryAddress, event: DIVISION_ADDED }, head),
      getLogsPaged(client, { address: registryAddress, event: DIVISIONS_CLEARED }, head),
    ]);

    // No clear has ever happened: the first election is still running, so there
    // is nothing in the past yet.
    if (clearedLogs.length === 0) {
      return respond({ chainId: CHAIN_ID, registry: registryAddress, cycleCount: 0, cycles: [] });
    }

    // Every division contract that ever existed, fetched once each even if it
    // was registered in more than one cycle.
    const addresses = [...new Set(addedLogs.map(l => l.args.votingContract as `0x${string}`))];
    const logsByDivision = new Map<string, DecodedLog[]>();
    await Promise.all(
      addresses.map(async address => {
        const logs = await getLogsPaged(client, { address, events: VOTING_EVENTS }, head);
        logsByDivision.set(address.toLowerCase(), logs);
      }),
    );

    const boundaries = [...clearedLogs].sort((a, b) => (before(a, b) ? -1 : 1));
    const concludedAt = await Promise.all(
      boundaries.map(async b =>
        b.blockNumber === null ? 0 : Number((await client.getBlock({ blockNumber: b.blockNumber })).timestamp),
      ),
    );

    const cycles = boundaries.map((boundary, cycleIndex) => {
      const previous = cycleIndex === 0 ? null : boundaries[cycleIndex - 1];

      const inCycle = (log: Positioned) => (previous === null || after(log, previous)) && before(log, boundary);

      const divisions: ReconstructedDivision[] = addedLogs.filter(inCycle).map(added => {
        const args = added.args;
        const address = (args.votingContract as string).toLowerCase();
        const logs = (logsByDivision.get(address) ?? []).filter(inCycle);

        return {
          name: args.name as string,
          votingContract: args.votingContract as string,
          gnOfficer: args.gnOfficer as string,
          elections: splitIntoElections(logs, concludedAt[cycleIndex]),
        };
      });

      return { cycleIndex, ...summarise(divisions), archivedAt: concludedAt[cycleIndex], divisions };
    });

    // Newest first: whoever opens this page almost always wants the election
    // that just ended, not the first one ever run.
    cycles.reverse();

    return respond({
      chainId: CHAIN_ID,
      registry: registryAddress,
      cycleCount: cycles.length,
      cycles,
    });
  } catch (error) {
    console.error("[/api/election/history] error:", error);
    return NextResponse.json({ error: "Failed to reconstruct election history from chain logs" }, { status: 500 });
  }
}

function respond(payload: unknown) {
  cache = { at: Date.now(), payload };
  return NextResponse.json(payload);
}

/**
 * Split one division's logs, already narrowed to a single cycle, into the
 * elections it actually ran.
 *
 * `ElectionReset` is the divider. It is emitted *after* the id is incremented,
 * so the segment preceding `ElectionReset(n)` is election `n - 1`.
 *
 * Segments with no candidate list are dropped. The last segment is almost
 * always one of those: "start a new election" resets every division and then
 * clears the registry, leaving a blank tail that is not an election anyone
 * could have voted in.
 */
function splitIntoElections(logs: DecodedLog[], archivedAt: number): ReconstructedElection[] {
  const ordered = [...logs].sort((a, b) => (before(a, b) ? -1 : 1));

  const segments: { electionId: number; logs: DecodedLog[] }[] = [];
  let current: DecodedLog[] = [];
  let electionId = 0;

  for (const log of ordered) {
    if (log.eventName === "ElectionReset") {
      segments.push({ electionId, logs: current });
      electionId = Number(log.args.electionId);
      current = [];
    } else {
      current.push(log);
    }
  }
  segments.push({ electionId, logs: current });

  return segments.flatMap(segment => {
    let question = "";
    let candidates: string[] = [];
    let registeredVoters = 0;
    const tally = new Map<number, number>();

    for (const log of segment.logs) {
      const { eventName, args } = log;
      switch (eventName) {
        case "QuestionUpdated":
          question = args.question as string;
          break;
        case "CandidatesUpdated":
          // Last one wins: an admin may revise the ballot during Setup, and
          // only the final list was the one voted on.
          candidates = [...(args.candidates as string[])];
          break;
        case "NewLeaf":
          registeredVoters += 1;
          break;
        case "VoteCast": {
          const index = Number(args.candidate);
          tally.set(index, (tally.get(index) ?? 0) + 1);
          break;
        }
      }
    }

    if (candidates.length === 0) return [];

    const voteCounts = candidates.map((_, index) => tally.get(index) ?? 0);
    return [
      {
        electionId: segment.electionId,
        question,
        candidates,
        voteCounts,
        totalVotes: voteCounts.reduce((sum, count) => sum + count, 0),
        registeredVoters,
        archivedAt,
      },
    ];
  });
}

/**
 * Roll a cycle's divisions up into one national result.
 *
 * Candidates are matched by *name*, not by index. `/api/election` aligns them
 * positionally, which is safe there because a live cycle's divisions are
 * configured together — but history spans elections configured independently,
 * and silently adding "Yes" to "No" because both sat at index 0 would corrupt a
 * historical record rather than merely mis-render a live one.
 */
function summarise(divisions: ReconstructedDivision[]) {
  const totals = new Map<string, number>();
  let totalVotes = 0;
  let registeredVoters = 0;
  let question = "";

  for (const division of divisions) {
    for (const election of division.elections) {
      if (!question) question = election.question;
      totalVotes += election.totalVotes;
      registeredVoters += election.registeredVoters;
      election.candidates.forEach((name, index) => {
        totals.set(name, (totals.get(name) ?? 0) + (election.voteCounts[index] ?? 0));
      });
    }
  }

  const results = [...totals.entries()]
    .map(([candidate, votes]) => ({ candidate, votes }))
    .sort((a, b) => b.votes - a.votes);

  return {
    question,
    results,
    totalVotes,
    registeredVoters,
    turnout: registeredVoters > 0 ? totalVotes / registeredVoters : 0,
  };
}

/** `eth_getLogs` in `BLOCK_CHUNK`-sized windows, from genesis to `head`. */
async function getLogsPaged(
  client: ReturnType<typeof createPublicClient>,
  params: Record<string, unknown>,
  head: bigint,
): Promise<DecodedLog[]> {
  const collected: DecodedLog[] = [];
  for (let start = 0n; start <= head; start += BLOCK_CHUNK) {
    const end = start + BLOCK_CHUNK - 1n > head ? head : start + BLOCK_CHUNK - 1n;
    const batch = await client.getLogs({ ...(params as any), fromBlock: start, toBlock: end });
    collected.push(...(batch as unknown as DecodedLog[]));
  }
  return collected;
}
