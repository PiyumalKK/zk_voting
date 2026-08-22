"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createPublicClient, http } from "viem";
import type { Abi } from "viem";
import { useAccount } from "wagmi";
import { AdminTabs } from "~~/app/voting/admin/_components/AdminTabs";
import {
  CLEAR_DIVISIONS_ABI,
  CLEAR_NIC_HASHES_ABI,
  STRICT_ENROLMENT_ABI,
  VoterEntry,
  parseDurationToSeconds,
} from "~~/app/voting/admin/_components/adminContracts";
import deployedContracts from "~~/contracts/deployedContracts";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { LiveDivision, useDivisions } from "~~/hooks/useDivisions";
import { useElectionAuth } from "~~/hooks/useElectionAuth";
import { useElectionWriter } from "~~/hooks/useElectionWriter";
import { getDeployedAddress } from "~~/utils/deployedAddress";
import { PHASE_LABELS } from "~~/utils/electionPhase";
import { notification } from "~~/utils/scaffold-eth";

/**
 * Everything the admin area shares, in one place.
 *
 * The admin panel used to be a single 1,200-line route. It is now three —
 * Operations, Ballot, Divisions — and they need the same division selection,
 * the same live contract reads and the same draft form state. A React context
 * held by `app/voting/admin/layout.tsx` is what makes that work: Next.js keeps
 * a layout mounted across navigations between its children, so switching tabs
 * no longer resets which division you were configuring.
 *
 * This component also owns the access gate. It returns the gate instead of
 * `children`, which is why the tab strip is rendered here rather than in the
 * layout — tabs pointing at pages you may not open would be worse than none.
 *
 * Every hook call, state variable and handler below was moved verbatim from the
 * old `page.tsx`. Nothing about how a transaction is built or routed changed.
 */

type AdminElectionValue = {
  isCustom: boolean;

  divisions: LiveDivision[];
  divisionsLoading: boolean;
  selectedIdx: number;
  setSelectedIdx: React.Dispatch<React.SetStateAction<number>>;
  selectedDiv?: LiveDivision;

  phase: number;
  phaseLabel: string;
  registrationEnd: number;
  votingEnd: number;
  now: number;
  candList: readonly string[];
  inSetup: boolean;
  inRegistration: boolean;
  inVoting: boolean;
  ended: boolean;

  questionDraft: string;
  setQuestionDraft: React.Dispatch<React.SetStateAction<string>>;
  candidateDrafts: string[];
  setCandidateDrafts: React.Dispatch<React.SetStateAction<string[]>>;
  voterDrafts: VoterEntry[];
  setVoterDrafts: React.Dispatch<React.SetStateAction<VoterEntry[]>>;
  registrationDuration: string;
  setRegistrationDuration: React.Dispatch<React.SetStateAction<string>>;
  votingDuration: string;
  setVotingDuration: React.Dispatch<React.SetStateAction<string>>;

  busy: string | null;
  /**
   * How far a fan-out has got. One transaction per division, sequentially, each
   * routed through the relay — with a realistic division count that is minutes
   * of a page that otherwise says only "Starting…".
   */
  progress: { done: number; total: number } | null;
  handleSetQuestion: () => void;
  /** Broadcasts the current question draft to every division. */
  handleSetQuestionAll: () => void;
  handleSetCandidates: () => void;
  /** Broadcasts the current candidate drafts to every division. */
  handleSetCandidatesAll: () => void;
  handleAddVoters: () => void;
  handleStartRegistration: () => void;
  handleStartVoting: () => void;
  handleEndElection: () => void;
  handleStartRegistrationAll: () => void;
  handleStartVotingAll: () => void;
  handleEndAll: () => void;
  handleResetElection: () => void;

  /**
   * Whether `NicRegistry` requires every registering device to have been
   * enrolled against a NIC. `undefined` while the read is in flight, or when no
   * NicRegistry is deployed on this chain.
   */
  strictEnrolment: boolean | undefined;
  handleSetStrictEnrolment: (enabled: boolean) => void;
};

