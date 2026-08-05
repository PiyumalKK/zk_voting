"use client";

import { useAdminElection } from "~~/app/voting/admin/_components/AdminElectionProvider";
import { DivisionStatusPanel } from "~~/app/voting/admin/_components/DivisionStatusPanel";
import { GroupHeading, Section } from "~~/app/voting/admin/_components/Section";

/**
 * Admin › Operations.
 *
 * What an operator touches on election day: where every division stands, the
 * national phase controls, the per-division phase controls, and — kept visibly
 * apart — the reset.
 *
 * All state and handlers come from `AdminElectionProvider`, which is where the
 * old single-page component's body now lives.
 */
const AdminOperationsPage = () => {
  const {
    divisions,
    busy,
    inSetup,
    inRegistration,
    inVoting,
    ended,
    phaseLabel,
    selectedDiv,
    registrationDuration,
    setRegistrationDuration,
    votingDuration,
    setVotingDuration,
    handleStartRegistration,
    handleStartVoting,
    handleEndElection,
    handleStartRegistrationAll,
    handleStartVotingAll,
    handleEndAll,
    handleResetElection,
  } = useAdminElection();

  return (
    <>
      <DivisionStatusPanel />

      <GroupHeading
        title="Master election controls"
        subtitle="National-scale actions. These ignore the division selection above and apply to every registered division."
      />

      <Section
        title="Run election on all divisions"
        hint="One click advances the phase on every division. Divisions in the wrong phase are skipped automatically."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <button className="btn btn-info btn-sm" disabled={!!busy} onClick={handleStartRegistrationAll}>
            {busy === "all-registration" ? "Starting…" : "Start Registration — ALL"}
          </button>
          <button className="btn btn-success btn-sm" disabled={!!busy} onClick={handleStartVotingAll}>
            {busy === "all-voting" ? "Starting…" : "Start Voting — ALL"}
          </button>
          <button className="btn btn-error btn-outline btn-sm" disabled={!!busy} onClick={handleEndAll}>
            {busy === "all-end" ? "Ending…" : "End — ALL"}
          </button>
        </div>
        <p className="text-xs opacity-50">
          Uses the durations set in <strong>Phase controls</strong> below. Applies to all {divisions.length}{" "}
          division(s).
        </p>
      </Section>

      <GroupHeading
        title="Phase operations"
        subtitle={
          selectedDiv
            ? `Advance ${selectedDiv.name} on its own. The durations here are also what the master controls send.`
            : "Advance a single division."
        }
      />

      <Section title="Phase controls" hint="Durations accept hh:mm:ss, mm:ss, or raw seconds (e.g. 01:00:00 or 3600).">
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

      <GroupHeading title="Danger zone" subtitle="Destructive and irreversible. Not gated by phase." />

      <Section
        title="Start a new election"
        tone="danger"
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
    </>
  );
};

export default AdminOperationsPage;
