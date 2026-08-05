"use client";

import { useAccount } from "wagmi";
import { LiveDivision, useDivisions } from "~~/hooks/useDivisions";
import { useElectionAuth } from "~~/hooks/useElectionAuth";
import { ChainMode, getChainMode } from "~~/utils/chainMode";
import { findDivisionById, findDivisionForGN } from "~~/utils/gnDivision";

/**
 * "Which division am I the GN for?" — asked the right way for each backend.
 *
 * The two modes answer it from different evidence and neither can stand in for
 * the other:
 *
 * - **hardhat**: from the connected wallet. The division whose on-chain
 *   `s_gnOfficer` equals the connected address, exactly as before M12.
 * - **custom**: from the session. The officer's `divisionId` is carried in the
 *   signed cookie, and the division is looked up by index.
 *
 * The custom path deliberately does **not** cross-check the division's
 * `gnOfficer` against the account's address before rendering the portal. That
 * check belongs on the server, where it is enforced for every action that
 * matters — the relay's GN scoping and `/api/nic/hash` both do it. Duplicating
 * it here would only mean the UI disagrees with the server during the window
 * between account creation and `setGNOfficer` landing on chain.
 */

export interface GnDivisionState {
  mode: ChainMode;
  division: LiveDivision | null;
  /** True while either the identity or the on-chain division list is still resolving. */
  isLoading: boolean;
  /** Chain read failure, not an authorization failure. */
  error: string | null;
  /** Every division on chain — pages use it to explain who the registered officers are. */
  divisions: LiveDivision[];
  /** How to describe the caller when telling them they are not authorized. */
  identity: string | null;
  /** Custom mode: no session at all, so the page should send them to sign in rather than say "not a GN". */
  needsSignIn: boolean;
  refetch: () => void;
}

export const useGnDivision = (): GnDivisionState => {
  const mode = getChainMode();
  const { session, isLoading: authLoading } = useElectionAuth();
  const { address, isConnected } = useAccount();
  const { divisions, isLoading: divisionsLoading, error, refetch } = useDivisions();

  const isCustom = mode === "custom";
  const division = isCustom
    ? (findDivisionById(divisions, session?.role === "gn" ? session.divisionId : undefined) ?? null)
    : (findDivisionForGN(divisions, address) ?? null);

  return {
    mode,
    division,
    isLoading: divisionsLoading || (isCustom ? authLoading : false),
    error,
    divisions,
    identity: isCustom ? (session?.username ?? null) : (address ?? null),
    needsSignIn: isCustom ? !authLoading && session?.role !== "gn" : !isConnected,
    refetch,
  };
};
