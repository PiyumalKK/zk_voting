"use client";

/**
 * Backend-agnostic chain hooks — THE plug-and-play seam.
 *
 * Every voting component reads/writes the chain exclusively through these
 * hooks. Each hook contains both implementations:
 *   - EVM (scaffold-eth/wagmi against Hardhat or Sepolia)
 *   - REST (the Go blockchain node, packages/blockchain)
 * selected by scaffold.config.ts `chainBackend` (env NEXT_PUBLIC_CHAIN_BACKEND).
 *
 * Rules-of-hooks note: the backend is a build-time constant, and every
 * underlying hook is called unconditionally with an `enabled` flag — only the
 * *returned data* branches, so hook order is always stable.
 */
import { useEffect, useMemo } from "react";
import { ChainError } from "./errors";
import { useIdentityStore } from "./identityStore";
import {
  adminAction,
  fetchCandidates,
  fetchLeaves,
  fetchVoteCounts,
  fetchVoterStatus,
  fetchVoters,
  fetchVotingData,
  postRegister,
  postVote,
} from "./restClient";
import type { ChainBackend, RegisterResult, VoteSubmission, VoterListEntry, VoterStatus, VotingData } from "./types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { decodeEventLog, toHex } from "viem";
import { useAccount } from "wagmi";
import {
  useDeployedContractInfo,
  useIsVotingOwner,
  useScaffoldEventHistory,
  useScaffoldReadContract,
  useScaffoldWriteContract,
} from "~~/hooks/scaffold-eth";
import scaffoldConfig from "~~/scaffold.config";

const BACKEND: ChainBackend = scaffoldConfig.chainBackend;
/** True when the app targets the Go blockchain node instead of an EVM chain. */
export const isCustomChain = BACKEND === "custom";
const POLL_MS = scaffoldConfig.pollingInterval || 3000;

export function useChainBackend(): ChainBackend {
  return BACKEND;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/** Normalized election state (question, phase, deadlines, tree, election id). */
export function useVotingData(): { data: VotingData | undefined; refetch: () => Promise<unknown> } {
  const evm = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getVotingData",
    watch: true,
    query: { enabled: !isCustomChain },
  });
  const evmElection = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getCurrentElectionId",
    watch: true,
    query: { enabled: !isCustomChain },
  });
  const rest = useQuery({
    queryKey: ["chain", "voting-data"],
    queryFn: fetchVotingData,
    refetchInterval: POLL_MS,
    enabled: isCustomChain,
  });

  const data = useMemo<VotingData | undefined>(() => {
    if (isCustomChain) return rest.data;
    const t = evm.data as readonly unknown[] | undefined;
    if (!t) return undefined;
    return {
      question: t[0] as string,
      phase: Number(t[2]),
      registrationEndTime: Number(t[3]),
      votingEndTime: Number(t[4]),
      treeSize: Number(t[5]),
      depth: Number(t[6]),
      root: t[7] as bigint,
      candidateCount: Number(t[8]),
      electionId: evmElection.data !== undefined ? String(evmElection.data) : "",
    };
  }, [rest.data, evm.data, evmElection.data]);

  return {
    data,
    refetch: isCustomChain ? rest.refetch : async () => Promise.all([evm.refetch(), evmElection.refetch()]),
  };
}

export function useCandidates(): { data: string[]; refetch: () => Promise<unknown> } {
  const evm = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getCandidates",
    watch: true,
    query: { enabled: !isCustomChain },
  });
  const rest = useQuery({
    queryKey: ["chain", "candidates"],
    queryFn: fetchCandidates,
    refetchInterval: POLL_MS,
    enabled: isCustomChain,
  });
  const data = useMemo<string[]>(() => {
    if (isCustomChain) return rest.data ?? [];
    return ((evm.data as readonly string[] | undefined) ?? []).slice();
  }, [rest.data, evm.data]);
  return { data, refetch: isCustomChain ? rest.refetch : evm.refetch };
}

