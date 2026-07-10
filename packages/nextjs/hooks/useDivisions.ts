"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, http } from "viem";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";

/**
 * Live, on-chain division data.
 *
 * Architecture (production source-of-truth rules):
 * - The ElectionRegistry lists WHICH divisions exist (name + Voting contract address).
 * - Each Voting contract's `s_gnOfficer` is the authoritative GN — because
 *   `setGNOfficer` updates the Voting contract, NOT the registry's stored copy.
 * - Phase / tree size / root are always read live from the Voting contract.
 *
 * This hook merges both sources so the whole app never relies on hardcoded config.
 */
export interface LiveDivision {
  id: number;
  name: string;
  votingContract: `0x${string}`;
  gnOfficer: string;
  active: boolean;
  phase: number;
  treeSize: number;
  root: bigint;
}

const VOTING_READ_ABI = [
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
  { name: "s_gnOfficer", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

interface RegistryDivision {
  name: string;
  votingContract: `0x${string}`;
  gnOfficer: `0x${string}`;
  active: boolean;
}

/**
 * Reads all divisions from the ElectionRegistry, then enriches each with live
 * GN officer, phase, tree size and root read directly from its Voting contract.
 */
export const useDivisions = () => {
  const { targetNetwork } = useTargetNetwork();
  // Use a DEDICATED public client bound to the election's target network RPC.
  // wagmi's usePublicClient() follows the wallet's connected chain, which caused
  // live reads to fail and silently fall back to the registry's stale GN values.
  const publicClient = useMemo(
    () =>
      createPublicClient({
        chain: targetNetwork,
        transport: http(targetNetwork.rpcUrls.default.http[0]),
      }),
    [targetNetwork],
  );
  const {
    data: registryDivisions,
    isLoading: registryLoading,
    error: registryError,
  } = useScaffoldReadContract({
    contractName: "ElectionRegistry",
    functionName: "getAllDivisions",
  });

  const [divisions, setDivisions] = useState<LiveDivision[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const hasLoadedRef = useRef(false);

  // Stabilise the dependency: only re-run when the set of contract addresses changes.
  const registryKey = useMemo(() => {
    if (!registryDivisions) return "";
    return (registryDivisions as readonly RegistryDivision[]).map(d => d.votingContract).join(",");
  }, [registryDivisions]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (registryError) {
        setError("Could not read the ElectionRegistry. Is the contract deployed and the node running?");
        setIsLoading(false);
        return;
      }
      if (!registryDivisions || !publicClient) {
        return;
      }

      // Only show the spinner on the very first load; background polls refresh silently.
      if (!hasLoadedRef.current) setIsLoading(true);
      setError(null);

      try {
        const regList = registryDivisions as readonly RegistryDivision[];
        const enriched = await Promise.all(
          regList.map(async (reg, id): Promise<LiveDivision> => {
            try {
              const [gn, votingData] = await Promise.all([
                publicClient.readContract({
                  address: reg.votingContract,
                  abi: VOTING_READ_ABI,
                  functionName: "s_gnOfficer",
                }),
                publicClient.readContract({
                  address: reg.votingContract,
                  abi: VOTING_READ_ABI,
                  functionName: "getVotingData",
                }),
              ]);
              return {
                id,
                name: reg.name,
                votingContract: reg.votingContract,
                gnOfficer: gn as string,
                active: reg.active,
                phase: Number((votingData as readonly unknown[])[2]),
                treeSize: Number((votingData as readonly unknown[])[5]),
                root: (votingData as readonly unknown[])[7] as bigint,
              };
            } catch {
              // Voting contract unreachable — fall back to registry's stored values.
              return {
                id,
                name: reg.name,
                votingContract: reg.votingContract,
                gnOfficer: reg.gnOfficer,
                active: reg.active,
                phase: 0,
                treeSize: 0,
                root: 0n,
              };
            }
          }),
        );

        if (!cancelled) {
          setDivisions(enriched);
          setIsLoading(false);
          hasLoadedRef.current = true;
        }
      } catch {
        if (!cancelled) {
          setError("Failed to load division data from chain.");
          setIsLoading(false);
        }
      }
    };

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registryKey, publicClient, registryError, refreshTick]);

  // Poll the chain so GN assignments, phase changes and new votes appear live
  // without a manual refresh. Silent (no spinner) after the first load.
  useEffect(() => {
    const interval = setInterval(() => setRefreshTick(t => t + 1), 4000);
    return () => clearInterval(interval);
  }, []);

  return {
    divisions,
    isLoading: isLoading || registryLoading,
    error,
    refetch: () => setRefreshTick(t => t + 1),
  };
};

/**
 * Returns the division for which the given address is the authoritative on-chain GN.
 */
export const findDivisionForGN = (divisions: LiveDivision[], address?: string): LiveDivision | undefined => {
  if (!address) return undefined;
  return divisions.find(d => d.gnOfficer.toLowerCase() === address.toLowerCase());
};

export const PHASE_LABELS = ["Setup", "Registration", "Voting", "Ended"] as const;
