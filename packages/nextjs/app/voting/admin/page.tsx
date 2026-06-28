"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AddressInput } from "@scaffold-ui/components";
import { useAccount } from "wagmi";
import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useIsVotingOwner, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
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
  const isOwner = useIsVotingOwner();

  const { data: votingData, refetch: refetchVoting } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getVotingData",
  });

  const { data: candidates, refetch: refetchCandidates } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getCandidates",
  });

  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "Voting" });

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
      await Promise.all([refetchVoting(), refetchCandidates()]);
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
      <PhaseHeader
        phaseLabel={phaseLabel}
        phase={phase}
        registrationEnd={registrationEnd}
        votingEnd={votingEnd}
        now={now}
      />

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

      <Section title="3. Allowlist voters" disabled={!inSetup} hint="Editable only during Setup phase.">
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
                  disabled={!inSetup}
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
                  disabled={!inSetup}
                />
              </label>
              <button
                className="btn btn-ghost btn-square"
                disabled={!inSetup || voterDrafts.length <= 1}
                onClick={() => setVoterDrafts(voterDrafts.filter((_, j) => j !== i))}
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            className="btn btn-outline btn-sm gap-2"
            disabled={!inSetup}
            onClick={() => setVoterDrafts([...voterDrafts, { address: "", status: true }])}
          >
            <PlusIcon className="h-4 w-4" /> Add row
          </button>
        </div>
        <div className="flex justify-end">
          <button className="btn btn-primary btn-sm" disabled={!inSetup || busy === "voters"} onClick={handleAddVoters}>
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
    </Wrapper>
  );
};

export default AdminPage;

// ----- helpers -----

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center justify-center flex-col grow pt-6 w-full">
    <div className="px-4 sm:px-5 w-full max-w-7xl mx-auto">
      <div className="flex flex-col items-center w-full">
        <div className="text-center mb-8 relative">
          <div className="absolute inset-0 bg-gradient-to-r from-primary/10 via-secondary/10 to-primary/10 blur-3xl -z-10 rounded-full w-3/4 h-full mx-auto" />
          <h1 className="text-4xl md:text-5xl font-extrabold bg-gradient-to-br from-primary to-secondary text-transparent bg-clip-text drop-shadow-sm">Election Admin</h1>
          <p className="text-base md:text-lg opacity-70 mt-3 font-medium">Owner-only controls for the Voting contract</p>
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
