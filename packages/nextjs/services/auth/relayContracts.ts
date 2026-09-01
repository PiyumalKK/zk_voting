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
 * Reads every division from the registry, with its live GN officer.
 *
 * Inactive divisions are kept: an admin still needs to be able to act on one
 * (to reactivate it, for instance), and the whitelist — not this list — is
 * what decides which calls are permitted.
 */
export const loadDivisions = async (client: PublicClient = createServerPublicClient()): Promise<DivisionSummary[]> => {
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