const AdminElectionContext = createContext<AdminElectionValue | null>(null);

/** Read the shared admin state. Throws rather than silently rendering an empty panel. */
export const useAdminElection = (): AdminElectionValue => {
  const value = useContext(AdminElectionContext);
  if (!value) {
    throw new Error("useAdminElection must be used inside <AdminElectionProvider>");
  }
  return value;
};

/** Frame for the gate states, which render without the tab strip. */
const GateFrame = ({ children }: { children: React.ReactNode }) => (
  <div className="w-full max-w-5xl mx-auto">
    <div className="dash-card p-6 lg:p-8">{children}</div>
  </div>
);

export const AdminElectionProvider = ({ children }: { children: React.ReactNode }) => {
  const router = useRouter();
  const { address: connected } = useAccount();
  const { mode, isAdmin, isLoading: authLoading } = useElectionAuth();
  const { write } = useElectionWriter();
  const isCustom = mode === "custom";
  const { targetNetwork } = useTargetNetwork();
  const { divisions, isLoading: divisionsLoading } = useDivisions();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const selectedDiv = divisions[selectedIdx];

  // Full Voting ABI (all admin functions) for reads/writes to any division contract.
  const VOTING_ABI = useMemo(
    () => (deployedContracts as Record<number, any>)[targetNetwork.id]?.Voting?.abi ?? [],
    [targetNetwork.id],
  );

  // The two shared registries. Only the "start a new election" path writes to
  // them from here; everything else in this provider targets a division.
  const registryAddress = useMemo(() => getDeployedAddress(targetNetwork.id, "ElectionRegistry"), [targetNetwork.id]);
  const nicRegistryAddress = useMemo(() => getDeployedAddress(targetNetwork.id, "NicRegistry"), [targetNetwork.id]);

  const publicClient = useMemo(
    () => createPublicClient({ chain: targetNetwork, transport: http(targetNetwork.rpcUrls.default.http[0]) }),
    [targetNetwork],
  );

  const [strictEnrolment, setStrictEnrolment] = useState<boolean | undefined>(undefined);

  const [votingData, setVotingData] = useState<readonly unknown[] | undefined>(undefined);
  const [candidates, setCandidates] = useState<readonly string[] | undefined>(undefined);
  const [ownerAddr, setOwnerAddr] = useState<string | undefined>(undefined);

  /**
   * The selected division's contract address.
   *
   * Depended on instead of `selectedDiv` itself, and this is load-bearing:
   * `useDivisions` re-polls every 4s and hands back a brand-new array of
   * brand-new objects, so `selectedDiv` changes identity on every poll even
   * when nothing about the division changed. A string does not.
   */
  const selectedContract = selectedDiv?.votingContract;

  // Read the SELECTED division's live election data.
  const refetchDivision = useCallback(async () => {
    if (!selectedContract) return;
    try {
      const [vd, cands, owner] = await Promise.all([
        publicClient.readContract({
          address: selectedContract,
          abi: VOTING_ABI,
          functionName: "getVotingData",
          args: [],
        }),
        publicClient.readContract({
          address: selectedContract,
          abi: VOTING_ABI,
          functionName: "getCandidates",
          args: [],
        }),
        publicClient.readContract({
          address: selectedContract,
          abi: VOTING_ABI,
          functionName: "owner",
          args: [],
        }),
      ]);
      setVotingData(vd as readonly unknown[]);
      setCandidates(cands as readonly string[]);
      setOwnerAddr(owner as string);
    } catch (e) {
      console.error("refetchDivision", e);
    }
  }, [selectedContract, publicClient, VOTING_ABI]);

  const refetchStrictEnrolment = useCallback(async () => {
    if (!nicRegistryAddress) return setStrictEnrolment(undefined);
    try {
      const enabled = await publicClient.readContract({
        address: nicRegistryAddress,
        abi: STRICT_ENROLMENT_ABI,
        functionName: "isStrictEnrolment",
      });
      setStrictEnrolment(enabled as boolean);
    } catch (e) {
      // A registry deployed before this flag existed has no such function. Not
      // an error worth a toast — the panel simply reports it as unavailable.
      console.error("isStrictEnrolment", e);
      setStrictEnrolment(undefined);
    }
  }, [nicRegistryAddress, publicClient]);

  useEffect(() => {
    void refetchStrictEnrolment();
  }, [refetchStrictEnrolment]);

  const handleSetStrictEnrolment = (enabled: boolean) =>
    run(
      "strictEnrolment",
      async () => {
        if (!nicRegistryAddress) throw new Error("NicRegistry is not deployed on this chain.");
        await write({
          address: nicRegistryAddress,
          abi: STRICT_ENROLMENT_ABI as unknown as Abi,
          functionName: "setStrictEnrolment",
          args: [enabled],
        });
        await refetchStrictEnrolment();
      },
      enabled
        ? "Strict enrolment is on — only devices enrolled by a GN officer can register."
        : "Strict enrolment is off — bulk-allowlisted addresses can register again.",
    );

  /**
   * Blank the previous division's data — but only when the operator actually
   * switches division.
   *
   * This used to run on every refetch. Because `phase` falls back to `0` while
   * `votingData` is undefined, the page dropped to "Setup" for a frame every
   * four seconds, which re-enabled the Setup-only controls (`Save question`,
   * `Save candidates`) mid-election and blinked the phase badge and counters.
   */
  useEffect(() => {
    setVotingData(undefined);
    setCandidates(undefined);
  }, [selectedContract]);

  useEffect(() => {
    refetchDivision();
  }, [refetchDivision]);

  /**
   * Deliberate poll, replacing the accidental one the identity churn produced.
   *
   * `Voting` auto-advances to Ended once a deadline passes (`_maybeAdvancePhase`),
   * so a page that read only on mount would keep offering actions the contract
   * has already closed. Same 4s cadence as `useDivisions`, minus the blanking.
   */
  useEffect(() => {
    if (!selectedContract) return;
    const id = setInterval(() => {
      refetchDivision();
    }, 4000);
    return () => clearInterval(id);
  }, [selectedContract, refetchDivision]);

  // Who may use this page.
  //
  // Hardhat: every division contract is owned by the Election Authority
  // (deployer), so the connected wallet must be that owner. The page stays
  // accessible while ownership is still loading and blocks only on a confirmed
  // mismatch.
  //
  // Custom chain: the admin session is the credential. `ADMIN_RELAY_PRIVATE_KEY`
  // is defined to be the owner's key and the relay whitelist is the real
  // boundary, so a comparison against a wallet address that does not exist here
  // would only ever produce a false negative.
  const isOwner = isCustom ? isAdmin : ownerAddr ? connected?.toLowerCase() === ownerAddr.toLowerCase() : true;

  // Division-targeting write: routes every admin action to the SELECTED division contract.
  const writeContractAsync = useCallback(
    ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      if (!selectedContract) throw new Error("No division selected");
      return write({ address: selectedContract, abi: VOTING_ABI, functionName, args });
    },
    [selectedContract, write, VOTING_ABI],
  );

  const question = (votingData?.[0] as string | undefined) ?? "";
  const phase = Number(votingData?.[2] ?? 0);
  const registrationEnd = Number(votingData?.[3] ?? 0);
  const votingEnd = Number(votingData?.[4] ?? 0);
  const candList = useMemo(() => (candidates as readonly string[] | undefined) ?? [], [candidates]);

  const phaseLabel = PHASE_LABELS[phase] ?? "Unknown";
  const inSetup = phase === 0;
  const inRegistration = phase === 1;
  const inVoting = phase === 2;
  const ended = phase === 3;

  // --- Local form state ---
  const [questionDraft, setQuestionDraft] = useState<string>("");
  const [candidateDrafts, setCandidateDrafts] = useState<string[]>(["", ""]);
  const [voterDrafts, setVoterDrafts] = useState<VoterEntry[]>([{ address: "", status: true }]);
  const [registrationDuration, setRegistrationDuration] = useState<string>("01:00:00");
  const [votingDuration, setVotingDuration] = useState<string>("01:00:00");
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Seed drafts from on-chain state once.
  useEffect(() => {
    if (question && !questionDraft) setQuestionDraft(question);
  }, [question, questionDraft]);
  useEffect(() => {
    if (candList.length > 0 && candidateDrafts.every(c => c === "")) {
      setCandidateDrafts(candList.slice());
    }
  }, [candList, candidateDrafts]);

  // Live countdown for the deadlines.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  // --- Action handlers ---
  /**
   * Run one admin action, and say what happened.
   *
   * `successMessage` is optional because the callers that fan out across
   * divisions (`runAll`) and the reset already report their own outcome — a
   * second toast there would contradict the count they just showed. Everything
   * else passes one: a save that only un-greys its own button looks identical
   * whether the transaction landed or the click never registered.
   */
  const run = async (label: string, fn: () => Promise<unknown>, successMessage?: string) => {
    try {
      setBusy(label);
      await fn();
      await refetchDivision();
      if (successMessage) notification.success(successMessage);
    } catch (e: any) {
      console.error(label, e);
      notification.error(e?.shortMessage || e?.message || "Transaction failed");
    } finally {
      setBusy(null);
    }
  };

  /** Names the division a message is about, falling back when none is selected. */
  const divisionName = () => selectedDiv?.name ?? "this division";

  /**
   * The question as the contract will receive it, or `null` if it is not fit to
   * send. Same role as `cleanCandidateDrafts` — one rule for both paths.
   *
   * Validates on the trimmed value but sends the draft verbatim, which is
   * exactly what the Save button's `!questionDraft.trim()` guard already did.
   */
  const validatedQuestion = (): string | null => {
    if (!questionDraft.trim()) {
      notification.error("Enter a ballot question.");
      return null;
    }
    return questionDraft;
  };

  const handleSetQuestion = () => {
    const question = validatedQuestion();
    if (question === null) return;
    return run(
      "question",
      () => writeContractAsync({ functionName: "setQuestion", args: [question] }),
      `Ballot question saved for ${divisionName()}`,
    );
  };

  /**
   * Put the same question on every division.
   *
   * A national contest asks one question everywhere — the deploy script already
   * seeds an identical one across divisions — so this is the common case, not
   * the exception. Same fan-out and same Setup-phase skipping as the candidate
   * broadcast, and confirmed for the same reason: it overwrites a question an
   * operator may have set per-division.
   */
  const handleSetQuestionAll = () => {
    const question = validatedQuestion();
    if (question === null) return;

    const confirmed = window.confirm(
      `Apply this question to all ${divisions.length} division(s)?\n\n` +
        `This replaces the ballot question on every division still in the Setup phase. ` +
        `Divisions past Setup are skipped and keep their current question.`,
    );
    if (!confirmed) return;

    return runAll("all-question", "setQuestion", () => [question], "Ballot question applied");
  };

  /**
   * The candidate list as the contract will receive it, or `null` if it is not
   * fit to send.
   *
   * Shared by the single-division and all-divisions paths so the two cannot
   * disagree about what counts as a valid ballot — a broadcast that applied
   * looser rules than the per-division save would put a list on every contract
   * that the UI would refuse for one.
   */
  const cleanCandidateDrafts = (): string[] | null => {
    const cleaned = candidateDrafts.map(c => c.trim()).filter(c => c.length > 0);
    if (cleaned.length === 0) {
      notification.error("Add at least one candidate.");
      return null;
    }
    if (cleaned.length > 100) {
      notification.error("Maximum 100 candidates.");
      return null;
    }
    return cleaned;
  };

  const handleSetCandidates = () => {
    const cleaned = cleanCandidateDrafts();
    if (!cleaned) return;
    return run(
      "candidates",
      () => writeContractAsync({ functionName: "setCandidates", args: [cleaned] }),
      `${cleaned.length} candidate${cleaned.length === 1 ? "" : "s"} saved for ${divisionName()}`,
    );
  };

  /**
   * Put the same candidate list on every division.
   *
   * A national contest runs the same slate everywhere, so doing this by hand
   * across N divisions is both tedious and the obvious place to introduce a
   * per-division typo. Uses the same fan-out as the master phase controls:
   * `setCandidates` is `onlyOwner inPhase(Setup)`, so divisions that have moved
   * past Setup revert and are reported as skipped rather than aborting the run.
   *
   * Confirmed first, unlike the phase controls: this silently replaces whatever
   * slate each division already had, including one an operator set deliberately.
   */
  const handleSetCandidatesAll = () => {
    const cleaned = cleanCandidateDrafts();
    if (!cleaned) return;

    const confirmed = window.confirm(
      `Apply these ${cleaned.length} candidate(s) to all ${divisions.length} division(s)?\n\n` +
        `This replaces the candidate list on every division still in the Setup phase. ` +
        `Divisions past Setup are skipped and keep their current list.`,
    );
    if (!confirmed) return;

    return runAll("all-candidates", "setCandidates", () => [cleaned], "Candidate list applied");
  };

  const handleAddVoters = () => {
    const valid = voterDrafts.filter(v => v.address.trim() !== "");
    if (valid.length === 0) {
      notification.error("Add at least one voter address.");
      return;
    }
    const addrs = valid.map(v => v.address as `0x${string}`);
    const statuses = valid.map(v => v.status);
    return run(
      "voters",
      async () => {
        await writeContractAsync({ functionName: "addVoters", args: [addrs, statuses] });
        setVoterDrafts([{ address: "", status: true }]);
      },
      `Allowlist updated for ${valid.length} address${valid.length === 1 ? "" : "es"} on ${divisionName()}`,
    );
  };

  const handleStartRegistration = () => {
    const sec = parseDurationToSeconds(registrationDuration);
    if (!sec) {
      notification.error("Enter a positive duration (e.g. 01:00:00 or 3600).");
      return;
    }
    return run("startRegistration", () => writeContractAsync({ functionName: "startRegistration", args: [sec] }));
  };

  const handleStartVoting = () => {
    const sec = parseDurationToSeconds(votingDuration);
    if (!sec) {
      notification.error("Enter a positive duration.");
      return;
    }
    return run("startVoting", () => writeContractAsync({ functionName: "startVoting", args: [sec] }));
  };

  const handleEndElection = () => run("endElection", () => writeContractAsync({ functionName: "endElection" }));

  // --- Apply a phase change to EVERY division at once (national control) ---
  //
  // One transaction per division, sequentially. On the custom chain that means
  // one relay call each, which the relay's 30/minute budget comfortably covers
  // for a realistic division count.
  const writeToDivision = (contract: `0x${string}`, functionName: string, args?: unknown[]) =>
    write({ address: contract, abi: VOTING_ABI, functionName, args });

  const runAll = async (label: string, functionName: string, argsFor: () => unknown[] | null, verb: string) => {
    const args = argsFor();
    if (args === null) return;
    await run(label, async () => {
      let ok = 0;
      let skipped = 0;
      setProgress({ done: 0, total: divisions.length });
      try {
        for (const d of divisions) {
          try {
            await writeToDivision(d.votingContract, functionName, args);
            ok += 1;
          } catch {
            skipped += 1; // wrong phase for this division — skip it
          }
          setProgress({ done: ok + skipped, total: divisions.length });
        }
      } finally {
        setProgress(null);
      }
      notification.success(`${verb} on ${ok} division(s)${skipped ? ` · ${skipped} skipped (wrong phase)` : ""}`);
    });
  };

  /**
   * Stop before a national phase change.
   *
   * `Voting` has no route back to an earlier phase short of `resetElection`, so
   * every one of these is a one-way door. The per-division buttons act on the
   * division named in the status panel directly above them; these act on all of
   * them at once, most of which the operator cannot see — which is exactly why
   * the reversible ballot broadcasts already confirmed and these did not.
   */
  const confirmFanout = (action: string, consequence: string) =>
    window.confirm(
      `${action} on all ${divisions.length} division(s)?\n\n${consequence}\n\n` +
        `Divisions in the wrong phase are skipped and left exactly as they are. This cannot be undone.`,
    );

  const handleStartRegistrationAll = () => {
    const sec = parseDurationToSeconds(registrationDuration);
    if (!sec) {
      notification.error("Enter a positive registration duration.");
      return;
    }
    const confirmed = confirmFanout(
      "Start registration",
      `Every division still in Setup opens a ${registrationDuration} registration window. Its ballot question and ` +
        `candidate list are frozen from that moment on.`,
    );
    if (!confirmed) return;

    return runAll("all-registration", "startRegistration", () => [sec], "Registration started");
  };

  const handleStartVotingAll = () => {
    const sec = parseDurationToSeconds(votingDuration);
    if (!sec) {
      notification.error("Enter a positive voting duration.");
      return;
    }
    const confirmed = confirmFanout(
      "Start voting",
      `Every division still in Registration opens a ${votingDuration} voting window. No further voters can be ` +
        `enrolled there once it does.`,
    );
    if (!confirmed) return;

    return runAll("all-voting", "startVoting", () => [sec], "Voting started");
  };

  const handleEndAll = () => {
    const confirmed = confirmFanout(
      "End the election",
      "Voting closes everywhere and the results are frozen. No further votes are accepted on any division.",
    );
    if (!confirmed) return;

    return runAll("all-end", "endElection", () => [], "Ended");
  };

  /**
   * Start a new election: wipe everything the previous one produced.
   *
   * "Reset" used to mean `Voting.resetElection()` on the *selected* division —
   * which left every other division untouched, left the division list itself
   * intact, left the GN officer accounts signed in against those divisions, and
   * left every enrolled NIC permanently reserved. The result looked like a fresh
   * election and behaved like a half-finished one.
   *
   * A new election therefore clears four things, in an order chosen so a failure
   * part-way through leaves the least confusing state:
   *
   *   1. Each division's ballot (`resetElection`), so an old Voting contract
   *      that somehow stays referenced is not sitting on a live tally.
   *   2. The division registry, which is what makes divisions exist at all.
   *   3. Reserved NIC hashes, without which no previous voter could enrol again.
   *   4. The GN officer accounts, whose `divisionId` indexes a list that step 2
   *      just emptied.
   *
   * Steps 1 and 4 are best-effort: neither can undo the registry clear, and
   * stopping on them would leave an election that is already gone looking like
   * it might come back.
   */
  const handleResetElection = () => {
    const ok = window.confirm(
      `Start a NEW election?\n\nThis permanently deletes EVERYTHING from the current election:\n` +
        `  • all ${divisions.length} division(s) and their ballots, voters and votes\n` +
        `  • every GN officer account and their sign-in credentials\n` +
        `  • every NIC enrolment record\n\n` +
        `You will need to create the divisions and GN officers again from scratch. This cannot be undone.`,
    );
    if (!ok) return;

    return run("resetElection", async () => {
      // 1. Blank each division's ballot before it stops being listed.
      for (const d of divisions) {
        try {
          await writeToDivision(d.votingContract, "resetElection", []);
        } catch (e) {
          console.error("resetElection on division", d.name, e);
        }
      }

      // 2. The registry itself. This is the step that actually removes the
      //    divisions, so a failure here must abort — everything after it is
      //    cleanup that only makes sense once the list is gone.
      if (!registryAddress) throw new Error("ElectionRegistry is not deployed on this chain.");
      await write({
        address: registryAddress,
        abi: CLEAR_DIVISIONS_ABI as unknown as Abi,
        functionName: "clearDivisions",
      });

      // 3. NIC reservations, so the same citizens can enrol again.
      if (nicRegistryAddress) {
        try {
          await write({
            address: nicRegistryAddress,
            abi: CLEAR_NIC_HASHES_ABI as unknown as Abi,
            functionName: "clearNicHashes",
          });
        } catch (e) {
          console.error("clearNicHashes", e);
          notification.warning("Divisions were cleared, but NIC enrolment records could not be released.");
        }
      }

      // 4. GN officer accounts (custom chain only — in hardhat mode an officer
      //    is a wallet the server never held).
      if (isCustom) {
        try {
          const response = await fetch("/api/gn-accounts?all=true", {
            method: "DELETE",
            credentials: "same-origin",
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
        } catch (e) {
          console.error("clear gn accounts", e);
          notification.warning("Divisions were cleared, but the GN officer accounts could not be deleted.");
        }
      }

      // Local-only leftovers: hidden-division ids point at indices that no
      // longer exist, so keeping them would hide whichever divisions are
      // created next.
      try {
        localStorage.removeItem("hiddenDivisions");
      } catch {}

      setSelectedIdx(0);
      setQuestionDraft("");
      setCandidateDrafts(["", ""]);
      setVoterDrafts([{ address: "", status: true }]);
      setRegistrationDuration("01:00:00");
      setVotingDuration("01:00:00");

      notification.success("New election started — all previous data cleared. Create your divisions to begin.");
    });
  };

  // Access gate.
  if (isCustom && authLoading) {
    return (
      <GateFrame>
        <div className="flex justify-center py-8">
          <span className="loading loading-spinner" />
        </div>
      </GateFrame>
    );
  }
  if (isCustom ? !isAdmin : !connected) {
    return (
      <GateFrame>
        {isCustom ? (
          <div className="text-center space-y-4">
            <p className="opacity-70">Sign in as the Election Authority to use this page.</p>
            <Link href="/login?next=%2Fvoting%2Fadmin" className="btn btn-primary btn-sm">
              Sign in
            </Link>
          </div>
        ) : (
          <p className="text-center opacity-70">Connect a wallet to view this page.</p>
        )}
      </GateFrame>
    );
  }
  if (!isOwner) {
    return (
      <GateFrame>
        <p className="text-center opacity-70">
          You are not the contract owner. Returning to the voting page is recommended.
        </p>
        <div className="flex justify-center mt-4">
          <button className="btn btn-primary btn-sm" onClick={() => router.push("/voting")}>
            Back to voting
          </button>
        </div>
      </GateFrame>
    );
  }

  const value: AdminElectionValue = {
    isCustom,
    divisions,
    divisionsLoading,
    selectedIdx,
    setSelectedIdx,
    selectedDiv,
    phase,
    phaseLabel,
    registrationEnd,
    votingEnd,
    now,
    candList,
    inSetup,
    inRegistration,
    inVoting,
    ended,
    questionDraft,
    setQuestionDraft,
    candidateDrafts,
    setCandidateDrafts,
    voterDrafts,
    setVoterDrafts,
    registrationDuration,
    setRegistrationDuration,
    votingDuration,
    setVotingDuration,
    busy,
    progress,
    handleSetQuestion,
    handleSetQuestionAll,
    handleSetCandidates,
    handleSetCandidatesAll,
    handleAddVoters,
    handleStartRegistration,
    handleStartVoting,
    handleEndElection,
    handleStartRegistrationAll,
    handleStartVotingAll,
    handleEndAll,
    handleResetElection,
    strictEnrolment,
    handleSetStrictEnrolment,
  };

  return (
    <AdminElectionContext.Provider value={value}>
      <div className="w-full max-w-5xl mx-auto space-y-5">
        <AdminTabs />
        {children}
      </div>
    </AdminElectionContext.Provider>
  );
};
