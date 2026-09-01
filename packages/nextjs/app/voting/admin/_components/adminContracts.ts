import { parseAbiItem } from "viem";

/**
 * The narrow ABIs and event signatures the admin panels write against.
 *
 * Shared by the panels that were split out of `page.tsx` when the admin area
 * became three routes. Kept narrow deliberately: the hardhat path encodes
 * calldata from whatever ABI it is handed, so a smaller surface is a smaller
 * mistake. The custom path ignores them entirely and uses the deployed ABI
 * server-side.
 */

export const SET_GN_OFFICER_ABI = [
  {
    name: "setGNOfficer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_gnOfficer", type: "address" },
      { name: "_isOfficer", type: "bool" },
    ],
    outputs: [],
  },
] as const;

/**
 * Authorises a division's Voting contract for NIC enrolment.
 *
 * `NicRegistry.reserveNicHash` refuses any contract that was never passed to
 * this function ("Unregistered division"), and `ElectionRegistry.createDivision`
 * cannot call it — the registry holds no reference to `NicRegistry`, and this is
 * owner-only. So a division created at runtime needs this as a second step, and
 * the Add Division panel makes it. See `packages/hardhat/test/DivisionEnrolment.ts`.
 */
export const SET_VOTING_CONTRACT_ABI = [
  {
    name: "setVotingContract",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_votingContract", type: "address" },
      { name: "_authorized", type: "bool" },
    ],
    outputs: [],
  },
] as const;

/**
 * Empties the division registry.
 *
 * Half of "start a new election": `Voting.resetElection` clears one division's
 * ballot, but the registry is what makes a division *exist* anywhere in the app,
 * so a genuinely fresh election has to drop the list itself. The old Voting
 * contracts stay deployed and simply stop being referenced.
 */
export const CLEAR_DIVISIONS_ABI = [
  { name: "clearDivisions", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

/**
 * Releases every reserved NIC hash.
 *
 * The other half: `NicRegistry` refuses a NIC that has already been enrolled,
 * and that record outlives the divisions. Without this, a new election would
 * reject every citizen who voted in the previous one.
 */
export const CLEAR_NIC_HASHES_ABI = [
  { name: "clearNicHashes", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

/** Emitted by `setVotingContract` — the only way to read authorisation back. */
export const VOTING_CONTRACT_UPDATED_EVENT = parseAbiItem(
  "event VotingContractUpdated(address indexed votingContract, bool authorized)",
);

/** Emitted by `createDivision`, and how the Add Division panel learns the new address. */
export const DIVISION_CREATED_EVENT = parseAbiItem(
  "event DivisionCreated(uint256 indexed divisionId, string name, address votingContract)",
);

export type VoterEntry = { address: string; status: boolean };

/** Convert "hh:mm:ss" or "mm:ss" or a raw seconds string to seconds. */
export function parseDurationToSeconds(raw: string): bigint | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const n = BigInt(trimmed);
    return n > 0n ? n : null;
  }
  const parts = trimmed.split(":").map(p => p.trim());
  if (parts.some(p => !/^\d+$/.test(p))) return null;
  let mult = 1;
  let total = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    total += Number(parts[i]) * mult;
    mult *= 60;
  }
  return total > 0 ? BigInt(total) : null;
}
