"use client";

import { useEffect, useState } from "react";
import { NextPage } from "next";

/**
 * Past election results, read from the on-chain archives via
 * `/api/election/history`.
 *
 * Public, and deliberately so. The archive lives in `ElectionRegistry` and each
 * division's `Voting` contract, which anyone with the RPC URL can already read;
 * gating this page would hide it from citizens without hiding the data from
 * anybody. Publishing it is the same argument `/audit` already makes — which is
 * why every row carries its `votingContract`, so a reader can check the number
 * against the chain rather than take this page's word for it.
 *
 * Sibling of `/results`: that page is the live tally, this one is every tally
 * that came before it.
 */

interface ArchivedElection {
  electionId: number;
  question: string;
  candidates: string[];
  voteCounts: number[];
  totalVotes: number;
  registeredVoters: number;
  archivedAt: number;
}

interface ArchivedDivision {
  name: string;
  votingContract: string;
  gnOfficer: string;
  elections: ArchivedElection[];
  unreachable?: boolean;
}

interface Cycle {
  cycleIndex: number;
  question: string;
  archivedAt: number;
  results: { candidate: string; votes: number }[];
  totalVotes: number;
  registeredVoters: number;
  turnout: number;
  divisions: ArchivedDivision[];
}

interface HistoryPayload {
  cycleCount: number;
  cycles: Cycle[];
}

const PALETTES = ["bg-success", "bg-error", "bg-primary", "bg-secondary", "bg-accent", "bg-warning"];

const formatDate = (unixSeconds: number) =>
  unixSeconds > 0
    ? new Date(unixSeconds * 1000).toLocaleDateString(undefined, { dateStyle: "medium" })
    : "unknown date";

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

const ElectionHistory: NextPage = () => {
  const [data, setData] = useState<HistoryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/election/history")
      .then(async res => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Failed to load election history");
        return body as HistoryPayload;
      })
      .then(body => {
        if (!cancelled) setData(body);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const renderBody = () => {
    if (error) {
      return (
        <div className="alert alert-error text-sm">
          <span>⚠️ {error}</span>
        </div>
      );
    }

    if (!data) {
      return (
        <div className="dash-card p-6 text-center">
          <span className="loading loading-spinner loading-md" />
          <p className="text-sm opacity-60 mt-2">Reading archives from the chain…</p>
        </div>
      );
    }

    if (data.cycles.length === 0) {
      return (
        <div className="dash-card p-6">
          <h2 className="font-bold text-lg mb-2">No past elections yet</h2>
          <p className="text-sm opacity-70">
            The current election is still live — see{" "}
            <a href="/results" className="text-primary hover:underline">
              Results
            </a>
            . It is archived here once the next election begins.
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        {data.cycles.map(cycle => {
          const isOpen = expanded === cycle.cycleIndex;
          const winner = cycle.results[0];

          return (
            <div key={cycle.cycleIndex} className="bg-base-100 rounded-2xl p-6 shadow-md border border-base-300/50">
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
                <h2 className="font-bold text-lg">{cycle.question || `Election #${cycle.cycleIndex + 1}`}</h2>
                <span className="text-xs opacity-50">Concluded {formatDate(cycle.archivedAt)}</span>
              </div>
              <p className="text-sm opacity-60 mb-5">
                {cycle.divisions.length} division{cycle.divisions.length === 1 ? "" : "s"} ·{" "}
                {cycle.totalVotes.toLocaleString()} votes cast · {percent(cycle.turnout)} turnout
                {winner && ` · won by ${winner.candidate}`}
              </p>

              <div className="space-y-4">
                {cycle.results.map(({ candidate, votes }, index) => {
                  const share = cycle.totalVotes > 0 ? votes / cycle.totalVotes : 0;
                  return (
                    <div key={candidate}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="font-medium">{candidate}</span>
                        <span className="opacity-70 tabular-nums">
                          {votes.toLocaleString()} ({percent(share)})
                        </span>
                      </div>
                      <div className="h-2.5 rounded-full bg-base-300 overflow-hidden">
                        <div
                          className={`h-full ${PALETTES[index % PALETTES.length]}`}
                          style={{ width: `${share * 100}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              <button
                type="button"
                className="btn btn-sm btn-ghost mt-5"
                onClick={() => setExpanded(isOpen ? null : cycle.cycleIndex)}
                aria-expanded={isOpen}
              >
                {isOpen ? "Hide" : "Show"} division breakdown
              </button>

              {isOpen && (
                <div className="overflow-x-auto mt-3">
                  <table className="table table-sm">
                    <thead>
                      <tr>
                        <th>Division</th>
                        <th className="text-right">Votes</th>
                        <th className="text-right">Registered</th>
                        <th>Contract</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cycle.divisions.map(division => {
                        const votes = division.elections.reduce((sum, e) => sum + e.totalVotes, 0);
                        const registered = division.elections.reduce((sum, e) => sum + e.registeredVoters, 0);
                        return (
                          <tr key={division.votingContract}>
                            <td>
                              {division.name}
                              {division.unreachable && (
                                <span className="ml-2 badge badge-warning badge-sm">unreadable</span>
                              )}
                            </td>
                            <td className="text-right tabular-nums">{votes.toLocaleString()}</td>
                            <td className="text-right tabular-nums">{registered.toLocaleString()}</td>
                            <td>
                              <a
                                href={`/blockexplorer/address/${division.votingContract}`}
                                className="text-[10px] opacity-60 hover:opacity-100 hover:text-primary font-mono"
                              >
                                {division.votingContract}
                              </a>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="flex flex-col items-center grow p-6 lg:p-8">
      <div className="w-full max-w-4xl">
        {/* Header */}
        <div className="dash-card p-6 mb-6">
          <h1 className="text-lg font-bold">Past Election Results</h1>
          <p className="text-sm opacity-60 mt-1">
            Archived on-chain when each election concluded · Publicly verifiable
          </p>
        </div>

        {renderBody()}
      </div>
    </div>
  );
};

export default ElectionHistory;
