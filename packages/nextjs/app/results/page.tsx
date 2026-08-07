"use client";

import { useEffect, useMemo, useState } from "react";
import { NextPage } from "next";
import { usePublicClient } from "wagmi";
import { PHASE_LABELS, useDivisions } from "~~/hooks/useDivisions";

const PALETTES = [
  { bar: "bg-success", text: "text-success" },
  { bar: "bg-error", text: "text-error" },
  { bar: "bg-primary", text: "text-primary" },
  { bar: "bg-secondary", text: "text-secondary" },
  { bar: "bg-accent", text: "text-accent" },
  { bar: "bg-warning", text: "text-warning" },
];

const VOTING_RESULT_ABI = [
  { name: "getCandidates", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string[]" }] },
  { name: "getVoteCounts", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] },
] as const;

interface DivisionResult {
  id: number;
  name: string;
  votingContract: `0x${string}`;
  phase: number;
  treeSize: number;
  candidates: string[];
  counts: number[];
  totalVotes: number;
}

const ResultsDashboard: NextPage = () => {
  const publicClient = usePublicClient();
  const { divisions, isLoading: divisionsLoading, error: divisionsError } = useDivisions();

  const [results, setResults] = useState<DivisionResult[]>([]);
  const [loadingResults, setLoadingResults] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);

  const divisionsKey = useMemo(() => divisions.map(d => d.votingContract).join(","), [divisions]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!publicClient || divisions.length === 0) {
        if (!divisionsLoading) setLoadingResults(false);
        return;
      }
      setLoadingResults(true);

      const enriched = await Promise.all(
        divisions.map(async (div): Promise<DivisionResult> => {
          try {
            const [candidates, counts] = await Promise.all([
              publicClient.readContract({
                address: div.votingContract,
                abi: VOTING_RESULT_ABI,
                functionName: "getCandidates",
              }),
              publicClient.readContract({
                address: div.votingContract,
                abi: VOTING_RESULT_ABI,
                functionName: "getVoteCounts",
              }),
            ]);
            const countsNum = (counts as bigint[]).map(Number);
            return {
              id: div.id,
              name: div.name,
              votingContract: div.votingContract,
              phase: div.phase,
              treeSize: div.treeSize,
              candidates: candidates as string[],
              counts: countsNum,
              totalVotes: countsNum.reduce((s, c) => s + c, 0),
            };
          } catch {
            return {
              id: div.id,
              name: div.name,
              votingContract: div.votingContract,
              phase: div.phase,
              treeSize: div.treeSize,
              candidates: [],
              counts: [],
              totalVotes: 0,
            };
          }
        }),
      );

      if (!cancelled) {
        setResults(enriched);
        setLoadingResults(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [divisionsKey, publicClient, divisionsLoading]);

  // Build national aggregation across all divisions (candidates assumed aligned by index).
  const national = useMemo(() => {
    const nameSet: string[] = [];
    const totals: number[] = [];
    let totalVotes = 0;
    let totalRegistered = 0;

    for (const r of results) {
      totalVotes += r.totalVotes;
      totalRegistered += r.treeSize;
      r.candidates.forEach((name, idx) => {
        if (!nameSet[idx]) nameSet[idx] = name;
        totals[idx] = (totals[idx] ?? 0) + (r.counts[idx] ?? 0);
      });
    }

    return { candidates: nameSet, totals, totalVotes, totalRegistered };
  }, [results]);

  const nationalTurnout =
    national.totalRegistered > 0 ? ((national.totalVotes / national.totalRegistered) * 100).toFixed(1) : "0";
  const maxNational = Math.max(0, ...national.totals);

  const isLoading = divisionsLoading || loadingResults;

  const renderBody = () => {
    if (isLoading && results.length === 0) {
      return (
        <div className="flex flex-col items-center py-16 gap-3 opacity-60">
          <span className="loading loading-spinner loading-lg"></span>
          <span>Aggregating results from all divisions…</span>
        </div>
      );
    }
    if (results.length === 0) {
      return (
        <div className="text-center py-16 opacity-50">
          <div className="text-3xl mb-2">🗳️</div>
          <p>No divisions registered yet.</p>
        </div>
      );
    }
    return (
      <>
        {/* National Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          <div className="bg-base-100 rounded-xl p-4 shadow-sm border border-base-300/50 text-center">
            <div className="text-2xl font-bold text-primary">{national.totalVotes.toLocaleString()}</div>
            <div className="text-xs opacity-50">Total Votes</div>
          </div>
          <div className="bg-base-100 rounded-xl p-4 shadow-sm border border-base-300/50 text-center">
            <div className="text-2xl font-bold text-secondary">{national.totalRegistered.toLocaleString()}</div>
            <div className="text-xs opacity-50">Registered Voters</div>
          </div>
          <div className="bg-base-100 rounded-xl p-4 shadow-sm border border-base-300/50 text-center">
            <div className="text-2xl font-bold text-accent">{nationalTurnout}%</div>
            <div className="text-xs opacity-50">National Turnout</div>
          </div>
          <div className="bg-base-100 rounded-xl p-4 shadow-sm border border-base-300/50 text-center">
            <div className="text-2xl font-bold">{results.length}</div>
            <div className="text-xs opacity-50">Divisions</div>
          </div>
        </div>

        {/* National Results Cards */}
        <div className="bg-base-100 rounded-2xl p-6 shadow-md border border-base-300/50 mb-8">
          <h2 className="font-bold text-lg mb-4">National Candidate Totals</h2>
          {national.candidates.length > 0 ? (
            <div className="space-y-4">
              {national.candidates.map((candidate, idx) => {
                const count = national.totals[idx] ?? 0;
                const pct = national.totalVotes > 0 ? (count / national.totalVotes) * 100 : 0;
                const palette = PALETTES[idx % PALETTES.length];
                const isLeading = count === maxNational && count > 0;

                return (
                  <div
                    key={candidate}
                    className={`p-4 rounded-xl border ${isLeading ? "border-success/50 bg-success/5" : "border-base-300/50"}`}
                  >
                    <div className="flex justify-between items-center mb-2">
                      <div className="flex items-center gap-2">
                        {isLeading && <span className="text-xs badge badge-success badge-sm">Leading</span>}
                        <span className="font-bold">{candidate}</span>
                      </div>
                      <div className="text-right">
                        <span className={`font-bold text-lg ${palette.text}`}>{count.toLocaleString()}</span>
                        <span className="text-xs opacity-50 ml-2">({pct.toFixed(1)}%)</span>
                      </div>
                    </div>
                    <div className="w-full bg-base-300/30 rounded-full h-3 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${palette.bar} transition-all duration-1000`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 opacity-50">
              <p>No candidates configured yet.</p>
            </div>
          )}
        </div>

        {/* Per-division breakdown */}
        <div className="bg-base-100 rounded-2xl p-6 shadow-md border border-base-300/50">
          <h2 className="font-bold text-lg mb-4">Division Breakdown</h2>
          <div className="space-y-3">
            {results.map(div => {
              const leadIdx = div.counts.reduce((best, c, i, arr) => (c > arr[best] ? i : best), 0);
              const open = expanded === div.id;
              const divTurnout = div.treeSize > 0 ? ((div.totalVotes / div.treeSize) * 100).toFixed(1) : "0";
              return (
                <div key={div.votingContract} className="border border-base-300/50 rounded-xl overflow-hidden">
                  <button
                    className="w-full flex flex-wrap justify-between items-center gap-2 p-4 hover:bg-base-200/50 transition-colors text-left"
                    onClick={() => setExpanded(open ? null : div.id)}
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-bold">{div.name}</span>
                      <span className="badge badge-ghost badge-sm">{PHASE_LABELS[div.phase]}</span>
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                      <span className="opacity-60">{div.totalVotes.toLocaleString()} votes</span>
                      <span className="opacity-40">{divTurnout}% turnout</span>
                      <span className="opacity-40">{open ? "▲" : "▼"}</span>
                    </div>
                  </button>
                  {open && (
                    <div className="p-4 pt-0 space-y-2">
                      {div.candidates.length > 0 ? (
                        div.candidates.map((candidate, idx) => {
                          const count = div.counts[idx] ?? 0;
                          const pct = div.totalVotes > 0 ? (count / div.totalVotes) * 100 : 0;
                          const palette = PALETTES[idx % PALETTES.length];
                          const isLeading = idx === leadIdx && count > 0;
                          return (
                            <div key={candidate}>
                              <div className="flex justify-between text-sm mb-1">
                                <span className={isLeading ? "font-semibold" : ""}>{candidate}</span>
                                <span className="opacity-60">
                                  {count.toLocaleString()} ({pct.toFixed(1)}%)
                                </span>
                              </div>
                              <div className="w-full bg-base-300/30 rounded-full h-2 overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${palette.bar} transition-all duration-700`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </div>
                          );
                        })
                      ) : (
                        <p className="text-xs opacity-40 py-2">No candidates configured for this division.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </>
    );
  };

  return (
    <div className="flex flex-col items-center grow p-6 lg:p-8">
      <div className="w-full max-w-4xl">
        {/* Header */}
        <div className="dash-card p-6 mb-6">
          <h1 className="text-lg font-bold">National Election Results</h1>
          <p className="text-sm opacity-60 mt-1">
            Real-time on-chain tally aggregated across all divisions · Publicly verifiable
          </p>
        </div>

        {divisionsError && (
          <div className="alert alert-error mb-6 text-sm">
            <span>⚠️ {divisionsError}</span>
          </div>
        )}

        {renderBody()}

        {/* Verification link */}
        <div className="mt-6 text-center">
          <a href="/audit" className="text-sm text-primary hover:underline">
            🔍 Verify these results independently →
          </a>
        </div>
      </div>
    </div>
  );
};

export default ResultsDashboard;
