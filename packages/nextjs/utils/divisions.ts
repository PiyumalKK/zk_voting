/**
 * Division configuration — STATIC FALLBACK ONLY.
 *
 * ⚠️ This is NOT the source of truth. The live source of truth is on-chain:
 *   - Which divisions exist   → ElectionRegistry.getAllDivisions()
 *   - Who the GN officer is    → each Voting contract's s_gnOfficer()
 *   - Phase / tree size / root → each Voting contract's getVotingData()
 *
 * Use the `useDivisions()` hook (hooks/useDivisions.ts) everywhere in the UI.
 * This file only provides deterministic Hardhat addresses for tooling / fallback
 * and must mirror the deploy script (deploy/01_deploy_divisions.ts).
 */

export interface Division {
  id: number;
  name: string;
  votingContract: `0x${string}`;
  gnOfficer: `0x${string}`;
}

// Deterministic Hardhat addresses — must match deploy/01_deploy_divisions.ts.
export const DIVISIONS: Division[] = [
  {
    id: 0,
    name: "Kaduwela",
    votingContract: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
    gnOfficer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // Hardhat account #1 (deploy default)
  },
  {
    id: 1,
    name: "Colombo Central",
    votingContract: "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6",
    gnOfficer: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", // Hardhat account #2 (deploy default)
  },
  {
    id: 2,
    name: "Gampaha",
    votingContract: "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e",
    gnOfficer: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", // Hardhat account #3 (deploy default)
  },
];

export const ELECTION_REGISTRY_ADDRESS: `0x${string}` = "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9";

// The "original" single Voting contract (for backwards-compat with existing voter UI)
export const DEFAULT_VOTING_CONTRACT: `0x${string}` = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";

/**
 * Static fallback lookup. Prefer the on-chain `useDivisions()` hook + `findDivisionForGN`.
 */
export function getDivisionForGN(gnAddress: string): Division | undefined {
  return DIVISIONS.find(d => d.gnOfficer.toLowerCase() === gnAddress.toLowerCase());
}

/**
 * Get a division by ID (static fallback).
 */
export function getDivisionById(id: number): Division | undefined {
  return DIVISIONS.find(d => d.id === id);
}
