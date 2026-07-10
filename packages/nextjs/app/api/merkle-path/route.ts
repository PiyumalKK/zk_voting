import { NextRequest, NextResponse } from "next/server";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon2 } from "poseidon-lite";
import { createPublicClient, http, parseAbiItem } from "viem";

/**
 * GET /api/merkle-path?division=<votingContract>&commitment=<value>
 *
 * Rebuilds the division's Merkle tree from its on-chain `NewLeaf` events and
 * returns the inclusion proof (siblings + circuit index + root) for the given
 * commitment. The native voter app combines these siblings with its locally
 * held nullifier/secret to generate the ZK proof.
 *
 * IMPORTANT: this mirrors the exact client-side algorithm in GenerateProof.tsx
 * (LeanIMT + poseidon2, brute-forced circuit index for Noir compatibility,
 * siblings padded to length 16). The server sees only PUBLIC data (commitments),
 * never nullifiers, secrets or keys.
 */

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const CIRCUIT_DEPTH = 16;

const VOTING_DATA_ABI = [
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
] as const;

const NEW_LEAF_EVENT = parseAbiItem("event NewLeaf(uint256 index, uint256 value)");

export async function GET(req: NextRequest) {
  try {
    const division = req.nextUrl.searchParams.get("division");
    const commitmentParam = req.nextUrl.searchParams.get("commitment");

    if (!division || !/^0x[0-9a-fA-F]{40}$/.test(division)) {
      return NextResponse.json({ error: "Missing or invalid `division` contract address" }, { status: 400 });
    }
    if (!commitmentParam) {
      return NextResponse.json({ error: "Missing `commitment` query parameter" }, { status: 400 });
    }

    let commitment: bigint;
    try {
      commitment = BigInt(commitmentParam);
    } catch {
      return NextResponse.json({ error: "`commitment` must be a decimal or 0x-hex integer" }, { status: 400 });
    }

    const client = createPublicClient({ transport: http(RPC_URL) });
    const votingContract = division as `0x${string}`;

    // Current election tree size — the current election owns the last `treeSize` leaves.
    const votingData = (await client.readContract({
      address: votingContract,
      abi: VOTING_DATA_ABI,
      functionName: "getVotingData",
    })) as readonly unknown[];
    const treeSize = Number(votingData[5]);

    if (treeSize === 0) {
      return NextResponse.json({ error: "No voters registered in this division yet" }, { status: 404 });
    }

    // Pull all NewLeaf events, keep the current election's leaves (last `treeSize`),
    // ordered by the emitted leaf index ascending (oldest-first) to rebuild the tree.
    const logs = await client.getLogs({
      address: votingContract,
      event: NEW_LEAF_EVENT,
      fromBlock: 0n,
      toBlock: "latest",
    });

    const currentLeaves = logs
      .slice(-treeSize)
      .map(l => ({ index: Number(l.args.index), value: l.args.value as bigint }))
      .sort((a, b) => a.index - b.index)
      .map(l => l.value);

    if (currentLeaves.length !== treeSize) {
      return NextResponse.json({ error: "Leaf event count does not match on-chain tree size" }, { status: 500 });
    }

    // Rebuild the LeanIMT exactly as the client does.
    const tree = new LeanIMT((a: bigint, b: bigint) => poseidon2([a, b]));
    tree.insertMany(currentLeaves);

    const leafIndex = currentLeaves.findIndex(v => v === commitment);
    if (leafIndex === -1) {
      return NextResponse.json({ error: "Commitment not found in this division's tree" }, { status: 404 });
    }

    const proof = tree.generateProof(leafIndex);
    const siblings = proof.siblings.map(s => (s as bigint).toString());
    const siblingsBig = proof.siblings as bigint[];

    // Brute-force the circuit index that reproduces the root (LeanIMT ↔ Noir binary tree).
    const siblingsNum = siblingsBig.length;
    const maxIndex = 1 << siblingsNum;
    let circuitIndex = -1;
    for (let cIndex = 0; cIndex < maxIndex; cIndex++) {
      let current = commitment;
      for (let i = 0; i < siblingsNum; i++) {
        const isRight = (cIndex >> i) & 1;
        const sibling = siblingsBig[i];
        current = isRight ? poseidon2([sibling, current]) : poseidon2([current, sibling]);
      }
      if (current === proof.root) {
        circuitIndex = cIndex;
        break;
      }
    }

    if (circuitIndex === -1) {
      return NextResponse.json({ error: "Could not derive a valid circuit index" }, { status: 500 });
    }

    // Pad siblings to the fixed circuit length of 16.
    const paddedSiblings = [...siblings];
    while (paddedSiblings.length < CIRCUIT_DEPTH) paddedSiblings.push("0");

    return NextResponse.json({
      division: votingContract,
      commitment: commitment.toString(),
      leafIndex,
      circuitIndex,
      depth: siblingsNum,
      root: (proof.root as bigint).toString(),
      siblings: paddedSiblings,
      treeSize,
    });
  } catch (error) {
    console.error("[/api/merkle-path] error:", error);
    return NextResponse.json({ error: "Failed to build Merkle path" }, { status: 500 });
  }
}
