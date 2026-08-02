"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AddressInput } from "@scaffold-ui/components";
import { createPublicClient, http } from "viem";
import { useAccount } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import deployedContracts from "~~/contracts/deployedContracts";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { LiveDivision, useDivisions } from "~~/hooks/useDivisions";
import { wagmiConfig } from "~~/services/web3/wagmiConfig";
import { notification } from "~~/utils/scaffold-eth";

const PHASE_LABELS = ["Setup", "Registration", "Voting", "Ended"] as const;

type VoterEntry = { address: string; status: boolean };

// Convert "hh:mm:ss" or "mm:ss" or seconds string to seconds.
function parseDurationToSeconds(raw: string): bigint | null {
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

const AdminPage = () => {
  const router = useRouter();
  const { address: connected } = useAccount();
  const { targetNetwork } = useTargetNetwork();
  const { divisions, isLoading: divisionsLoading } = useDivisions();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const selectedDiv = divisions[selectedIdx];

  // Full Voting ABI (all admin functions) for reads/writes to any division contract.
  const VOTING_ABI = useMemo(
    () => (deployedContracts as Record<number, any>)[targetNetwork.id]?.Voting?.abi ?? [],
    [targetNetwork.id],
  );

  const publicClient = useMemo(
    () => createPublicClient({ chain: targetNetwork, transport: http(targetNetwork.rpcUrls.default.http[0]) }),
    [targetNetwork],
  );

  const [votingData, setVotingData] = useState<readonly unknown[] | undefined>(undefined);
  const [candidates, setCandidates] = useState<readonly string[] | undefined>(undefined);
  const [ownerAddr, setOwnerAddr] = useState<string | undefined>(undefined);

  // Read the SELECTED division's live election data.
  const refetchDivision = useCallback(async () => {
    if (!selectedDiv) return;
    try {
      const [vd, cands, owner] = await Promise.all([
        publicClient.readContract({
          address: selectedDiv.votingContract,
          abi: VOTING_ABI,
          functionName: "getVotingData",
          args: [],
        }),
        publicClient.readContract({
          address: selectedDiv.votingContract,
          abi: VOTING_ABI,
          functionName: "getCandidates",
          args: [],
        }),
        publicClient.readContract({
          address: selectedDiv.votingContract,
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
  }, [selectedDiv, publicClient, VOTING_ABI]);

  useEffect(() => {
    setVotingData(undefined);
    setCandidates(undefined);
    refetchDivision();
  }, [refetchDivision]);

  // Every division contract is owned by the Election Authority (deployer). Treat the
  // page as accessible while ownership is still loading; block only if confirmed not-owner.
  const isOwner = ownerAddr ? connected?.toLowerCase() === ownerAddr.toLowerCase() : true;

  // Division-targeting write: routes every admin action to the SELECTED division contract.
  const writeContractAsync = useCallback(
    async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      if (!selectedDiv) throw new Error("No division selected");
      const walletClient = await getWalletClient(wagmiConfig);
      if (!walletClient) throw new Error("No wallet connected");
      const hash = await walletClient.writeContract({
        address: selectedDiv.votingContract,
        abi: VOTING_ABI,
        functionName,
        args: args ?? [],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      return hash;
    },
    [selectedDiv, publicClient, VOTING_ABI],
  );

  const question = (votingData?.[0] as string | undefined) ?? "";
  const phase = Number(votingData?.[2] ?? 0);
  const registrationEnd = Number(votingData?.[3] ?? 0);
  const votingEnd = Number(votingData?.[4] ?? 0);
  const candList = (candidates as readonly string[] | undefined) ?? [];

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

  // Access gate.
  if (!connected) {
    return (
      <Wrapper>
        <p className="text-center opacity-70">Connect a wallet to view this page.</p>
      </Wrapper>
    );
  }
  if (!isOwner) {
    return (
      <Wrapper>
        <p className="text-center opacity-70">
          You are not the contract owner. Returning to the voting page is recommended.
        </p>
        <div className="flex justify-center mt-4">
          <button className="btn btn-primary btn-sm" onClick={() => router.push("/voting")}>
            Back to voting
          </button>
        </div>
      </Wrapper>
    );
  }

  // --- Action handlers ---
  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      setBusy(label);
      await fn();
      await refetchDivision();
    } catch (e: any) {
      console.error(label, e);
      notification.error(e?.shortMessage || e?.message || "Transaction failed");
    } finally {
      setBusy(null);
    }
  };

  const handleSetQuestion = () =>
    run("question", () => writeContractAsync({ functionName: "setQuestion", args: [questionDraft] }));

  const handleSetCandidates = () => {
    const cleaned = candidateDrafts.map(c => c.trim()).filter(c => c.length > 0);
    if (cleaned.length === 0) {
      notification.error("Add at least one candidate.");
      return;
    }
    if (cleaned.length > 100) {
      notification.error("Maximum 100 candidates.");
      return;
    }
    return run("candidates", () => writeContractAsync({ functionName: "setCandidates", args: [cleaned] }));
  };

  const handleAddVoters = () => {
    const valid = voterDrafts.filter(v => v.address.trim() !== "");
    if (valid.length === 0) {
      notification.error("Add at least one voter address.");
      return;
    }
    const addrs = valid.map(v => v.address as `0x${string}`);
    const statuses = valid.map(v => v.status);
    return run("voters", async () => {
      await writeContractAsync({ functionName: "addVoters", args: [addrs, statuses] });
      setVoterDrafts([{ address: "", status: true }]);
    });
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
  const writeToDivision = async (contract: `0x${string}`, functionName: string, args?: unknown[]) => {
    const walletClient = await getWalletClient(wagmiConfig);
    if (!walletClient) throw new Error("No wallet connected");
    const hash = await walletClient.writeContract({
      address: contract,
      abi: VOTING_ABI,
      functionName,
      args: args ?? [],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  };

  const runAll = async (label: string, functionName: string, argsFor: () => unknown[] | null, verb: string) => {
    const args = argsFor();
    if (args === null) return;
    await run(label, async () => {
      let ok = 0;
      let skipped = 0;
      for (const d of divisions) {
        try {
          await writeToDivision(d.votingContract, functionName, args);
          ok += 1;
        } catch {
          skipped += 1; // wrong phase for this division — skip it
        }
      }
      notification.success(`${verb} on ${ok} division(s)${skipped ? ` · ${skipped} skipped (wrong phase)` : ""}`);
    });
  };

  const handleStartRegistrationAll = () =>
    runAll(
      "all-registration",
      "startRegistration",
      () => {
        const sec = parseDurationToSeconds(registrationDuration);
        if (!sec) {
          notification.error("Enter a positive registration duration.");
          return null;
        }
        return [sec];
      },
      "Registration started",
    );

  const handleStartVotingAll = () =>
    runAll(
      "all-voting",
      "startVoting",
      () => {
        const sec = parseDurationToSeconds(votingDuration);
        if (!sec) {
          notification.error("Enter a positive voting duration.");
          return null;
        }
        return [sec];
      },
      "Voting started",
    );

  const handleEndAll = () => runAll("all-end", "endElection", () => [], "Ended");

  const handleResetElection = () => {
    const ok = window.confirm(
      "Start a NEW election?\n\nThis permanently clears the current question, candidates, voter allowlist, " +
        "registrations and votes, and returns the contract to the Setup phase. This cannot be undone.",
    );
    if (!ok) return;
    return run("resetElection", async () => {
      await writeContractAsync({ functionName: "resetElection" });
      setQuestionDraft("");
      setCandidateDrafts(["", ""]);
      setVoterDrafts([{ address: "", status: true }]);
      setRegistrationDuration("01:00:00");
      setVotingDuration("01:00:00");
    });
  };

  // --- Render ---
  return (
    <Wrapper>
      {/* Division selector — every control below targets the chosen division contract. */}
      <div className="bg-base-100/60 backdrop-blur-xl shadow-2xl rounded-3xl p-6 border border-base-300/50">
        <div className="text-sm font-bold block mb-2">🏛️ Configuring division</div>
        {divisionsLoading && divisions.length === 0 ? (
          <div className="flex items-center gap-2 opacity-60 text-sm">
            <span className="loading loading-spinner loading-sm">&nbsp;</span>
            Loading divisions…
          </div>
        ) : (
          <DivisionPicker
            divisions={divisions}
            selectedIdx={selectedIdx}
            setSelectedIdx={setSelectedIdx}
            selectedName={selectedDiv?.name}
          />
        )}
      </div>

      <PhaseHeader
        phaseLabel={phaseLabel}
        phase={phase}
        registrationEnd={registrationEnd}
        votingEnd={votingEnd}
        now={now}
      />

      <Section
        title="🌐 Run election on ALL divisions"
        hint="One click advances the phase on every division. Divisions in the wrong phase are skipped automatically."
      >
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-info btn-sm" disabled={!!busy} onClick={handleStartRegistrationAll}>
            {busy === "all-registration" ? "Starting…" : "▶ Start Registration — ALL"}
          </button>
          <button className="btn btn-success btn-sm" disabled={!!busy} onClick={handleStartVotingAll}>
            {busy === "all-voting" ? "Starting…" : "▶ Start Voting — ALL"}
          </button>
          <button className="btn btn-error btn-outline btn-sm" disabled={!!busy} onClick={handleEndAll}>
            {busy === "all-end" ? "Ending…" : "⏹ End — ALL"}
          </button>
        </div>
        <p className="text-xs opacity-50 mt-2">
          Uses the durations set in sections 4 &amp; 5 below. Applies to all {divisions.length} division(s).
        </p>
      </Section>

      <Section title="1. Ballot question" disabled={!inSetup} hint="Editable only during Setup phase.">
        <textarea
          className="textarea textarea-bordered w-full"
          rows={2}
          value={questionDraft}
          onChange={e => setQuestionDraft(e.target.value)}
          disabled={!inSetup}
        />
        <div className="flex justify-end">
          <button
            className="btn btn-primary btn-sm"
            disabled={!inSetup || busy === "question" || !questionDraft.trim()}
            onClick={handleSetQuestion}
          >
            {busy === "question" ? "Saving..." : "Save question"}
          </button>
        </div>
      </Section>

      <Section
        title="2. Candidates"
        disabled={!inSetup}
        hint={`Editable only during Setup. Max 100 entries. Current: ${candList.length}.`}
      >
        <div className="space-y-2">
          {candidateDrafts.map((c, i) => (
            <div key={i} className="flex gap-2">
              <input
                type="text"
                className="input input-bordered flex-1"
                placeholder={`Candidate #${i + 1}`}
                value={c}
                onChange={e => {
                  const next = candidateDrafts.slice();
                  next[i] = e.target.value;
                  setCandidateDrafts(next);
                }}
                disabled={!inSetup}
              />
              <button
                className="btn btn-ghost btn-square"
                disabled={!inSetup || candidateDrafts.length <= 1}
                onClick={() => setCandidateDrafts(candidateDrafts.filter((_, j) => j !== i))}
                title="Remove"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            className="btn btn-outline btn-sm gap-2"
            disabled={!inSetup || candidateDrafts.length >= 100}
            onClick={() => setCandidateDrafts([...candidateDrafts, ""])}
          >
            <PlusIcon className="h-4 w-4" /> Add candidate
          </button>
        </div>
        <div className="flex justify-end">
          <button
            className="btn btn-primary btn-sm"
            disabled={!inSetup || busy === "candidates"}
            onClick={handleSetCandidates}
          >
            {busy === "candidates" ? "Saving..." : "Save candidates"}
          </button>
        </div>
      </Section>

      <Section
        title="3. Allowlist voters"
        disabled={!inSetup && !inRegistration}
        hint="Editable during Setup and Registration phases."
      >
        <div className="space-y-2">
          {voterDrafts.map((v, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 p-2 border border-base-300 rounded-lg">
              <div className="flex-1 min-w-[260px]">
                <AddressInput
                  placeholder="0x..."
                  value={v.address}
                  onChange={val => {
                    const next = voterDrafts.slice();
                    next[i] = { ...next[i], address: val as string };
                    setVoterDrafts(next);
                  }}
                />
              </div>
              <label className="label cursor-pointer gap-2">
                <span className="label-text text-sm">Allow</span>
                <input
                  type="radio"
                  name={`vstatus-${i}`}
                  className="radio radio-sm radio-success"
                  checked={v.status}
                  onChange={() => {
                    const next = voterDrafts.slice();
                    next[i] = { ...next[i], status: true };
                    setVoterDrafts(next);
                  }}
                  disabled={!inSetup && !inRegistration}
                />
              </label>
              <label className="label cursor-pointer gap-2">
                <span className="label-text text-sm">Revoke</span>
                <input
                  type="radio"
                  name={`vstatus-${i}`}
                  className="radio radio-sm radio-error"
                  checked={!v.status}
                  onChange={() => {
                    const next = voterDrafts.slice();
                    next[i] = { ...next[i], status: false };
                    setVoterDrafts(next);
                  }}
                  disabled={!inSetup && !inRegistration}
                />
              </label>
              <button
                className="btn btn-ghost btn-square"
                disabled={(!inSetup && !inRegistration) || voterDrafts.length <= 1}
                onClick={() => setVoterDrafts(voterDrafts.filter((_, j) => j !== i))}
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            className="btn btn-outline btn-sm gap-2"
            disabled={!inSetup && !inRegistration}
            onClick={() => setVoterDrafts([...voterDrafts, { address: "", status: true }])}
          >
            <PlusIcon className="h-4 w-4" /> Add row
          </button>
        </div>
        <div className="flex justify-end">
          <button
            className="btn btn-primary btn-sm"
            disabled={(!inSetup && !inRegistration) || busy === "voters"}
            onClick={handleAddVoters}
          >
            {busy === "voters" ? "Saving..." : "Submit allowlist"}
          </button>
        </div>
      </Section>

      <Section
        title="4. Phase controls"
        hint="Durations accept hh:mm:ss, mm:ss, or raw seconds (e.g. 01:00:00 or 3600)."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="reg-duration" className="text-sm font-semibold block">
              Registration duration
            </label>
            <input
              id="reg-duration"
              type="text"
              className="input input-bordered w-full"
              value={registrationDuration}
              onChange={e => setRegistrationDuration(e.target.value)}
              disabled={!inSetup}
            />
            <button
              className="btn btn-primary btn-sm w-full"
              disabled={!inSetup || busy === "startRegistration"}
              onClick={handleStartRegistration}
            >
              {busy === "startRegistration" ? "Starting..." : "Start registration phase"}
            </button>
          </div>

          <div className="space-y-2">
            <label htmlFor="vote-duration" className="text-sm font-semibold block">
              Voting duration
            </label>
            <input
              id="vote-duration"
              type="text"
              className="input input-bordered w-full"
              value={votingDuration}
              onChange={e => setVotingDuration(e.target.value)}
              disabled={!inRegistration}
            />
            <button
              className="btn btn-primary btn-sm w-full"
              disabled={!inRegistration || busy === "startVoting"}
              onClick={handleStartVoting}
            >
              {busy === "startVoting" ? "Starting..." : "Start voting phase"}
            </button>
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <button
            className="btn btn-error btn-sm"
            disabled={ended || inSetup || busy === "endElection"}
            onClick={handleEndElection}
          >
            {busy === "endElection" ? "Ending..." : "End election now"}
          </button>
        </div>

        {inVoting && (
          <p className="text-xs opacity-60">
            Voting auto-closes at the configured deadline; the button above closes it early.
          </p>
        )}
        {ended && <p className="text-xs opacity-60">Election has ended. Results are frozen.</p>}
      </Section>

      <Section
        title="5. Start a new election"
        hint="Clears the current question, candidates, voters, registrations and votes, then returns to Setup. Use this to run another election without redeploying."
      >
        {ended ? (
          <p className="text-xs opacity-70">
            The election has ended. Start a new one to reset the contract back to a clean Setup phase.
          </p>
        ) : (
          <p className="text-xs opacity-70 text-warning">
            Warning: the current election is still {phaseLabel.toLowerCase()}. Resetting now will discard all current
            progress.
          </p>
        )}
        <div className="flex justify-end pt-2">
          <button className="btn btn-error btn-sm" disabled={busy === "resetElection"} onClick={handleResetElection}>
            {busy === "resetElection" ? "Resetting..." : "Start new election"}
          </button>
        </div>
      </Section>

      <AddDivisionSection />

      <GNManagementSection />
    </Wrapper>
  );
};

export default AdminPage;

// ----- helpers -----

const DivisionPicker = ({
  divisions,
  selectedIdx,
  setSelectedIdx,
  selectedName,
}: {
  divisions: LiveDivision[];
  selectedIdx: number;
  setSelectedIdx: (i: number) => void;
  selectedName?: string;
}) => {
  if (divisions.length === 0) {
    return <p className="text-sm opacity-60">No divisions registered. Deploy divisions first.</p>;
  }
  return (
    <>
      <select
        className="select select-bordered w-full"
        value={selectedIdx}
        onChange={e => setSelectedIdx(Number(e.target.value))}
      >
        {divisions.map((d, i) => (
          <option key={d.votingContract} value={i}>
            {d.name} — {PHASE_LABELS[d.phase]} — {d.votingContract.slice(0, 10)}…
          </option>
        ))}
      </select>
      <p className="text-xs opacity-50 mt-2">
        All actions on this page (question, candidates, allowlist, phases, reset) apply to{" "}
        <strong>{selectedName}</strong>.
      </p>
    </>
  );
};

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center justify-center flex-col grow pt-6 w-full">
    <div className="px-4 sm:px-5 w-full max-w-7xl mx-auto">
      <div className="flex flex-col items-center w-full">
        <div className="text-center mb-8 relative">
          <div className="absolute inset-0 bg-gradient-to-r from-primary/10 via-secondary/10 to-primary/10 blur-3xl -z-10 rounded-full w-3/4 h-full mx-auto" />
          <h1 className="text-4xl md:text-5xl font-extrabold bg-gradient-to-br from-primary to-secondary text-transparent bg-clip-text drop-shadow-sm">
            Election Admin
          </h1>
          <p className="text-base md:text-lg opacity-70 mt-3 font-medium">
            Owner-only controls for the Voting contract
          </p>
        </div>
        <div className="w-full max-w-3xl space-y-5">{children}</div>
      </div>
    </div>
  </div>
);

const Section = ({
  title,
  hint,
  children,
  disabled,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  disabled?: boolean;
}) => (
  <div
    className={`bg-base-100/60 backdrop-blur-xl shadow-2xl rounded-3xl p-8 space-y-6 border border-base-300/50 hover:border-primary/30 transition-all duration-500 relative overflow-hidden ${disabled ? "opacity-70" : ""}`}
  >
    <div>
      <h2 className="text-xl font-bold">{title}</h2>
      {hint && <p className="text-xs opacity-60 mt-1">{hint}</p>}
    </div>
    {children}
  </div>
);

const PhaseHeader = ({
  phaseLabel,
  phase,
  registrationEnd,
  votingEnd,
  now,
}: {
  phaseLabel: string;
  phase: number;
  registrationEnd: number;
  votingEnd: number;
  now: number;
}) => {
  const remaining =
    phase === 1 && registrationEnd > now
      ? `${registrationEnd - now}s until registration closes`
      : phase === 2 && votingEnd > now
        ? `${votingEnd - now}s until voting closes`
        : null;

  const badge =
    phase === 0 ? "badge-ghost" : phase === 1 ? "badge-info" : phase === 2 ? "badge-success" : "badge-neutral";

  return (
    <div className="bg-base-100/60 backdrop-blur-xl shadow-2xl rounded-3xl p-6 border border-base-300/50 flex flex-wrap justify-between items-center gap-3 relative overflow-hidden">
      <span className={`badge ${badge} badge-lg`}>Phase: {phaseLabel}</span>
      {remaining && <span className="text-xs font-mono opacity-80">{remaining}</span>}
    </div>
  );
};

const GNManagementSection = () => {
  const [gnAddress, setGnAddress] = useState("");
  const [selectedDivision, setSelectedDivision] = useState(0);
  const { divisions, isLoading: divisionsLoading, error: divisionsError, refetch } = useDivisions();
  const { targetNetwork } = useTargetNetwork();
  const publicClient = useMemo(
    () => createPublicClient({ chain: targetNetwork, transport: http(targetNetwork.rpcUrls.default.http[0]) }),
    [targetNetwork],
  );

  // Keep selection valid as divisions load in.
  useEffect(() => {
    if (divisions.length > 0 && selectedDivision >= divisions.length) {
      setSelectedDivision(0);
    }
  }, [divisions.length, selectedDivision]);

  const handleAssignGN = async () => {
    if (!gnAddress || !gnAddress.startsWith("0x") || gnAddress.length !== 42) {
      notification.error("Enter a valid Ethereum address.");
      return;
    }
    const div = divisions[selectedDivision];
    if (!div) {
      notification.error("No division selected.");
      return;
    }
    try {
      const { getWalletClient } = await import("wagmi/actions");
      const { wagmiConfig } = await import("~~/services/web3/wagmiConfig");

      // Get the currently connected wallet from wagmi (RainbowKit)
      const walletClient = await getWalletClient(wagmiConfig);
      if (!walletClient) {
        notification.error("No wallet connected. Connect your wallet first.");
        return;
      }

      const abi = [
        {
          name: "setGNOfficer",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [{ name: "_gnOfficer", type: "address" }],
          outputs: [],
        },
      ] as const;

      const hash = await walletClient.writeContract({
        address: div.votingContract,
        abi,
        functionName: "setGNOfficer",
        args: [gnAddress as `0x${string}`],
      });

      await publicClient.waitForTransactionReceipt({ hash });
      notification.success(`✅ GN assigned to ${div.name}!`);
      setGnAddress("");
      refetch();
    } catch (e: any) {
      notification.error(e?.shortMessage || e?.message || "Failed to assign GN");
    }
  };

  const selected = divisions[selectedDivision];
  const currentDivGN = selected?.gnOfficer || "";
  const isZeroAddr = !currentDivGN || currentDivGN === "0x0000000000000000000000000000000000000000";

  return (
    <Section title="6. GN Officer Management" hint="Assign GN officers to specific polling divisions.">
      {divisionsError && (
        <div className="alert alert-error mb-4 text-sm">
          <span>⚠️ {divisionsError}</span>
        </div>
      )}
      {divisionsLoading && divisions.length === 0 ? (
        <div className="flex items-center gap-2 py-6 opacity-60">
          <span className="loading loading-spinner loading-sm"></span>
          <span>Loading divisions from the ElectionRegistry…</span>
        </div>
      ) : divisions.length === 0 ? (
        <div className="text-sm opacity-60 py-4">No divisions registered yet. Deploy divisions first.</div>
      ) : (
        <>
          {/* Division Selector */}
          <div className="form-control mb-4">
            <label className="label">
              <span className="label-text text-sm font-bold">Select Division</span>
            </label>
            <select
              className="select select-bordered w-full"
              value={selectedDivision}
              onChange={e => setSelectedDivision(Number(e.target.value))}
            >
              {divisions.map((div, idx) => (
                <option key={div.votingContract} value={idx}>
                  {div.name} — {div.votingContract.slice(0, 10)}...
                </option>
              ))}
            </select>
          </div>

          {/* Current GN for selected division */}
          <div className="p-3 bg-base-200/50 rounded-lg mb-4">
            <div className="text-xs opacity-60 mb-1">
              Current GN for <strong>{selected?.name}</strong>
            </div>
            <div className="font-mono text-sm">
              {!isZeroAddr ? (
                <span className="text-success">{currentDivGN}</span>
              ) : (
                <span className="opacity-40">None assigned</span>
              )}
            </div>
          </div>

          {/* All divisions overview */}
          <div className="overflow-x-auto mb-4">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Division</th>
                  <th>GN Officer</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {divisions.map((div, idx) => {
                  const gn = div.gnOfficer || "";
                  const assigned = gn && gn !== "0x0000000000000000000000000000000000000000";
                  return (
                    <tr key={div.votingContract} className={selectedDivision === idx ? "bg-primary/10" : ""}>
                      <td className="font-bold">{div.name}</td>
                      <td className="font-mono text-xs">{assigned ? `${gn.slice(0, 10)}...${gn.slice(-4)}` : "—"}</td>
                      <td>
                        {assigned ? (
                          <span className="badge badge-success badge-xs">Assigned</span>
                        ) : (
                          <span className="badge badge-ghost badge-xs">Empty</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Assign new GN */}
          <div className="space-y-3">
            <div className="form-control">
              <label className="label">
                <span className="label-text text-sm">New GN Address for {selected?.name}</span>
              </label>
              <AddressInput value={gnAddress} onChange={setGnAddress} placeholder="0x..." />
            </div>

            <div className="flex gap-2 justify-end">
              <button className="btn btn-primary btn-sm" disabled={!gnAddress} onClick={handleAssignGN}>
                Assign GN to {selected?.name}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Test accounts */}
      <div className="text-xs opacity-40 mt-3">
        <details>
          <summary className="cursor-pointer">Test GN accounts (Hardhat)</summary>
          <div className="mt-2 space-y-1 font-mono text-xs">
            <div>GN Kaduwela (#1): 0x70997970C51812dc3A010C7d01b50e0d17dc79C8</div>
            <div>GN Colombo (#2): 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC</div>
            <div>GN Gampaha (#3): 0x90F79bf6EB2c4f870365E785982E1f101E93b906</div>
          </div>
        </details>
      </div>
    </Section>
  );
};

const AddDivisionSection = () => {
  const [divisionName, setDivisionName] = useState("");
  const [isDeploying, setIsDeploying] = useState(false);
  const { refetch } = useDivisions();
  const { targetNetwork } = useTargetNetwork();

  const REGISTRY_ABI = useMemo(
    () => (deployedContracts as Record<number, any>)[targetNetwork.id]?.ElectionRegistry?.abi ?? [],
    [targetNetwork.id],
  );
  const REGISTRY_ADDRESS = useMemo(
    () =>
      (deployedContracts as Record<number, any>)[targetNetwork.id]?.ElectionRegistry?.address as
        | `0x${string}`
        | undefined,
    [targetNetwork.id],
  );

  const publicClient = useMemo(
    () => createPublicClient({ chain: targetNetwork, transport: http(targetNetwork.rpcUrls.default.http[0]) }),
    [targetNetwork],
  );

  const handleCreateDivision = async () => {
    const name = divisionName.trim();
    if (!name) {
      notification.error("Enter a division name.");
      return;
    }
    if (!REGISTRY_ADDRESS) {
      notification.error("ElectionRegistry contract not found.");
      return;
    }
    setIsDeploying(true);
    try {
      const walletClient = await getWalletClient(wagmiConfig);
      if (!walletClient) {
        notification.error("No wallet connected.");
        return;
      }
      const hash = await walletClient.writeContract({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: "createDivision",
        args: [name],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      notification.success(`✅ Division "${name}" deployed & registered!`);
      setDivisionName("");
      refetch();
    } catch (e: any) {
      const msg = e?.shortMessage || e?.message || "Failed to create division";
      notification.error(msg);
    } finally {
      setIsDeploying(false);
    }
  };

  return (
    <Section
      title="7. Add New Division"
      hint="Deploy a new Voting contract and register it as a polling division. You can assign a GN officer afterwards using section 6."
    >
      <div className="space-y-4">
        <div className="form-control">
          <label className="label">
            <span className="label-text text-sm font-bold">Division Name</span>
          </label>
          <input
            type="text"
            className="input input-bordered w-full"
            placeholder="e.g. Kandy, Matara, Jaffna..."
            value={divisionName}
            onChange={e => setDivisionName(e.target.value)}
            disabled={isDeploying}
          />
        </div>
        <p className="text-xs opacity-50">
          This deploys a fresh Voting contract on-chain via the ElectionRegistry factory. The new division starts in the
          Setup phase with no question, candidates, or voters. Configure it using the division picker above.
        </p>
        <div className="flex justify-end">
          <button
            className={`btn btn-primary btn-sm ${isDeploying ? "loading" : ""}`}
            disabled={isDeploying || !divisionName.trim()}
            onClick={handleCreateDivision}
          >
            {isDeploying ? "Deploying..." : "➕ Deploy & Register Division"}
          </button>
        </div>
      </div>
    </Section>
  );
};
