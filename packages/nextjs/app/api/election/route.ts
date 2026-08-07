import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import deployedContracts from "~~/contracts/deployedContracts";
import { PHASE_LABELS } from "~~/utils/electionPhase";
import { serverChainConfig } from "~~/utils/serverChain";

/**
 * GET /api/election
 *
 * Returns live, division-aware election state read directly from the chain:
 * every registered division (name, contract, phase, candidates, vote counts,
 * turnout) plus a national aggregate.
 *
 * Query params:
 *   ?division=<contractAddress>  → return only that division
 *   ?voter=<address>             → also report, per division, whether that
 *                                  address is on its allowlist. This is how the
 *                                  voter app derives a voter's division instead
 *                                  of asking them to pick one.
 *
 * Consumed by the native voter app and any external integrator/observer.
 * The server holds NO secrets — this is purely public on-chain data.
 */

const { chainId: CHAIN_ID, rpcUrl: RPC_URL } = serverChainConfig;

const REGISTRY_ABI = [
  {
    name: "getAllDivisions",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "name", type: "string" },
          { name: "votingContract", type: "address" },
          { name: "gnOfficer", type: "address" },
          { name: "active", type: "bool" },
        ],
      },
    ],
  },
] as const;

const VOTING_ABI = [
  {
    name: "getVotingData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { type: "string" }, // question
      { type: "address" }, // contractOwner
      { type: "uint8" }, // phase
      { type: "uint256" }, // registrationEndTime
      { type: "uint256" }, // votingEndTime
      { type: "uint256" }, // size (treeSize)
      { type: "uint256" }, // depth
      { type: "uint256" }, // root
      { type: "uint256" }, // candidateCount
    ],
  },
  { name: "getCandidates", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string[]" }] },
  { name: "getVoteCounts", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] },
  { name: "s_gnOfficer", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    name: "getVoterData",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_voter", type: "address" }],
    outputs: [
      { name: "voter", type: "bool" },
      { name: "registered", type: "bool" },
    ],
  },
] as const;

interface DivisionState {
  name: string;
  votingContract: string;
  gnOfficer: string;
  active: boolean;
  phase: number;
  phaseLabel: string;
  question: string;
  candidates: string[];
  voteCounts: number[];
  totalVotes: number;
  registeredVoters: number;
  registrationEndTime: number;
  votingEndTime: number;
  root: string;
  /** Only present when ?voter= was supplied: is that address on this division's allowlist? */
  voterAllowlisted?: boolean;
  /** Only present when ?voter= was supplied: has that address already registered here? */
  voterRegistered?: boolean;
}

export async function GET(req: NextRequest) {
  try {
    const registry = (deployedContracts as Record<number, any>)[CHAIN_ID]?.ElectionRegistry;
    if (!registry?.address) {
      return NextResponse.json({ error: `ElectionRegistry not deployed on chain ${CHAIN_ID}` }, { status: 404 });
    }

    const client = createPublicClient({ transport: http(RPC_URL) });

    const rawDivisions = (await client.readContract({
      address: registry.address as `0x${string}`,
      abi: REGISTRY_ABI,
      functionName: "getAllDivisions",
    })) as readonly { name: string; votingContract: `0x${string}`; gnOfficer: string; active: boolean }[];

    const filter = req.nextUrl.searchParams.get("division")?.toLowerCase();

    // A GN officer enrols a voter on exactly one division's contract, so the
    // allowlist is already the authoritative record of which division a voter
    // belongs to. Reporting it here lets the voter app derive the division
    // instead of asking the voter to pick it. Still public data: the caller
    // must already know the address they are asking about.
    const voterParam = req.nextUrl.searchParams.get("voter");
    const voter = /^0x[0-9a-fA-F]{40}$/.test(voterParam ?? "") ? (voterParam as `0x${string}`) : null;

    const divisions: DivisionState[] = await Promise.all(
      rawDivisions
        .filter(d => !filter || d.votingContract.toLowerCase() === filter)
        .map(async (d): Promise<DivisionState> => {
          try {
            const [votingData, candidates, voteCounts, gn, voterData] = await Promise.all([
              client.readContract({ address: d.votingContract, abi: VOTING_ABI, functionName: "getVotingData" }),
              client.readContract({ address: d.votingContract, abi: VOTING_ABI, functionName: "getCandidates" }),
              client.readContract({ address: d.votingContract, abi: VOTING_ABI, functionName: "getVoteCounts" }),
              client.readContract({ address: d.votingContract, abi: VOTING_ABI, functionName: "s_gnOfficer" }),
              voter
                ? client.readContract({
                    address: d.votingContract,
                    abi: VOTING_ABI,
                    functionName: "getVoterData",
                    args: [voter],
                  })
                : Promise.resolve(null),
            ]);
            const vd = votingData as readonly unknown[];
            const counts = (voteCounts as bigint[]).map(Number);
            return {
              name: d.name,
              votingContract: d.votingContract,
              gnOfficer: gn as string,
              active: d.active,
              phase: Number(vd[2]),
              phaseLabel: PHASE_LABELS[Number(vd[2])] ?? "Unknown",
              question: vd[0] as string,
              candidates: candidates as string[],
              voteCounts: counts,
              totalVotes: counts.reduce((s, c) => s + c, 0),
              registeredVoters: Number(vd[5]),
              registrationEndTime: Number(vd[3]),
              votingEndTime: Number(vd[4]),
              root: (vd[7] as bigint).toString(),
              ...(voterData ? { voterAllowlisted: Boolean(voterData[0]), voterRegistered: Boolean(voterData[1]) } : {}),
            };
          } catch {
            return {
              name: d.name,
              votingContract: d.votingContract,
              gnOfficer: d.gnOfficer,
              active: d.active,
              phase: 0,
              phaseLabel: "Unreachable",
              question: "",
              candidates: [],
              voteCounts: [],
              totalVotes: 0,
              registeredVoters: 0,
              registrationEndTime: 0,
              votingEndTime: 0,
              root: "0",
            };
          }
        }),
    );

    // National aggregate (candidates assumed index-aligned across divisions).
    const nationalCandidates: string[] = [];
    const nationalTotals: number[] = [];
    let nationalVotes = 0;
    let nationalRegistered = 0;
    for (const div of divisions) {
      nationalVotes += div.totalVotes;
      nationalRegistered += div.registeredVoters;
      div.candidates.forEach((name, idx) => {
        if (!nationalCandidates[idx]) nationalCandidates[idx] = name;
        nationalTotals[idx] = (nationalTotals[idx] ?? 0) + (div.voteCounts[idx] ?? 0);
      });
    }

    return NextResponse.json({
      chainId: CHAIN_ID,
      registry: registry.address,
      divisionCount: divisions.length,
      national: {
        candidates: nationalCandidates,
        totals: nationalTotals,
        totalVotes: nationalVotes,
        registeredVoters: nationalRegistered,
        turnout: nationalRegistered > 0 ? nationalVotes / nationalRegistered : 0,
      },
      divisions,
    });
  } catch (error) {
    console.error("[/api/election] error:", error);
    return NextResponse.json({ error: "Failed to read election state from chain" }, { status: 500 });
  }
}
