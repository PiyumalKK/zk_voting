"use client";

import { useAdminElection } from "~~/app/voting/admin/_components/AdminElectionProvider";
import { DivisionStatusPanel, PhaseSpread } from "~~/app/voting/admin/_components/DivisionStatusPanel";
import { GroupHeading, Section } from "~~/app/voting/admin/_components/Section";

/**
 * Admin › Operations.
 *
 * What an operator touches on election day, ordered so that each block only
 * consumes what the block above it has already established: the division and
 * its live state, then the per-division phase controls — which is where the two
 * durations are typed — then the master controls that send those same durations
 * to every division, then, kept visibly apart, the reset.
 *
 * The master controls used to sit above the phase controls, which meant they
 * had to point downwards at their own inputs ("uses the durations set below")
 * and that an operator met three national buttons before seeing the field that
 * decides what they send.
 *
 * All state and handlers come from `AdminElectionProvider`, which is where the
 * old single-page component's body now lives.
 */
const AdminOperationsPage = () => {
  const {
    divisions,
    busy,
    progress,
    inSetup,
    inRegistration,
    inVoting,
    ended,
    phaseLabel,
    allDivisionsRegistrationStarted,
    allDivisionsVotingStarted,
    noDivisionAwaitingVoting,
    noDivisionToEnd,
    allDivisionsEnded,
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

  const noDivisions = divisions.length === 0;
  const divisionCount = `${divisions.length} division${divisions.length === 1 ? "" : "s"}`;
  /**
   * The per-division buttons name their target, so that a row of buttons reads
   * the same way whether it acts on one division or on all of them — the two
   * sets sit on the same screen and used to be told apart only by the words
   * "phase" versus "all", which says nothing about what gets written.
   */
  const divisionName = selectedDiv?.name ?? "this division";

  /** Turns "Starting…" into "Starting… 3 / 12" once a fan-out is under way. */
  const fanoutLabel = (label: string) =>
    progress && progress.total > 1 ? `${label} ${progress.done} / ${progress.total}` : label;

  /*
   * Why each master control is unavailable — or `null` while it still has a
   * division to act on.
   *
   * These used to be gated on `busy` alone, so once every division had advanced
   * they stayed clickable and did nothing but burn a confirmation, one relay
   * transaction per division and several minutes before reporting "started on 0
   * division(s) · 12 skipped (wrong phase)". The conditions come from the
   * provider, which derives them from the phases `useDivisions` already polls.
   *
   * Each reason is rendered twice: as the button's `title`, and as visible text
   * below the row. A native tooltip is unreliable on a disabled control — which
   * is precisely the state that needs explaining — so it cannot be the only
   * place the answer exists.
   */
  const registrationBlocked = allDivisionsRegistrationStarted
    ? `Registration has already started on all ${divisionCount}.`
    : null;

  const votingBlocked = !noDivisionAwaitingVoting
    ? null
    : allDivisionsVotingStarted
      ? `Voting has already started on all ${divisionCount}.`
      : "No division is in the Registration phase yet — start registration first.";

  const endBlocked = !noDivisionToEnd
    ? null
    : allDivisionsEnded
      ? `The election has already ended on all ${divisionCount}.`
      : "No division has started registration yet — there is nothing to end.";

  const blockedReasons = [registrationBlocked, votingBlocked, endBlocked].filter(
    (reason): reason is string => reason !== null,
  );

  return (
    <>
      <DivisionStatusPanel />

      <GroupHeading
        title="Phase operations"
        subtitle={
          selectedDiv
            ? `Advance ${selectedDiv.name} on its own. The durations here are also what the master controls below send.`
            : "Advance a single division."
        }
      />

      <Section title="Phase controls" hint="Durations accept hh:mm:ss, mm:ss, or raw seconds (e.g. 01:00:00 or 3600).">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="reg-duration" className="text-sm font-semibold block">
              Registration duration
            </label>
            {/*
             * Not gated on the selected division's phase, unlike the button
             * below it. These two fields also feed the master controls, so
             * disabling them whenever the *selected* division was past Setup
             * left an operator unable to type a registration duration for the
             * other divisions that were still waiting in it — while the
             * "Start registration on all …" button stayed live and sent the
             * stale value anyway. The button's own gate is the honest signal.
             */}
            <input
              id="reg-duration"
              type="text"
              className="input input-bordered w-full"
              value={registrationDuration}
              onChange={e => setRegistrationDuration(e.target.value)}
            />
            <button
              className="btn btn-primary btn-sm w-full"
              disabled={!inSetup || !!busy}
              onClick={handleStartRegistration}
            >
              <span className="truncate">
                {busy === "startRegistration" ? "Starting…" : `Start registration on ${divisionName}`}
              </span>
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
            />
            <button
              className="btn btn-primary btn-sm w-full"
              disabled={!inRegistration || !!busy}
              onClick={handleStartVoting}
            >
              <span className="truncate">
                {busy === "startVoting" ? "Starting…" : `Start voting on ${divisionName}`}
              </span>
            </button>
          </div>
        </div>

        {/* An irreversible action sharing a card with the routine ones gets the
            same divider the Ballot tab's action rows use, rather than 8px of
            padding. */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-base-300/60 pt-4">
          <p className="text-xs opacity-50 max-w-sm">
            {inVoting
              ? "Voting auto-closes at the configured deadline; the button here closes it early."
              : ended
                ? "Election has ended. Results are frozen."
                : "Closes this division early, before its deadline."}
          </p>
          <button className="btn btn-error btn-sm" disabled={ended || inSetup || !!busy} onClick={handleEndElection}>
            {busy === "endElection" ? "Ending…" : `End election on ${divisionName}`}
          </button>
        </div>
      </Section>

      <GroupHeading
        title="Master election controls"
        subtitle="National-scale actions. These ignore the division selection above and apply to every registered division."
      />

      <Section
        title="Run election on all divisions"
        hint="One click advances the phase on every division. Divisions in the wrong phase are skipped automatically."
      >
        {noDivisions ? (
          <p className="text-sm opacity-60">
            No divisions registered yet. Create them on the <strong>Divisions</strong> tab before running an election.
          </p>
        ) : (
          <>
            <PhaseSpread divisions={divisions} />

            <div className="grid gap-3 sm:grid-cols-3">
              <button
                className="btn btn-info btn-sm"
                disabled={!!busy || registrationBlocked !== null}
                title={registrationBlocked ?? undefined}
                onClick={handleStartRegistrationAll}
              >
                {busy === "all-registration" ? fanoutLabel("Starting…") : `Start registration on all ${divisionCount}`}
              </button>
              <button
                className="btn btn-success btn-sm"
                disabled={!!busy || votingBlocked !== null}
                title={votingBlocked ?? undefined}
                onClick={handleStartVotingAll}
              >
                {busy === "all-voting" ? fanoutLabel("Starting…") : `Start voting on all ${divisionCount}`}
              </button>
              <button
                className="btn btn-error btn-outline btn-sm"
                disabled={!!busy || endBlocked !== null}
                title={endBlocked ?? undefined}
                onClick={handleEndAll}
              >
                {busy === "all-end" ? fanoutLabel("Ending…") : `End election on all ${divisionCount}`}
              </button>
            </div>

            {/* The visible half of the explanation. `aria-live` because these
                appear and disappear as the divisions advance, without the
                operator touching anything. */}
            {blockedReasons.length > 0 && (
              <ul className="text-xs opacity-70 list-disc list-inside space-y-1" aria-live="polite">
                {blockedReasons.map(reason => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}

            <p className="text-xs opacity-50">
              Uses the durations typed in <strong>Phase controls</strong> above. One transaction per division, sent in
              turn.
            </p>
          </>
        )}
      </Section>

      <GroupHeading title="Danger zone" subtitle="Destructive and irreversible. Not gated by phase." />

      <Section
        title="Start a new election"
        tone="danger"
        hint="Wipes the whole deployment back to empty: every division, GN officer account and NIC enrolment record, along with all ballots, voters and votes. Use this to run another election without redeploying."
      >
        <ul className="text-xs opacity-70 list-disc list-inside space-y-1">
          <li>All divisions are removed from the registry — you will create them again from scratch.</li>
          <li>All GN officer accounts are deleted, including their sign-in credentials.</li>
          <li>All NIC enrolment records are released, so previous voters can be enrolled again.</li>
        </ul>
        {ended ? (
          <p className="text-xs opacity-70">
            The election has ended. Start a new one to return the whole deployment to a clean, empty state.
          </p>
        ) : (
          <p className="text-xs opacity-70 text-warning">
            Warning: the current election is still {phaseLabel.toLowerCase()}. Resetting now will discard all current
            progress.
          </p>
        )}
        <div className="flex justify-end pt-2">
          {/*
           * `!!busy`, like every other button here — this one alone used to
           * check only its own label, so it stayed clickable throughout a
           * "start voting on all divisions" run and could race it.
           */}
          <button className="btn btn-error btn-sm" disabled={!!busy} onClick={handleResetElection}>
            {busy === "resetElection" ? "Resetting…" : "Start new election"}
          </button>
        </div>
      </Section>
    </>
  );
};

export default AdminOperationsPage;
