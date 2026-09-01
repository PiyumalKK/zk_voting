"use client";

import Link from "next/link";
import { AddressInput } from "@scaffold-ui/components";
import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useAdminElection } from "~~/app/voting/admin/_components/AdminElectionProvider";
import { BulkVoterRollSection } from "~~/app/voting/admin/_components/BulkVoterRollSection";
import { DivisionPicker, PhaseBadge } from "~~/app/voting/admin/_components/DivisionStatusPanel";
import { GroupHeading, Section } from "~~/app/voting/admin/_components/Section";

/**
 * Admin › Ballot.
 *
 * What goes on the ballot paper, and who may receive one. All three panels are
 * Setup-phase work (the roll stays open through Registration), which is why
 * they are one screen away from the election-day controls rather than mixed
 * into them.
 */
const AdminBallotPage = () => {
  const {
    isCustom,
    busy,
    inSetup,
    inRegistration,
    divisions,
    divisionsLoading,
    selectedIdx,
    setSelectedIdx,
    selectedDiv,
    phase,
    phaseLabel,
    candList,
    questionDraft,
    setQuestionDraft,
    candidateDrafts,
    setCandidateDrafts,
    voterDrafts,
    setVoterDrafts,
    handleSetQuestion,
    handleSetQuestionAll,
    handleSetCandidates,
    handleSetCandidatesAll,
    handleAddVoters,
  } = useAdminElection();

  // `setCandidates` is Setup-only, so this is what a broadcast will actually
  // land on — worth saying out loud before the operator clicks it.
  const divisionsInSetup = divisions.filter(division => division.phase === 0).length;

  return (
    <>
      {/* The selection lives in the provider, so changing it here also changes
          what the Operations tab is pointed at — one division at a time, across
          the whole admin area. */}
      <div className="dash-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-[16rem] flex-1">
            <div className="text-sm font-semibold mb-2">Configuring division</div>
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
                  <>
                    The question, candidates and roll below belong to <strong>{selectedDiv?.name}</strong>. Each
                    division holds its own — use the <em>Apply to all</em> buttons to share one across every division.
                  </>
                }
              />
            )}
          </div>
          <PhaseBadge phase={phase} phaseLabel={phaseLabel} />
        </div>
      </div>

      <GroupHeading
        title="Ballot configuration"
        subtitle={
          selectedDiv
            ? `Question, candidates and voter roll for ${selectedDiv.name}.`
            : "Select a division above to configure its ballot."
        }
      />

      <Section title="Ballot question" disabled={!inSetup} hint="Editable only during Setup phase.">
        <textarea
          className="textarea textarea-bordered w-full"
          rows={2}
          value={questionDraft}
          onChange={e => setQuestionDraft(e.target.value)}
          disabled={!inSetup}
        />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-base-300/60 pt-4">
          <p className="text-xs opacity-50 max-w-sm">
            A national contest asks one question everywhere — use <em>Apply to all</em> rather than repeating it per
            division.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-outline btn-sm"
              disabled={!inSetup || !!busy || !questionDraft.trim() || divisions.length === 0}
              onClick={handleSetQuestionAll}
              title={
                divisionsInSetup < divisions.length
                  ? `${divisions.length - divisionsInSetup} division(s) are past Setup and will be skipped`
                  : undefined
              }
            >
              {busy === "all-question"
                ? "Applying…"
                : `Apply question to all ${divisions.length} division${divisions.length === 1 ? "" : "s"}`}
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={!inSetup || busy === "question" || !questionDraft.trim()}
              onClick={handleSetQuestion}
            >
              {busy === "question"
                ? "Saving..."
                : selectedDiv
                  ? `Save question for ${selectedDiv.name}`
                  : "Save question"}
            </button>
          </div>
        </div>
      </Section>

      <Section
        title="Candidates"
        disabled={!inSetup}
        hint={`Editable only during Setup. Max 100 entries. ${
          selectedDiv?.name ?? "This division"
        } currently has ${candList.length}. Each division holds its own slate.`}
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
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-base-300/60 pt-4">
          <p className="text-xs opacity-50 max-w-sm">
            Use <em>Apply to all</em> for a national contest where every division runs the same slate.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-outline btn-sm"
              disabled={!inSetup || !!busy || divisions.length === 0}
              onClick={handleSetCandidatesAll}
              title={
                divisionsInSetup < divisions.length
                  ? `${divisions.length - divisionsInSetup} division(s) are past Setup and will be skipped`
                  : undefined
              }
            >
              {busy === "all-candidates"
                ? "Applying…"
                : `Apply candidates to all ${divisions.length} division${divisions.length === 1 ? "" : "s"}`}
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={!inSetup || busy === "candidates"}
              onClick={handleSetCandidates}
            >
              {busy === "candidates"
                ? "Saving..."
                : selectedDiv
                  ? `Save candidates for ${selectedDiv.name}`
                  : "Save candidates"}
            </button>
          </div>
        </div>

        {divisions.length > 1 && divisionsInSetup < divisions.length && (
          <p className="text-xs text-warning">
            Only {divisionsInSetup} of {divisions.length} divisions are still in Setup. A broadcast skips the rest —
            their candidate lists are frozen until they are reset.
          </p>
        )}
      </Section>

      {isCustom ? (
        /*
         * `addVoters` is a GN-only function in the relay whitelist
         * (`01-AUTH-DESIGN.md` §4). The contract would accept it from the owner —
         * `onlyOwnerOrGN` — but the relay deliberately will not sign it, because
         * enrolling a voter without the matching `reserveNicHash` call would
         * bypass the duplicate-NIC check.
         *
         * So on the custom chain there is no allowlist form to show. This used
         * to be a full-height card containing nothing but this explanation; a
         * note costs the operator one line instead of a screen.
         */
        <div className="dash-card p-5 text-sm">
          <p className="opacity-70">
            <strong>Voter roll:</strong> on the custom chain, voters are enrolled by their Grama Niladhari officer in
            the{" "}
            <Link href="/gn" className="link link-primary">
              GN portal
            </Link>
            , where the NIC is reserved and the address allowlisted in one step.
          </p>
          <p className="text-xs opacity-50 mt-2">
            Officer accounts and division assignments live on the <strong>Divisions</strong> tab.
          </p>
        </div>
      ) : (
        <Section
          title="Allowlist voters"
          disabled={!inSetup && !inRegistration}
          hint="Editable during Setup and Registration phases. Puts an address on the roll — it does not enrol a voter."
        >
          {/*
            Said plainly, because the button below reports success either way.
            `Voting.register()` calls `NicRegistry.commitDevice`, which refuses
            any device no GN officer ever bound to a NIC, so an address added
            here and nowhere else is on the roll and still cannot register. That
            is deliberate — it is what stops one citizen obtaining two
            registrations — but without saying so, this panel looks like a
            complete enrolment and fails much later, on the voter's phone.
          */}
          <div className="alert alert-warning text-xs items-start">
            <div>
              <p className="font-semibold">Allowlisting alone does not let anyone register.</p>
              <p className="opacity-80 mt-1">
                Every voter must also be enrolled against their NIC by a Grama Niladhari officer in the{" "}
                <Link href="/gn" className="link">
                  GN portal
                </Link>
                , which reserves the NIC and binds the phone. Addresses added here without that step are on the roll but
                will be refused when they try to register.
              </p>
              <p className="opacity-60 mt-1">
                Use this to <strong>revoke</strong> an address, or for local testing where the GN portal has already
                enrolled the device.
              </p>
            </div>
          </div>

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
      )}

      {/* Custom chain only: bulk-loads eligibility for the voter roll above,
          via an SMS claim link instead of a GN visit. Placed last — it acts
          on whichever division each CSV row names, not the one selected up
          top. */}
      {isCustom && <BulkVoterRollSection />}
    </>
  );
};

export default AdminBallotPage;
