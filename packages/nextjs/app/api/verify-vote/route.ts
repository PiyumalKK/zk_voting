import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, parseAbiItem } from "viem";

/**
 * GET /api/verify-vote?division=0x...&nullifierHash=0x...
 *
 * Checks whether a given nullifier hash was used (i.e. vote was counted) in the
 * specified division contract. If found, also returns the candidate the vote
 * counted for by scanning VoteCast events.
 *
 * This is a privacy-preserving verification: the nullifier hash is already
 * public (emitted in VoteCast events) and cannot be linked back to the voter's
 * identity.
 */

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";

const IS_NULLIFIER_USED_ABI = [
  {
    name: "isNullifierUsed",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_nullifierHash", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    name: "getCandidates",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string[]" }],
  },
] as const;

const VOTE_CAST_EVENT = parseAbiItem(
  "event VoteCast(bytes32 indexed nullifierHash, address indexed voter, uint256 indexed candidate, uint256 timestamp, uint256 newCount)",
);

export async function GET(req: NextRequest) {
  try {
    const division = req.nextUrl.searchParams.get("division");
    const nullifierHash = req.nextUrl.searchParams.get("nullifierHash");

    if (!division || !nullifierHash) {
      return NextResponse.json({ error: "Missing required query params: division, nullifierHash" }, { status: 400 });
    }

    const divisionAddr = division as `0x${string}`;
    const nhBytes = nullifierHash as `0x${string}`;

    const client = createPublicClient({ transport: http(RPC_URL) });

    // 1. Check if nullifier hash was used on-chain
    const used = await client.readContract({
      address: divisionAddr,
      abi: IS_NULLIFIER_USED_ABI,
      functionName: "isNullifierUsed",
      args: [nhBytes],
    });

    if (!used) {
      return NextResponse.json({ found: false });
    }

    // 2. Get candidate names
    const candidates = (await client.readContract({
      address: divisionAddr,
      abi: IS_NULLIFIER_USED_ABI,
      functionName: "getCandidates",
    })) as string[];

    // 3. Find the VoteCast event with this nullifier hash to get the candidate index
    const logs = await client.getLogs({
      address: divisionAddr,
      event: VOTE_CAST_EVENT,
      args: { nullifierHash: nhBytes },
      fromBlock: 0n,
      toBlock: "latest",
    });

    if (logs.length > 0) {
      const log = logs[0];
      const candidateIdx = Number(log.args.candidate ?? 0);
      const candidateName = candidates[candidateIdx] ?? `Candidate #${candidateIdx}`;
      return NextResponse.json({
        found: true,
        candidate: candidateName,
        candidateIndex: candidateIdx,
        blockNumber: Number(log.blockNumber),
        timestamp: Number(log.args.timestamp ?? 0),
      });
    }

    // Nullifier is marked used but no event found (edge case)
    return NextResponse.json({ found: true, candidate: null, candidateIndex: null });
  } catch (error) {
    console.error("[/api/verify-vote] error:", error);
    return NextResponse.json({ error: "Failed to verify vote on chain" }, { status: 500 });
  }
}
