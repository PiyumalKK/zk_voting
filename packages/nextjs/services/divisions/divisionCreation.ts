import { parseAbiItem, parseEventLogs } from "viem";
import deployedContracts from "~~/contracts/deployedContracts";
import { createServerPublicClient } from "~~/services/auth/relayContracts";
import { executeRelayCall } from "~~/services/auth/relayExecutor";
import type { SessionData } from "~~/services/auth/session";
import { serverChainConfig } from "~~/utils/serverChain";

/**
 * The one place a division is created on-chain via the relay — extracted so
 * the bulk route (`POST /api/divisions/bulk`) can create many without
 * duplicating the create-then-authorise sequence `AddDivisionSection`
 * otherwise runs client-side, one `write()` call at a time.
 *
 * Only used in custom-chain mode: hardhat mode has no server-held admin key
 * to sign with, so the manual "Add Division" form keeps using MetaMask via
 * `useElectionWriter` there, unchanged.
 */

const DIVISION_CREATED_EVENT = parseAbiItem(
  "event DivisionCreated(uint256 indexed divisionId, string name, address votingContract)",
);

type DeployedEntry = { address: `0x${string}`; abi: readonly unknown[] };

const deployedEntry = (chainId: number, name: string): DeployedEntry | undefined =>
  (deployedContracts as unknown as Record<number, Record<string, DeployedEntry>>)[chainId]?.[name];

export interface CreateDivisionResult {
  name: string;
  /** Absent only when the address could not be read back from the receipt. */
  votingContract?: `0x${string}`;
  /** Whether `NicRegistry.setVotingContract` succeeded, so GN enrolment works. */
  authorised: boolean;
  /**
   * Set when the division exists but authorisation (or address read-back)
   * failed. A sentence fragment meant to follow "Created, but " — see the
   * bulk route, which prefixes it that way for the results table.
   */
  assignError?: string;
}

export class CreateDivisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreateDivisionError";
  }
}

const MAX_NAME_LENGTH = 128;

/**
 * How "do these two division names collide" is decided — case-insensitive,
 * trimmed. `ElectionRegistry.createDivision` has no uniqueness check of its
 * own (it just pushes a new struct), so nothing on-chain stops two divisions
 * named "Kaduwela" and "kaduwela" from both existing; this is the app-level
 * gate instead.
 *
 * `AddDivisionSection` (manual, client-side) applies the identical rule
 * against `useDivisions()`'s live list with its own copy of this one-liner
 * rather than importing it from here — this module reaches `node:fs`
 * transitively (via `relayExecutor` → the account/audit stores), which a
 * "use client" component cannot pull into the browser bundle.
 */
export const normaliseDivisionName = (name: string): string => name.trim().toLowerCase();

/**
 * Creates one division: deploys it via `ElectionRegistry.createDivision`,
 * reads the new `votingContract` address back from the receipt, then
 * authorises it in `NicRegistry` — the same two-transaction sequence
 * `AddDivisionSection.handleCreateDivision` runs client-side.
 *
 * Mirrors `createGnOfficerAccount`'s "don't lose the first half on a second
 * failure" behaviour: if authorisation fails, the division still exists and
 * is returned (unauthorised) rather than thrown, so a 10,000-row import
 * doesn't lose 9,999 good divisions because one authorisation call reverted.
 *
 * @param existingNames - Normalised (`normaliseDivisionName`) names already on
 * the registry, plus anything already created earlier in the same batch — the
 * caller is responsible for adding each success to the set before the next
 * call, since a fresh on-chain read per row would be needless latency at
 * import scale.
 */
export const createDivisionOnChain = async (
  rawName: string,
  session: SessionData,
  existingNames: ReadonlySet<string> = new Set(),
): Promise<CreateDivisionResult> => {
  const name = rawName.trim();
  if (!name) throw new CreateDivisionError("Division name is required.");
  if (name.length > MAX_NAME_LENGTH) {
    throw new CreateDivisionError(`Division name exceeds the ${MAX_NAME_LENGTH}-character limit.`);
  }
  if (existingNames.has(normaliseDivisionName(name))) {
    throw new CreateDivisionError(`A division named "${name}" already exists.`);
  }

  const { chainId } = serverChainConfig;
  const registry = deployedEntry(chainId, "ElectionRegistry");
  if (!registry?.address) {
    throw new CreateDivisionError(`ElectionRegistry is not deployed on chain ${chainId}.`);
  }

  const createOutcome = await executeRelayCall({
    session,
    request: { target: registry.address, fn: "createDivision", args: [name] },
  });
  if (!createOutcome.ok) {
    throw new CreateDivisionError(createOutcome.errorName ?? createOutcome.error);
  }

  let votingContract: `0x${string}` | undefined;
  try {
    const publicClient = createServerPublicClient();
    const receipt = await publicClient.getTransactionReceipt({ hash: createOutcome.txHash });
    const created = parseEventLogs({ abi: [DIVISION_CREATED_EVENT], logs: receipt.logs }) as unknown as {
      args: { votingContract: `0x${string}` };
    }[];
    votingContract = created[0]?.args?.votingContract;
  } catch {
    votingContract = undefined;
  }

  if (!votingContract) {
    return {
      name,
      authorised: false,
      assignError: "its address could not be read back, so it was not authorised for GN enrolment.",
    };
  }

  const nicRegistry = deployedEntry(chainId, "NicRegistry");
  if (!nicRegistry?.address) {
    return {
      name,
      votingContract,
      authorised: false,
      assignError: "NicRegistry is not deployed, so it was not authorised.",
    };
  }

  const authOutcome = await executeRelayCall({
    session,
    request: { target: nicRegistry.address, fn: "setVotingContract", args: [votingContract, true] },
  });

  return {
    name,
    votingContract,
    authorised: authOutcome.ok,
    assignError: authOutcome.ok
      ? undefined
      : `authorising it for GN enrolment failed: ${authOutcome.errorName ?? authOutcome.error}`,
  };
};
