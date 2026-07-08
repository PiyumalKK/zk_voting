"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AddressInput } from "@scaffold-ui/components";
import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { mapChainError } from "~~/services/chain/errors";
import { isCustomChain, useAdminAccess, useAdminActions, useCandidates, useVotingData } from "~~/services/chain/hooks";
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
  // Backend-agnostic admin gate: EVM → connected wallet must be the contract
  // owner; custom chain → dashboard password unlocking the signing proxy.
  const { isAdmin, requiresWallet, walletConnected, login, logout } = useAdminAccess();

  const { data: votingData, refetch: refetchVoting } = useVotingData();
  const { data: candList, refetch: refetchCandidates } = useCandidates();
  const actions = useAdminActions();

  const question = votingData?.question ?? "";
  const phase = votingData?.phase ?? 0;
  const registrationEnd = votingData?.registrationEndTime ?? 0;
  const votingEnd = votingData?.votingEndTime ?? 0;

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
  if (requiresWallet && !walletConnected) {
    return (
      <Wrapper>
        <p className="text-center opacity-70">Connect a wallet to view this page.</p>
      </Wrapper>
    );
  }
  if (!isAdmin) {
    if (isCustomChain) {
      return (
        <Wrapper>
          <AdminLogin onLogin={login} />
        </Wrapper>
      );
    }
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
      notification.error(mapChainError(e?.raw ?? e?.shortMessage ?? e?.message ?? "", "Transaction failed"));
    } finally {
      setBusy(null);
    }
  };

  const handleSetQuestion = () => run("question", () => actions.setQuestion(questionDraft));

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
    return run("candidates", () => actions.setCandidates(cleaned));
  };

  const handleAddVoters = () => {
    const valid = voterDrafts.filter(v => v.address.trim() !== "");
    if (valid.length === 0) {
      notification.error(isCustomChain ? "Add at least one voter ID." : "Add at least one voter address.");
      return;
    }
    return run("voters", async () => {
      await actions.addVoters(valid.map(v => ({ id: v.address.trim(), allowed: v.status })));
      setVoterDrafts([{ address: "", status: true }]);
    });
  };

  const handleStartRegistration = () => {
    const sec = parseDurationToSeconds(registrationDuration);
    if (!sec) {
      notification.error("Enter a positive duration (e.g. 01:00:00 or 3600).");
      return;
    }
    return run("startRegistration", () => actions.startRegistration(sec));
  };

  const handleStartVoting = () => {
    const sec = parseDurationToSeconds(votingDuration);
    if (!sec) {
      notification.error("Enter a positive duration.");
      return;
    }
    return run("startVoting", () => actions.startVoting(sec));
  };

  const handleEndElection = () => run("endElection", () => actions.endElection());

  const handleResetElection = () => {
    const ok = window.confirm(
      "Start a NEW election?\n\nThis permanently clears the current question, candidates, voter allowlist, " +
        "registrations and votes, and returns the contract to the Setup phase. This cannot be undone.",
    );
    if (!ok) return;
    return run("resetElection", async () => {
      await actions.resetElection();
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
        onLogout={isCustomChain ? logout : undefined}
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

      <Section
        title="3. Allowlist voters"
        disabled={!inSetup}
        hint={
          isCustomChain
            ? "Editable only during Setup phase. Voter IDs are the identifiers voters will register with (e.g. email addresses)."
            : "Editable only during Setup phase."
        }
      >
        <div className="space-y-2">
          {voterDrafts.map((v, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 p-2 border border-base-300 rounded-lg">
              <div className="flex-1 min-w-[260px]">
                {isCustomChain ? (
                  <input
                    type="text"
                    className="input input-bordered w-full"
                    placeholder="voter@example.com"
                    value={v.address}
                    onChange={e => {
                      const next = voterDrafts.slice();
                      next[i] = { ...next[i], address: e.target.value };
                      setVoterDrafts(next);
                    }}
                    disabled={!inSetup}
                  />
                ) : (
                  <AddressInput
                    placeholder="0x..."
                    value={v.address}
                    onChange={val => {
                      const next = voterDrafts.slice();
                      next[i] = { ...next[i], address: val as string };
                      setVoterDrafts(next);
                    }}
                  />
                )}
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

/** Password gate for the custom chain backend (unlocks the admin signing proxy). */
const AdminLogin = ({ onLogin }: { onLogin: (password: string) => Promise<void> }) => {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (!password) return;
    setPending(true);
    try {
      await onLogin(password);
    } catch (e: any) {
      notification.error(e?.message ?? "Login failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="bg-base-100/60 backdrop-blur-xl shadow-2xl rounded-3xl p-8 space-y-4 border border-base-300/50 max-w-md mx-auto">
      <h2 className="text-xl font-bold text-center">Admin sign-in</h2>
      <p className="text-xs opacity-60 text-center">
        Enter the election dashboard password. Admin requests are RSA-signed server-side — the key never reaches the
        browser.
      </p>
      <input
        type="password"
        className="input input-bordered w-full"
        placeholder="Dashboard password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        onKeyDown={e => e.key === "Enter" && submit()}
      />
      <button className="btn btn-primary w-full" disabled={!password || pending} onClick={submit}>
        {pending ? "Checking..." : "Sign in"}
      </button>
    </div>
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
            {`Owner-only controls for the Voting ${isCustomChain ? "chain" : "contract"}`}
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
  onLogout,
}: {
  phaseLabel: string;
  phase: number;
  registrationEnd: number;
  votingEnd: number;
  now: number;
  onLogout?: () => void;
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
      <div className="flex items-center gap-3">
        {remaining && <span className="text-xs font-mono opacity-80">{remaining}</span>}
        {onLogout && (
          <button className="btn btn-ghost btn-xs" onClick={onLogout}>
            Sign out
          </button>
        )}
      </div>
    </div>
  );
};