/** Per-candidate tallies, index-aligned with useCandidates(). */
export function useVoteCounts(): bigint[] {
  const evm = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getVoteCounts",
    watch: true,
    query: { enabled: !isCustomChain },
  });
  const rest = useQuery({
    queryKey: ["chain", "vote-counts"],
    queryFn: fetchVoteCounts,
    refetchInterval: POLL_MS,
    enabled: isCustomChain,
  });
  return useMemo<bigint[]>(() => {
    if (isCustomChain) return rest.data ?? [];
    return ((evm.data as readonly bigint[] | undefined) ?? []).slice();
  }, [rest.data, evm.data]);
}

/**
 * Merkle leaves of the CURRENT election, oldest-first (LeanIMT insertion
 * order) as bigints — exactly what proof generation rebuilds the tree from.
 * EVM: NewLeaf event history (newest-first → sliced to treeSize, reversed).
 * REST: GET /commitments (already ordered and reset-scoped server-side).
 */
export function useLeaves(): bigint[] {
  const { data: votingData } = useVotingData();
  const { data: events } = useScaffoldEventHistory({
    contractName: "Voting",
    eventName: "NewLeaf",
    watch: true,
    enabled: !isCustomChain,
  });
  const rest = useQuery({
    queryKey: ["chain", "leaves"],
    queryFn: fetchLeaves,
    refetchInterval: POLL_MS,
    enabled: isCustomChain,
  });

  const treeSize = votingData?.treeSize ?? 0;
  return useMemo<bigint[]>(() => {
    if (isCustomChain) return rest.data ?? [];
    if (!events) return [];
    // events are newest-first; the current election owns exactly the first
    // `treeSize` of them. Reverse into insertion order for the tree.
    return events
      .slice(0, treeSize)
      .map((e: any) => BigInt(e?.args?.value))
      .reverse();
  }, [rest.data, events, treeSize]);
}

// ─── Identity ─────────────────────────────────────────────────────────────────

/**
 * Who is the current voter?
 * EVM: the connected wallet address (ready when connected).
 * Custom: a self-entered allowlisted ID (email/etc.), persisted locally —
 * setVoterId is only meaningful here.
 */
export function useVoterId(): {
  voterId: string;
  setVoterId: (id: string) => void;
  ready: boolean;
  isWallet: boolean;
} {
  const { address, isConnected } = useAccount();
  const { voterId, setVoterId, hydrate } = useIdentityStore();
  useEffect(() => hydrate(), [hydrate]);

  if (isCustomChain) {
    const trimmed = voterId.trim();
    return { voterId: trimmed, setVoterId, ready: trimmed.length > 0, isWallet: false };
  }
  return {
    voterId: address ?? "",
    setVoterId: () => undefined,
    ready: Boolean(isConnected && address),
    isWallet: true,
  };
}

/** allowed/registered flags for an arbitrary voter ID (admin tooling, voter lists). */
export function useVoterStatusById(voterId: string, enabled = true): VoterStatus | undefined {
  const on = enabled && voterId.length > 0;
  const evm = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getVoterData",
    args: [voterId as `0x${string}`],
    watch: true,
    query: { enabled: !isCustomChain && on },
  });
  const rest = useQuery({
    queryKey: ["chain", "voter", voterId],
    queryFn: () => fetchVoterStatus(voterId),
    refetchInterval: POLL_MS,
    enabled: isCustomChain && on,
  });

  return useMemo<VoterStatus | undefined>(() => {
    if (!on) return undefined;
    if (isCustomChain) return rest.data;
    const t = evm.data as readonly [boolean, boolean] | undefined;
    return t ? { allowed: t[0], registered: t[1] } : undefined;
  }, [on, rest.data, evm.data]);
}

/** allowed/registered flags for the current voter (undefined while loading or without identity). */
export function useVoterStatus(): VoterStatus | undefined {
  const { voterId, ready } = useVoterId();
  return useVoterStatusById(voterId, ready);
}

