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
 *                                  of asking them to pick one. Additionally
 *                                  reports that device's standing in the
 *                                  NicRegistry — see `voterDevice` below.
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

const NIC_REGISTRY_ABI = [
  {
    name: "getDeviceStatus",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "device", type: "address" }],
    outputs: [
      { name: "status", type: "uint8" },
      { name: "nicHash", type: "bytes32" },
    ],
  },
  {
    name: "getEnrolment",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "nicHash", type: "bytes32" }],
    outputs: [
      { name: "votingContract", type: "address" },
      { name: "device", type: "address" },
      { name: "committed", type: "bool" },
      { name: "issueCount", type: "uint32" },
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
  { name: "getGNOfficers", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
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
  /** @deprecated kept for existing clients; use `gnOfficers`. First assigned officer, or the zero address. */
  gnOfficer: string;
  /** Every address currently authorised as a GN officer for this division. */
  gnOfficers: string[];
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

/**
 * A device's standing in the shared NicRegistry, for `?voter=`.
 *
 * Top-level rather than per-division, because the binding is global: a device is
 * bound to one NIC, which is enrolled in one division.
 *
 * This exists so the voter app can tell three very different situations apart
 * *before* the voter tries to register and is refused:
 *
 * - `unbound`     — never enrolled against a NIC (or added by bulk allowlist).
 * - `live`        — the device currently issued for its NIC.
 * - `superseded`  — replaced by a later re-issue. This phone can never register,
 *                   and saying so up front is much kinder than letting them
 *                   authenticate, generate a commitment and then fail.
 *
 * `nicRegistered` reports whether the *person* behind the device already has a
 * leaf, which `voterRegistered` cannot express once a device has been replaced.
 *
 * The nicHash itself is deliberately **not** returned. It is an HMAC under a
 * server-held pepper and nothing outside the server should be able to build an
 * address → NIC map from a public endpoint.
 */
interface VoterDeviceState {
  status: "unbound" | "live" | "superseded";
  /** Whether this device's NIC has already registered, on any division. */
  nicRegistered: boolean;
}

const DEVICE_STATUS_LABELS = ["unbound", "live", "superseded"] as const;

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

    // The device's standing in the shared registry. One extra pair of reads,
    // only when an address was asked about, and a failure here must not take the
    // whole election payload down with it — a registry deployed before device
    // binding existed simply has no such function.
    const voterDevice: VoterDeviceState | null = voter ? await readVoterDevice(client, voter) : null;

    const divisions: DivisionState[] = await Promise.all(
      rawDivisions
        .filter(d => !filter || d.votingContract.toLowerCase() === filter)
        .map(async (d): Promise<DivisionState> => {
          try {
            const [votingData, candidates, voteCounts, gnOfficers, voterData] = await Promise.all([
              client.readContract({ address: d.votingContract, abi: VOTING_ABI, functionName: "getVotingData" }),
              client.readContract({ address: d.votingContract, abi: VOTING_ABI, functionName: "getCandidates" }),
              client.readContract({ address: d.votingContract, abi: VOTING_ABI, functionName: "getVoteCounts" }),
              client.readContract({ address: d.votingContract, abi: VOTING_ABI, functionName: "getGNOfficers" }),
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
            const officers = gnOfficers as string[];
            return {
              name: d.name,
              votingContract: d.votingContract,
              gnOfficer: officers[0] ?? "0x0000000000000000000000000000000000000000",
              gnOfficers: officers,
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
              gnOfficers: d.gnOfficer !== "0x0000000000000000000000000000000000000000" ? [d.gnOfficer] : [],
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
      ...(voterDevice ? { voterDevice } : {}),
    });
  } catch (error) {
    console.error("[/api/election] error:", error);
    return NextResponse.json({ error: "Failed to read election state from chain" }, { status: 500 });
  }
}

/**
 * Read one device's standing in the shared NicRegistry.
 *
 * Returns null rather than throwing on any failure — no NicRegistry deployed on
 * this chain, a registry predating device binding, an RPC hiccup. This is
 * supplementary information; losing it must not turn a working election payload
 * into a 500, and the voter app treats its absence as "nothing special to say".
 */
async function readVoterDevice(
  client: ReturnType<typeof createPublicClient>,
  voter: `0x${string}`,
): Promise<VoterDeviceState | null> {
  const nicRegistry = (deployedContracts as Record<number, any>)[CHAIN_ID]?.NicRegistry;
  if (!nicRegistry?.address) return null;

  try {
    const [statusIndex, nicHash] = (await client.readContract({
      address: nicRegistry.address as `0x${string}`,
      abi: NIC_REGISTRY_ABI,
      functionName: "getDeviceStatus",
      args: [voter],
    })) as [number, `0x${string}`];

    const status = DEVICE_STATUS_LABELS[Number(statusIndex)] ?? "unbound";
    if (status === "unbound") return { status, nicRegistered: false };

    // Only now is a second read worth making: an unbound device has no NIC whose
    // registration could be looked up.
    const enrolment = (await client.readContract({
      address: nicRegistry.address as `0x${string}`,
      abi: NIC_REGISTRY_ABI,
      functionName: "getEnrolment",
      args: [nicHash],
    })) as readonly [string, string, boolean, number];

    return { status, nicRegistered: Boolean(enrolment[2]) };
  } catch (error) {
    console.error("[/api/election] voterDevice read failed:", error);
    return null;
  }
}
