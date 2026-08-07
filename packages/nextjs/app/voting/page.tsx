"use client";

import { NextPage } from "next";

/**
 * /voting — the voter-channel reference page.
 *
 * Voting itself migrated to the mobile app, so this exists to tell an official
 * what the voter's route actually is. The promotional framing (gradient hero,
 * store badges as a call to action, duplicate portal links already in the
 * sidebar) was removed; what remains is the procedure.
 */

const STEPS = [
  { step: "1", title: "Setup", detail: "Voter creates an identity in the app, keyed to the phone's secure element." },
  {
    step: "2",
    title: "Register",
    detail: "Voter presents their address QR at the GN office; the officer enrols them.",
  },
  {
    step: "3",
    title: "Vote",
    detail: "Ballot is cast anonymously, accompanied by a zero-knowledge eligibility proof.",
  },
  { step: "4", title: "Verify", detail: "Voter confirms their ballot was included in the on-chain tally." },
];

const VotingPage: NextPage = () => {
  return (
    <div className="grow w-full p-6 lg:p-8">
      <div className="w-full max-w-3xl mx-auto space-y-5">
        <div className="dash-card p-6 lg:p-8">
          <h1 className="text-lg font-bold">SL Vote mobile app</h1>
          <p className="text-sm opacity-70 mt-2">
            Ballots are cast exclusively from the SL Vote app. The voter&apos;s signing key never leaves their
            phone&apos;s hardware security module, which is why this portal offers no web voting form.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <span className="btn btn-neutral btn-sm pointer-events-none opacity-90">Google Play</span>
            <span className="btn btn-neutral btn-sm pointer-events-none opacity-90">App Store</span>
            <span className="badge badge-warning badge-sm">Not yet published</span>
          </div>
        </div>

        <div className="dash-card p-6 lg:p-8">
          <h2 className="text-sm font-bold">Voter procedure</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {STEPS.map(({ step, title, detail }) => (
              <div key={step} className="flex items-start gap-3 rounded-xl border border-base-300/60 p-4">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xs font-bold text-primary">
                  {step}
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{title}</div>
                  <p className="text-xs opacity-60 mt-0.5">{detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default VotingPage;
