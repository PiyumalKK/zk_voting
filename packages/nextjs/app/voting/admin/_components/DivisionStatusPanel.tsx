"use client";

import React from "react";
import { useAdminElection } from "~~/app/voting/admin/_components/AdminElectionProvider";
import { LiveDivision } from "~~/hooks/useDivisions";
import { PHASE_LABELS } from "~~/utils/electionPhase";

/** Raw seconds are unreadable at a glance once a phase runs for an hour. */
const formatCountdown = (totalSeconds: number): string => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

const PHASE_BADGE: Record<number, string> = {
  0: "badge-ghost",
  1: "badge-info",
  2: "badge-success",
  3: "badge-neutral",
};

/** Shared so the Ballot tab's selector reads the phase the same way Operations does. */
export const PhaseBadge = ({ phase, phaseLabel }: { phase: number; phaseLabel: string }) => (
  <span className={`badge badge-lg ${PHASE_BADGE[phase] ?? "badge-ghost"}`}>Phase: {phaseLabel}</span>
);

/**
 * How the divisions are spread across the phases.
 *
 * The master controls send to every division and let each contract reject the
 * ones in the wrong phase, so a run reports "3 skipped" only once it is over.
 * This says the same thing before the click, which is when it can still change
 * what the operator does.
 */
export const PhaseSpread = ({ divisions }: { divisions: LiveDivision[] }) => {
  if (divisions.length === 0) return null;

  const counts = new Map<number, number>();
  for (const division of divisions) {
    counts.set(division.phase, (counts.get(division.phase) ?? 0) + 1);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[10px] uppercase tracking-wider opacity-50">Divisions by phase</span>
      {[...counts.keys()]
        .sort((a, b) => a - b)
        .map(phase => (
          <span key={phase} className={`badge badge-sm ${PHASE_BADGE[phase] ?? "badge-ghost"}`}>
            {counts.get(phase)} {PHASE_LABELS[phase] ?? "Unknown"}
          </span>
        ))}
    </div>
  );
};

const StatTile = ({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) => (
  <div className="rounded-xl border border-base-300/60 bg-base-200/40 px-4 py-3">
    <div className="text-[10px] uppercase tracking-wider opacity-50">{label}</div>
    <div className={`mt-1 text-lg font-bold leading-tight truncate ${tone ?? ""}`}>{value}</div>
  </div>
);

export const DivisionPicker = ({
  divisions,
  selectedIdx,
  setSelectedIdx,
  selectedName,
  hint,
}: {
  divisions: LiveDivision[];
  selectedIdx: number;
  setSelectedIdx: (i: number) => void;
  selectedName?: string;
  /** Overrides the default note, so each tab can say what the selection governs there. */
  hint?: React.ReactNode;
}) => {
  if (divisions.length === 0) {
    return <p className="text-sm opacity-60">No divisions registered. Deploy divisions first.</p>;
  }
  return (
    <>
      <select
        aria-label="Active division"
        className="select select-bordered w-full"
        value={selectedIdx}
        onChange={e => setSelectedIdx(Number(e.target.value))}
      >
        {divisions.map((d, i) => (
          <option key={d.votingContract} value={i}>
            {d.name} — {PHASE_LABELS[d.phase]}
          </option>
        ))}
      </select>
      <p className="text-xs opacity-50 mt-2">
        {hint ?? (
          <>
            Ballot and phase actions across all three admin sections apply to <strong>{selectedName}</strong>.
          </>
        )}
      </p>
    </>
  );
};

/**
 * Which division is being configured, and what state it is in.
 *
 * Merges what used to be two stacked cards — a bare dropdown and a phase strip —
 * because an operator reads them as one question: "what am I about to change,
 * and can I change it right now?"
 */
export const DivisionStatusPanel = () => {
  const {
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
  } = useAdminElection();

  const remaining =
    phase === 1 && registrationEnd > now
      ? registrationEnd - now
      : phase === 2 && votingEnd > now
        ? votingEnd - now
        : null;

  const closingLabel = phase === 1 ? "Registration closes in" : phase === 2 ? "Voting closes in" : "Time remaining";

  return (
    <div className="dash-card p-6 lg:p-8 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-base-300/60 pb-4">
        <div>
          <h2 className="text-lg font-bold">Division &amp; phase status</h2>
          <p className="text-xs opacity-60 mt-1">Live state of the division this area is configuring.</p>
        </div>
        <PhaseBadge phase={phase} phaseLabel={phaseLabel} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <div className="text-sm font-semibold mb-2">Active division</div>
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
              hint={
                // The default hint claims every action on the page follows this
                // selection. On Operations that is only half true — the master
                // controls deliberately ignore it — and this is the one screen
                // where believing it costs you a national phase change.
                <>
                  <strong>Phase controls</strong> below act on <strong>{selectedDiv?.name}</strong> alone. The{" "}
                  <strong>master controls</strong> ignore this selection and act on every division.
                </>
              }
            />
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <StatTile label="Registered voters" value={selectedDiv ? selectedDiv.treeSize : "—"} />
          <StatTile label="Candidates" value={candList.length} />
          <StatTile label="Divisions on chain" value={divisions.length} />
          <StatTile
            label={closingLabel}
            value={remaining !== null ? formatCountdown(remaining) : "—"}
            tone={remaining !== null ? "font-mono text-primary" : "opacity-40"}
          />
        </div>
      </div>
    </div>
  );
};
