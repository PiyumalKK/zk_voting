"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPublicClient, http } from "viem";
import type { PublicClient } from "viem";
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
  /** Every address currently authorised as a GN officer for this division. */
  gnOfficers: readonly string[];
  active: boolean;
  phase: number;
  treeSize: number;
  root: bigint;
  hidden?: boolean;
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
  { name: "getGNOfficers", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
] as const;

interface RegistryDivision {
  name: string;
  votingContract: `0x${string}`;
  gnOfficer: `0x${string}`;
  active: boolean;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * How often the shared poller below re-reads every division's live data.
 * Deliberately longer than a typical "instant" UI poll: this read is O(2 ×
 * division count), and several admin panels are on screen (and therefore
 * subscribed) at once — see the module doc on `enrichedListeners`.
 */
const POLL_INTERVAL_MS = 15_000;

interface EnrichedState {
  status: "idle" | "loading" | "ready" | "error";
  divisions: LiveDivision[];
  error: string | null;
}

const IDLE_ENRICHED: EnrichedState = { status: "idle", divisions: [], error: null };

/**
 * Shared, module-level cache for the expensive half of this hook: reading
 * every division's live `getGNOfficers()` / `getVotingData()` from chain.
 *
 * Before this, each `useDivisions()` call ran its own independent
 * `setInterval` and its own `Promise.all` over every division — and several
 * admin panels call this hook on the same page at once (the provider, the
 * divisions list, the GN account panels, both bulk-import panels). Five
 * panels × N divisions × two reads, on a 4s timer, is exactly the load that
 * overwhelmed the chain once an admin bulk-imported enough divisions
 * (crashed at ~1,000). Sharing one poller across every caller turns that
 * multiplication back into a single read pass, regardless of how many
 * components are mounted.
 *
 * The registry list itself (`getAllDivisions`, via `useScaffoldReadContract`)
 * doesn't need this treatment — wagmi's `useReadContract` is backed by
 * TanStack Query, which already dedupes identical concurrent queries across
 * every caller. It's only this manual per-division fan-out that wasn't.
 */
let enrichedState: EnrichedState = IDLE_ENRICHED;
const enrichedListeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
let lastRegistryKey: string | null = null;
let lastRpcUrl = "";
let latestRegList: readonly RegistryDivision[] = [];
let latestPublicClient: PublicClient | null = null;

const setEnrichedState = (next: EnrichedState) => {
  enrichedState = next;
  for (const listener of enrichedListeners) listener();
};

const readDivision = async (publicClient: PublicClient, reg: RegistryDivision, id: number): Promise<LiveDivision> => {
  try {
    const [gnOfficers, votingData] = await Promise.all([
      publicClient.readContract({ address: reg.votingContract, abi: VOTING_READ_ABI, functionName: "getGNOfficers" }),
      publicClient.readContract({ address: reg.votingContract, abi: VOTING_READ_ABI, functionName: "getVotingData" }),
    ]);
    return {
      id,
      name: reg.name,
      votingContract: reg.votingContract,
      gnOfficers: gnOfficers as readonly string[],
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
      gnOfficers: reg.gnOfficer !== ZERO_ADDRESS ? [reg.gnOfficer] : [],
      active: reg.active,
      phase: 0,
      treeSize: 0,
      root: 0n,
    };
  }
};

/** Joins the in-flight read if one is already running, rather than starting a second. */
const loadEnriched = (regList: readonly RegistryDivision[], publicClient: PublicClient): Promise<void> => {
  if (inFlight) return inFlight;

  // Only show "loading" before the very first successful read; a background
  // poll refreshes silently and keeps whatever was on screen.
  setEnrichedState({
    status: enrichedState.status === "ready" ? "ready" : "loading",
    divisions: enrichedState.divisions,
    error: null,
  });

  inFlight = Promise.all(regList.map((reg, id) => readDivision(publicClient, reg, id)))
    .then(divisions => setEnrichedState({ status: "ready", divisions, error: null }))
    .catch(() =>
      setEnrichedState({
        status: "error",
        divisions: enrichedState.divisions,
        error: "Failed to load division data from chain.",
      }),
    )
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
};

/** Called from every `useDivisions()` render with its freshest inputs. */
const syncEnriched = (
  regList: readonly RegistryDivision[],
  publicClient: PublicClient,
  registryKey: string,
  rpcUrl: string,
) => {
  latestRegList = regList;
  latestPublicClient = publicClient;

  const changed = lastRegistryKey === null || registryKey !== lastRegistryKey || rpcUrl !== lastRpcUrl;
  lastRegistryKey = registryKey;
  lastRpcUrl = rpcUrl;

  if (changed) void loadEnriched(regList, publicClient);
};

const subscribeEnriched = (listener: () => void) => {
  const wasUnwatched = enrichedListeners.size === 0;
  enrichedListeners.add(listener);

  if (wasUnwatched) {
    // Coming back from "nobody watching" — the cache may be stale (or from a
    // different chain by now). Invalidate so the next sync forces a reload
    // instead of waiting out a full poll interval.
    lastRegistryKey = null;
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        if (latestPublicClient) void loadEnriched(latestRegList, latestPublicClient);
      }, POLL_INTERVAL_MS);
    }
  }

  return () => {
    enrichedListeners.delete(listener);
    if (enrichedListeners.size === 0 && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
};

const getEnrichedSnapshot = () => enrichedState;
const getEnrichedServerSnapshot = () => IDLE_ENRICHED;

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

  // Stabilise the dependency: only re-run when the set of contract addresses changes.
  const registryKey = useMemo(() => {
    if (!registryDivisions) return "";
    return (registryDivisions as readonly RegistryDivision[]).map(d => d.votingContract).join(",");
  }, [registryDivisions]);

  const enrichedSnapshot = useSyncExternalStore(subscribeEnriched, getEnrichedSnapshot, getEnrichedServerSnapshot);

  useEffect(() => {
    if (registryError || !registryDivisions || !publicClient) return;
    syncEnriched(
      registryDivisions as readonly RegistryDivision[],
      publicClient,
      registryKey,
      targetNetwork.rpcUrls.default.http[0],
    );
  }, [registryKey, publicClient, registryDivisions, registryError, targetNetwork]);

  const [hiddenIds, setHiddenIds] = useState<number[]>([]);

  // Load initial hidden state from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem("hiddenDivisions");
      if (stored) setHiddenIds(JSON.parse(stored));
    } catch {}
  }, []);

  // Sync hidden state to localStorage when it changes
  useEffect(() => {
    try {
      localStorage.setItem("hiddenDivisions", JSON.stringify(hiddenIds));
    } catch {}
  }, [hiddenIds]);

  const toggleHidden = (id: number) => {
    setHiddenIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  };

  return {
    divisions: enrichedSnapshot.divisions.map(d => ({ ...d, hidden: hiddenIds.includes(d.id) })),
    isLoading: registryLoading || enrichedSnapshot.status === "idle" || enrichedSnapshot.status === "loading",
    error: registryError
      ? "Could not read the ElectionRegistry. Is the contract deployed and the node running?"
      : enrichedSnapshot.error,
    refetch: () => {
      if (registryDivisions && publicClient) {
        void loadEnriched(registryDivisions as readonly RegistryDivision[], publicClient);
      }
    },
    toggleHidden,
  };
};

/**
 * Returns the division for which the given address is the authoritative on-chain GN.
 *
 * Re-exported from `utils/gnDivision` so existing importers keep working; the
 * implementation lives there because it is pure and should be testable without
 * loading the wagmi read stack this module depends on.
 */
export { findDivisionForGN } from "~~/utils/gnDivision";

export { PHASE_LABELS } from "~~/utils/electionPhase";
