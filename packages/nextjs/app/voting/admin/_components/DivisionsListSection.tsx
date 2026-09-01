"use client";

import { Section } from "~~/app/voting/admin/_components/Section";
import { useDivisions } from "~~/hooks/useDivisions";
import { PHASE_LABELS } from "~~/utils/electionPhase";

/**
 * A read-only overview of every division on the registry.
 *
 * There is deliberately no delete button here: `ElectionRegistry.sol` has no
 * function that removes or deactivates a single division — the `active` flag
 * on the `Division` struct is set `true` at creation and nothing ever clears
 * it for one division. The only whole-registry action is `clearDivisions()`
 * ("Start a new election" on the Operations tab), which wipes every division
 * at once. Adding real per-division deletion means a new contract function, a
 * recompile and a redeploy — a deliberate, separate decision, not something
 * to fold in here.
 *
 * "Hide" is the honest stand-in: purely a per-browser (localStorage) view
 * filter via `useDivisions`' `toggleHidden`, already used the same way by
 * `GNManagementSection` in hardhat mode. It declutters an operator's own view
 * of old test divisions without touching the chain.
 */

export const DivisionsListSection = () => {
  const { divisions, isLoading, error, toggleHidden } = useDivisions();

  return (
    <Section
      title="All Divisions"
      hint="Every division on the registry. There is no on-chain way to delete one individually — Hide only affects your own view. Use 'Start a new election' on the Operations tab to wipe every division at once."
    >
      {error && (
        <div className="alert alert-error text-sm" role="alert">
          <span>{error}</span>
        </div>
      )}

      {isLoading && divisions.length === 0 ? (
        <div className="flex items-center gap-2 opacity-60 text-sm">
          <span className="loading loading-spinner loading-sm" />
          Loading divisions…
        </div>
      ) : divisions.length === 0 ? (
        <p className="text-sm opacity-60">No divisions yet — deploy one above.</p>
      ) : (
        <div className={`overflow-x-auto ${divisions.length > 15 ? "max-h-[32rem] overflow-y-auto" : ""}`}>
          <table className="table table-sm">
            <thead className="sticky top-0 z-10 bg-base-100">
              <tr>
                <th>Name</th>
                <th>Address</th>
                <th>GN Officer</th>
                <th>Phase</th>
                <th>Registered</th>
                <th>Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {divisions.map(division => (
                <tr key={division.votingContract} className={division.hidden ? "opacity-40 grayscale" : ""}>
                  <td className="font-bold">
                    {division.name}
                    {division.hidden && <span className="text-xs font-normal opacity-60 ml-1">(Hidden)</span>}
                  </td>
                  <td className="font-mono text-xs">
                    {division.votingContract.slice(0, 10)}…{division.votingContract.slice(-4)}
                  </td>
                  <td className="font-mono text-xs">
                    {division.gnOfficers.length === 0 ? (
                      "—"
                    ) : division.gnOfficers.length === 1 ? (
                      `${division.gnOfficers[0].slice(0, 10)}…${division.gnOfficers[0].slice(-4)}`
                    ) : (
                      <span title={division.gnOfficers.join("\n")}>{division.gnOfficers.length} officers</span>
                    )}
                  </td>
                  <td>{PHASE_LABELS[division.phase] ?? division.phase}</td>
                  <td>{division.treeSize}</td>
                  <td>
                    {division.active ? (
                      <span className="badge badge-success badge-xs">Yes</span>
                    ) : (
                      <span className="badge badge-ghost badge-xs">No</span>
                    )}
                  </td>
                  <td>
                    <button
                      className={`btn btn-xs ${division.hidden ? "btn-outline" : "btn-ghost"}`}
                      onClick={() => toggleHidden?.(division.id)}
                    >
                      {division.hidden ? "Show" : "Hide"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
};
