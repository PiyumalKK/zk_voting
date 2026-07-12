import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, getAddress, http, verifyMessage } from "viem";
import deployedContracts from "~~/contracts/deployedContracts";
import { canonicalizeNic, hashNic } from "~~/services/nic/nicHash";

const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337);
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const SIGNATURE_MAX_AGE_MS = 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;

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
  { name: "s_gnOfficer", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

type RateLimitRecord = { count: number; windowStartedAt: number };

const rateLimits: Map<string, RateLimitRecord> =
  (globalThis as typeof globalThis & { __slVoteNicHashRateLimits?: Map<string, RateLimitRecord> })
    .__slVoteNicHashRateLimits ??
  ((
    globalThis as typeof globalThis & { __slVoteNicHashRateLimits?: Map<string, RateLimitRecord> }
  ).__slVoteNicHashRateLimits = new Map());
// TODO: Replace this process-local rate limiter with Redis/KV storage and expiry before production.

function buildSignedMessage(canonicalNic: string, timestamp: string): string {
  return `SL Vote NIC hash\n${timestamp}\n${canonicalNic}`;
}

function isRateLimited(address: string): boolean {
  const now = Date.now();
  const record = rateLimits.get(address);
  if (!record || now - record.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(address, { count: 1, windowStartedAt: now });
    return false;
  }
  record.count += 1;
  return record.count > RATE_LIMIT_MAX_REQUESTS;
}

async function isAuthorizedGn(address: `0x${string}`): Promise<boolean> {
  const registry = (deployedContracts as Record<number, any>)[CHAIN_ID]?.ElectionRegistry;
  if (!registry?.address) return false;

  const client = createPublicClient({ transport: http(RPC_URL) });
  const divisions = (await client.readContract({
    address: registry.address as `0x${string}`,
    abi: REGISTRY_ABI,
    functionName: "getAllDivisions",
  })) as readonly { votingContract: `0x${string}`; active: boolean }[];

  const officers = await Promise.all(
    divisions
      .filter(division => division.active)
      .map(division =>
        client.readContract({
          address: division.votingContract,
          abi: VOTING_ABI,
          functionName: "s_gnOfficer",
        }),
      ),
  );
  return officers.some(officer => (officer as string).toLowerCase() === address.toLowerCase());
}

export async function POST(req: NextRequest) {
  const pepper = process.env.SERVER_PEPPER;
  if (!pepper) {
    return NextResponse.json({ error: "NIC hashing service is not configured" }, { status: 503 });
  }

  let nic: unknown;
  try {
    ({ nic } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof nic !== "string") {
    return NextResponse.json({ error: "`nic` is required" }, { status: 400 });
  }

  const canonicalNic = canonicalizeNic(nic);
  if (!canonicalNic) {
    return NextResponse.json({ error: "Invalid NIC format" }, { status: 400 });
  }

  const timestamp = req.headers.get("x-gn-timestamp");
  const signature = req.headers.get("x-gn-signature");
  const claimedAddress = req.headers.get("x-gn-address");
  if (!timestamp || !signature || !claimedAddress) {
    return NextResponse.json({ error: "GN authentication is required" }, { status: 401 });
  }

  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > SIGNATURE_MAX_AGE_MS) {
    return NextResponse.json({ error: "GN authentication has expired" }, { status: 401 });
  }

  let gnAddress: `0x${string}`;
  try {
    gnAddress = getAddress(claimedAddress) as `0x${string}`;
    const signatureIsValid = await verifyMessage({
      address: gnAddress,
      message: buildSignedMessage(canonicalNic, timestamp),
      signature: signature as `0x${string}`,
    });
    if (!signatureIsValid) {
      return NextResponse.json({ error: "Invalid GN authentication" }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid GN authentication" }, { status: 401 });
  }

  if (isRateLimited(gnAddress)) {
    return NextResponse.json({ error: "Too many NIC hash requests. Please wait and try again." }, { status: 429 });
  }

  try {
    if (!(await isAuthorizedGn(gnAddress))) {
      return NextResponse.json({ error: "GN authorization is required" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Unable to verify GN authorization" }, { status: 503 });
  }

  return NextResponse.json({ nicHash: hashNic(canonicalNic, pepper) });
}
