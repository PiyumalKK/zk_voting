import type { LiveDivision } from "~~/hooks/useDivisions";

/**
 * The two ways to answer "which division does this officer run?", as pure
 * functions.
 *
 * They live outside `hooks/useDivisions.ts` because that module pulls in the
 * whole wagmi/scaffold read stack, and the identity rules deserve to be
 * testable without it.
 */

/** Hardhat: the division whose on-chain GN officers include this wallet address. */
export const findDivisionForGN = (divisions: readonly LiveDivision[], address?: string): LiveDivision | undefined => {
  if (!address) return undefined;
  return divisions.find(division => division.gnOfficers.some(gn => gn.toLowerCase() === address.toLowerCase()));
};

/** Custom chain: the division named by the session's `divisionId`. */
export const findDivisionById = (
  divisions: readonly LiveDivision[],
  divisionId: number | undefined,
): LiveDivision | undefined =>
  divisionId === undefined ? undefined : divisions.find(division => division.id === divisionId);
