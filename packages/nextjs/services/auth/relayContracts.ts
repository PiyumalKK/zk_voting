import { createPublicClient, http } from "viem";
import type { Abi, PublicClient } from "viem";
import deployedContracts from "~~/contracts/deployedContracts";
import type { KnownContract } from "~~/services/auth/relayPolicy";
import { serverChainConfig } from "~~/utils/serverChain";

/**
 * Server-side resolution of the contracts the relay is allowed to address.
 *
 * The relay must never take a target address on trust from the browser, so
 * every address it will sign for is derived here: the two registries come from
 * `deployedContracts.ts` (per chain id — the same contract has different
 * addresses on 31337 and 9494), and the division `Voting` contracts come from
 * `ElectionRegistry.getAllDivisions()` on the live chain, because
 * `createDivision()` deploys new ones at runtime and no static file can know
 * about them.
 */

export interface DivisionSummary {
  /** Index in `getAllDivisions()` — the `divisionId` carried in a GN session. */
  id: number;
  name: string;
  votingContract: `0x${string}`;
  /**
   * Authoritative GN officers, read from the Voting contract rather than the
   * registry's stored copy: `setGNOfficer` updates the Voting contract only, so
   * the registry's field goes stale. Same reasoning as `hooks/useDivisions.ts`.
   * A division may have more than one officer at once.
   */
  gnOfficers: readonly `0x${string}`[];
  active: boolean;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class RelayContractsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayContractsError";
  }
}

const REGISTRY_DIVISIONS_ABI = [
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

const VOTING_GN_ABI = [
  {
    name: "getGNOfficers",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
] as const;

type DeployedEntry = { address: `0x${string}`; abi: Abi };

const deployedEntry = (chainId: number, name: string): DeployedEntry | undefined =>
  (deployedContracts as unknown as Record<number, Record<string, DeployedEntry>>)[chainId]?.[name];

export const createServerPublicClient = (): PublicClient =>
  createPublicClient({ transport: http(serverChainConfig.rpcUrl) }) as PublicClient;

/**
 * `loadDivisions()` reads every division from the registry, then does one
 * more on-chain read *per division* for its live GN officer list — O(N) reads
 * for one call. `executeRelayCall` (the sole path behind `POST /api/relay`)
 * calls it fresh on every request with no caching, and an "apply to all N
 * divisions" admin action fires N sequential relay requests — so at scale
 * that's O(N) calls each paying an O(N) cost, or O(N²) reads overall. At a
 * few thousand divisions that's millions of reads in a tight sequential
 * burst, which is what overwhelmed the chain (see the 2026-09 "apply ballot
 * question to 1000+ divisions" incident).
 *
 * The fix is this short cache, not a bigger rewrite: every caller already
 * reads the list once per request and moves on (none of the seven call sites
 * loop calling `loadDivisions()` per row), so a few-second cache changes
 * nothing for a normal single call — it only collapses the redundant reads
 * *within* a rapid-fire burst like the one above. `TTL_MS` is deliberately
 * short: a division created or a GN officer reassigned during the window is
 * invisible to the relay for at most that long, which is a smaller staleness
 * window than the client's own 15s division poll already tolerates.
 */
const DIVISIONS_CACHE_TTL_MS = 5_000;
let divisionsCache: { data: DivisionSummary[]; expiresAt: number } | null = null;
let divisionsInFlight: Promise<DivisionSummary[]> | null = null;

const readDivisionsFromChain = async (client: PublicClient): Promise<DivisionSummary[]> => {
  const registry = deployedEntry(serverChainConfig.chainId, "ElectionRegistry");
  if (!registry?.address) {
    throw new RelayContractsError(
      `ElectionRegistry is not deployed on chain ${serverChainConfig.chainId}. Run \`yarn deploy\` for this chain.`,
    );
  }

  const divisions = (await client.readContract({
    address: registry.address,
    abi: REGISTRY_DIVISIONS_ABI,
    functionName: "getAllDivisions",
  })) as readonly { name: string; votingContract: `0x${string}`; gnOfficer: `0x${string}`; active: boolean }[];

  return Promise.all(
    divisions.map(async (division, id) => {
      let gnOfficers: readonly `0x${string}`[] = division.gnOfficer !== ZERO_ADDRESS ? [division.gnOfficer] : [];
      try {
        gnOfficers = (await client.readContract({
          address: division.votingContract,
          abi: VOTING_GN_ABI,
          functionName: "getGNOfficers",
        })) as readonly `0x${string}`[];
      } catch {
        // Fall back to the registry's stale copy: a division whose Voting
        // contract is unreachable should not take the whole relay down, and
        // the whitelist still refuses anything the caller is not scoped to.
      }
      return { id, name: division.name, votingContract: division.votingContract, gnOfficers, active: division.active };
    }),
  );
};

/**
 * Reads every division from the registry, with its live GN officer.
 *
 * Inactive divisions are kept: an admin still needs to be able to act on one
 * (to reactivate it, for instance), and the whitelist — not this list — is
 * what decides which calls are permitted.
 */
export const loadDivisions = async (client: PublicClient = createServerPublicClient()): Promise<DivisionSummary[]> => {
  const now = Date.now();
  if (divisionsCache && divisionsCache.expiresAt > now) return divisionsCache.data;
  if (divisionsInFlight) return divisionsInFlight;

  divisionsInFlight = readDivisionsFromChain(client)
    .then(data => {
      divisionsCache = { data, expiresAt: Date.now() + DIVISIONS_CACHE_TTL_MS };
      return data;
    })
    .finally(() => {
      divisionsInFlight = null;
    });

  return divisionsInFlight;
};

/**
 * Drops the cached division list so the next `loadDivisions()` call re-reads
 * the chain immediately. Exported for tests; production code relies on the
 * short TTL rather than calling this, since invalidating it from every write
 * path would be the larger, riskier change this fix deliberately avoids.
 */
export const clearDivisionsCache = () => {
  divisionsCache = null;
  divisionsInFlight = null;
};

/**
 * Builds the address → (kind, ABI) table the policy matches against.
 *
 * Every division shares the `Voting` ABI: they are instances of one contract
 * deployed by the registry factory, which is exactly why the node never needed
 * to know about `Voting.sol` (MASTER §1).
 */
export const buildKnownContracts = (divisions: readonly DivisionSummary[]): KnownContract[] => {
  const { chainId } = serverChainConfig;
  const known: KnownContract[] = [];

  const registry = deployedEntry(chainId, "ElectionRegistry");
  if (registry?.address) known.push({ kind: "ElectionRegistry", address: registry.address, abi: registry.abi });

  const nicRegistry = deployedEntry(chainId, "NicRegistry");
  if (nicRegistry?.address) known.push({ kind: "NicRegistry", address: nicRegistry.address, abi: nicRegistry.abi });

  const votingAbi = deployedEntry(chainId, "Voting")?.abi;
  if (!votingAbi && divisions.length > 0) {
    // Without this, every division call would be refused as "unknown address"
    // and the real cause — a deployment record missing for this chain id —
    // would take a long debugging session to find.
    throw new RelayContractsError(
      `No Voting ABI recorded for chain ${chainId} in deployedContracts.ts. Re-run \`yarn deploy\` for this chain.`,
    );
  }
  for (const division of divisions) {
    known.push({ kind: "Voting", address: division.votingContract, abi: votingAbi! });
  }

  return known;
};