/** The election's allowlist (admin tooling). EVM: VoterAdded events; REST: GET /voters. */
export function useVoterList(enabled = true): VoterListEntry[] {
  const { data: events } = useScaffoldEventHistory({
    contractName: "Voting",
    eventName: "VoterAdded",
    watch: true,
    enabled: enabled && !isCustomChain,
  });
  const rest = useQuery({
    queryKey: ["chain", "voters"],
    queryFn: fetchVoters,
    refetchInterval: POLL_MS,
    enabled: enabled && isCustomChain,
  });

  return useMemo<VoterListEntry[]>(() => {
    if (isCustomChain) return rest.data ?? [];
    if (!events) return [];
    const unique = Array.from(
      new Set(
        (events as any[])
          .map(row => row?.args?.voter ?? row?.args?.[0])
          .filter((v: unknown): v is string => typeof v === "string" && v.length > 0),
      ),
    );
    return unique.map(id => ({ id, allowed: true }));
  }, [rest.data, events]);
}

/**
 * Namespace for localStorage keys (Voter Pass, proofs, burner wallets).
 * EVM: the deployed contract address (existing behavior). Custom: a stable
 * slug of the node URL — there is no contract address to key on.
 */
export function useStorageNamespace(): string | undefined {
  const { data: contractInfo } = useDeployedContractInfo({ contractName: "Voting" });
  if (isCustomChain) return `custom-${scaffoldConfig.chainApiUrl.replace(/[^a-zA-Z0-9]/g, "_")}`;
  return contractInfo?.address;
}

// ─── Voter writes ─────────────────────────────────────────────────────────────

/** Register a commitment; resolves with the assigned Merkle leaf index. */
export function useRegisterVoter(): { register: (commitmentHex: string) => Promise<RegisterResult> } {
  const { voterId } = useVoterId();
  const { data: votingData } = useVotingData();
  const { data: contractInfo } = useDeployedContractInfo({ contractName: "Voting" });
  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "Voting" });
  const queryClient = useQueryClient();

  const register = async (commitmentHex: string): Promise<RegisterResult> => {
    if (isCustomChain) {
      const result = await postRegister(voterId, commitmentHex);
      await queryClient.invalidateQueries({ queryKey: ["chain"] });
      return result;
    }

    // EVM: submit register(commitment) and decode the NewLeaf event from the
    // receipt for the authoritative index; fall back to the pre-insert tree
    // size (== the new leaf's index) if decoding finds nothing.
    let decodedIndex: number | undefined;
    await writeContractAsync(
      { functionName: "register", args: [BigInt(commitmentHex)] },
      {
        blockConfirmations: 1,
        onBlockConfirmation: (receipt: any) => {
          for (const log of receipt?.logs ?? []) {
            try {
              const decoded: any = decodeEventLog({
                abi: contractInfo?.abi as any,
                data: log.data,
                topics: log.topics,
              });
              if (decoded.eventName === "NewLeaf") {
                decodedIndex = Number(decoded.args.index);
                break;
              }
            } catch {
              // log from another contract/event — ignore
            }
          }
        },
      },
    );
    return { leafIndex: decodedIndex ?? votingData?.treeSize ?? 0, electionId: votingData?.electionId };
  };

  return { register };
}

/**
 * Submit an anonymous vote on the CUSTOM backend (plain POST /vote — no
 * wallet, no gas, no burner). EVM voting keeps its burner-wallet components
 * (VoteWithBurnerHardhat/Sepolia); calling this on the EVM backend is a bug.
 */
export function useCastVote(): { castVote: (s: VoteSubmission) => Promise<void> } {
  const queryClient = useQueryClient();

  const castVote = async (s: VoteSubmission): Promise<void> => {
    if (!isCustomChain) {
      throw new ChainError("castVote() is only used with the custom chain backend");
    }
    // Public inputs order matches the circuit/contract: [nullifierHash, root, vote, depth]
    const [nullifierHash, root, , depthHex] = s.publicInputs;
    await postVote({
      proofHex: toHex(s.proof),
      nullifierHashHex: nullifierHash,
      rootHex: root,
      candidateIndex: s.candidateIndex,
      depth: Number(BigInt(depthHex)),
    });
    await queryClient.invalidateQueries({ queryKey: ["chain"] });
  };

  return { castVote };
}

