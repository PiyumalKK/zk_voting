import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import deployedContracts from "~~/contracts/deployedContracts";
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
] as const;

const PHASE_LABELS = ["Setup", "Registration", "Voting", "Ended"] as const;

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

    const divisions: DivisionState[] = await Promise.all(
      rawDivisions
        .filter(d => !filter || d.votingContract.toLowerCase() === filter)
        .map(async (d): Promise<DivisionState> => {
          try {
            const [votingData, candidates, voteCounts, gn] = await Promise.all([
              client.readContract({ address: d.votingContract, abi: VOTING_ABI, functionName: "getVotingData" }),
              client.readContract({ address: d.votingContract, abi: VOTING_ABI, functionName: "getCandidates" }),
              client.readContract({ address: d.votingContract, abi: VOTING_ABI, functionName: "getVoteCounts" }),
              client.readContract({ address: d.votingContract, abi: VOTING_ABI, functionName: "s_gnOfficer" }),
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
