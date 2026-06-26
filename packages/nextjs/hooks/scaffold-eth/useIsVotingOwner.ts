"use client";

import { useAccount } from "wagmi";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";

/**
 * Returns true when the currently connected wallet is the owner of the
 * Voting contract (and the owner address has been resolved). Returns false
 * before connection or while data is loading.
 */
export const useIsVotingOwner = (): boolean => {
  const { address } = useAccount();
  const { data: owner } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "owner",
  });
  if (!address || !owner) return false;
  return address.toLowerCase() === (owner as string).toLowerCase();
};