// ─── Admin ────────────────────────────────────────────────────────────────────

/**
 * Admin gate. EVM: the connected wallet must be the contract owner.
 * Custom: a dashboard password unlocks the Next.js signing proxy (verified
 * server-side; the RSA admin key never reaches the browser).
 */
export function useAdminAccess(): {
  isAdmin: boolean;
  /** EVM only: a wallet connection is a precondition for the owner check */
  requiresWallet: boolean;
  walletConnected: boolean;
  login: (password: string) => Promise<void>;
  logout: () => void;
} {
  const evmIsOwner = useIsVotingOwner();
  const { isConnected } = useAccount();
  const { adminPassword, setAdminPassword, hydrate } = useIdentityStore();
  useEffect(() => hydrate(), [hydrate]);

  const login = async (password: string) => {
    await adminAction("verify", {}, password); // 401 → ChainError("Wrong admin password.")
    setAdminPassword(password);
  };
  const logout = () => setAdminPassword(null);

  if (isCustomChain) {
    return { isAdmin: adminPassword !== null, requiresWallet: false, walletConnected: true, login, logout };
  }
  return { isAdmin: evmIsOwner, requiresWallet: true, walletConnected: Boolean(isConnected), login, logout };
}

export interface AdminActions {
  setQuestion: (question: string) => Promise<void>;
  setCandidates: (candidates: string[]) => Promise<void>;
  addVoters: (entries: { id: string; allowed: boolean }[]) => Promise<void>;
  startRegistration: (durationSec: bigint) => Promise<void>;
  startVoting: (durationSec: bigint) => Promise<void>;
  endElection: () => Promise<void>;
  resetElection: () => Promise<void>;
}

/** The six election-lifecycle controls, mirrored 1:1 across both backends. */
export function useAdminActions(): AdminActions {
  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "Voting" });
  const { adminPassword } = useIdentityStore();
  const queryClient = useQueryClient();

  return useMemo<AdminActions>(() => {
    if (isCustomChain) {
      const pw = adminPassword ?? "";
      const done = () => queryClient.invalidateQueries({ queryKey: ["chain"] });
      return {
        setQuestion: async question => {
          await adminAction("set-question", { question }, pw);
          await done();
        },
        setCandidates: async candidates => {
          await adminAction("set-candidates", { candidates }, pw);
          await done();
        },
        addVoters: async entries => {
          // The node's endpoint is per-voter; submit sequentially so a failure
          // reports exactly which entry was rejected.
          for (const e of entries) {
            await adminAction("add-voter", { voter_id: e.id, allowed: e.allowed }, pw);
          }
          await done();
        },
        startRegistration: async sec => {
          await adminAction("start-registration", { duration_sec: Number(sec) }, pw);
          await done();
        },
        startVoting: async sec => {
          await adminAction("start-voting", { duration_sec: Number(sec) }, pw);
          await done();
        },
        endElection: async () => {
          await adminAction("end-election", {}, pw);
          await done();
        },
        resetElection: async () => {
          await adminAction("reset-election", {}, pw);
          await done();
        },
      };
    }

    return {
      setQuestion: async question => {
        await writeContractAsync({ functionName: "setQuestion", args: [question] });
      },
      setCandidates: async candidates => {
        await writeContractAsync({ functionName: "setCandidates", args: [candidates] });
      },
      addVoters: async entries => {
        await writeContractAsync({
          functionName: "addVoters",
          args: [entries.map(e => e.id as `0x${string}`), entries.map(e => e.allowed)],
        });
      },
      startRegistration: async sec => {
        await writeContractAsync({ functionName: "startRegistration", args: [sec] });
      },
      startVoting: async sec => {
        await writeContractAsync({ functionName: "startVoting", args: [sec] });
      },
      endElection: async () => {
        await writeContractAsync({ functionName: "endElection" });
      },
      resetElection: async () => {
        await writeContractAsync({ functionName: "resetElection" });
      },
    };
  }, [adminPassword, writeContractAsync, queryClient]);
}
