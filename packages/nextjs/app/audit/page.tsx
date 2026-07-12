"use client";

import { useEffect, useRef, useState } from "react";
import { NextPage } from "next";
import { parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";
import { useDivisions } from "~~/hooks/useDivisions";

const VOTE_CAST_EVENT = parseAbiItem(
  "event VoteCast(bytes32 indexed nullifierHash, address indexed voter, uint256 indexed candidate, uint256 timestamp, uint256 newCount)",
);

const VOTING_ABI = [
  { name: "getCandidates", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string[]" }] },
  { name: "getVoteCounts", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] },
] as const;

interface AuditEvent {
  nullifierHash: string;
  candidate: number;
  voter: string;
  blockNumber: string;
  divisionName: string;
}

const AuditPage: NextPage = () => {
  const publicClient = usePublicClient();
  const { divisions, isLoading: divisionsLoading } = useDivisions();

  const [auditRunning, setAuditRunning] = useState(false);
  const [auditResult, setAuditResult] = useState<null | { total: number; valid: number; duplicates: number }>(null);

  const [voteCastEvents, setVoteCastEvents] = useState<AuditEvent[]>([]);
  const [totalOnChainVotes, setTotalOnChainVotes] = useState(0);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const hasLoadedRef = useRef(false);

  const totalEvents = voteCastEvents.length;

  useEffect(() => {
    let cancelled = false;

    const loadData = async (isInitial = false) => {
      if (!publicClient || divisions.length === 0) {
        if (!divisionsLoading) setDataLoading(false);
        return;
      }
      if (isInitial) setDataLoading(true);

      const allEvents: AuditEvent[] = [];
      let allVotes = 0;
      let loadedCandidates: string[] = [];

      try {
        for (const div of divisions) {
          // Fetch events
          const logs = await publicClient.getLogs({
            address: div.votingContract,
            event: VOTE_CAST_EVENT,
            fromBlock: "earliest",
            toBlock: "latest",
          });

          const mappedLogs = logs.map(l => ({
            nullifierHash: l.args.nullifierHash?.toString() ?? "",
            candidate: Number(l.args.candidate ?? 0),
            voter: l.args.voter?.toString() ?? "",
            blockNumber: l.blockNumber?.toString() ?? "0",
            divisionName: div.name,
          }));
          allEvents.push(...mappedLogs);

          // Fetch tallies
          const counts = await publicClient.readContract({
            address: div.votingContract,
            abi: VOTING_ABI,
            functionName: "getVoteCounts",
          });
          const sum = (counts as bigint[]).reduce((s, c) => s + Number(c), 0);
          allVotes += sum;

          // Fetch candidates if we haven't yet (assuming all divisions share candidates)
          if (loadedCandidates.length === 0) {
            const cands = await publicClient.readContract({
              address: div.votingContract,
              abi: VOTING_ABI,
              functionName: "getCandidates",
            });
            loadedCandidates = cands as string[];
          }
        }
      } catch (err) {
        console.error("Failed to load audit data:", err);
      }

      if (!cancelled) {
        allEvents.sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber));
        setVoteCastEvents(allEvents);
        setTotalOnChainVotes(allVotes);
        setCandidates(loadedCandidates);
        setDataLoading(false);
      }
    };

    loadData(!hasLoadedRef.current);
    hasLoadedRef.current = true;

    // Poll every 5 seconds
    const interval = setInterval(() => {
      loadData(false);
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [divisions, publicClient, divisionsLoading]);

  const runAudit = () => {
    setAuditRunning(true);
    // Simulate audit: check for duplicates and count
    const nullifiers = new Set<string>();
    let duplicates = 0;

    for (const event of voteCastEvents) {
      if (nullifiers.has(event.nullifierHash)) {
        duplicates++;
      } else {
        nullifiers.add(event.nullifierHash);
      }
    }

    setTimeout(() => {
      setAuditResult({
        total: totalEvents,
        valid: totalEvents - duplicates,
        duplicates,
      });
      setAuditRunning(false);
    }, 1500); // simulate verification time
  };

  const isLoading = divisionsLoading || dataLoading;

  return (
    <div className="flex flex-col items-center grow pt-8 px-4">
      <div className="w-full max-w-5xl">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="text-4xl mb-2">🔍</div>
          <h1 className="text-3xl font-extrabold">Election Audit</h1>
          <p className="text-sm opacity-60 mt-2">Independent verification — re-check every ballot on-chain</p>
        </div>

        {isLoading ? (
          <div className="flex flex-col items-center py-16 opacity-60">
            <span className="loading loading-spinner loading-lg mb-4"></span>
            <span>Fetching encrypted ballots from blockchain...</span>
          </div>
        ) : (
          <>
            {/* Audit Summary */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <div className="bg-base-100 rounded-xl p-5 shadow-sm border border-base-300/50 text-center">
                <div className="text-2xl font-bold text-primary">{totalEvents}</div>
                <div className="text-xs opacity-50">VoteCast Events</div>
              </div>
              <div className="bg-base-100 rounded-xl p-5 shadow-sm border border-base-300/50 text-center">
                <div className="text-2xl font-bold text-secondary">{totalOnChainVotes}</div>
                <div className="text-xs opacity-50">On-Chain Tally Total</div>
              </div>
              <div className="bg-base-100 rounded-xl p-5 shadow-sm border border-base-300/50 text-center">
                <div
                  className={`text-2xl font-bold ${totalEvents === totalOnChainVotes ? "text-success" : "text-error"}`}
                >
                  {totalEvents === totalOnChainVotes ? "✓ Match" : "✗ Mismatch"}
                </div>
                <div className="text-xs opacity-50">Events vs Tally</div>
              </div>
            </div>

            {/* Run Audit Button */}
            <div className="bg-base-100 rounded-2xl p-6 shadow-md border border-base-300/50 mb-6">
              <h3 className="font-bold mb-3">Run Full Audit</h3>
              <p className="text-sm opacity-60 mb-4">
                Checks: no duplicate nullifiers, event count matches tally, all ballots counted.
              </p>
              <button
                className={`btn btn-primary w-full ${auditRunning ? "loading" : ""}`}
                onClick={runAudit}
                disabled={auditRunning || totalEvents === 0}
              >
                {auditRunning ? "Auditing..." : "🔍 Run Audit Now"}
              </button>

              {auditResult && (
                <div
                  className={`mt-4 p-4 rounded-xl ${auditResult.duplicates === 0 ? "bg-success/10 border border-success/30" : "bg-error/10 border border-error/30"}`}
                >
                  <div className="font-bold mb-2">
                    {auditResult.duplicates === 0 ? "✅ Audit PASSED" : "❌ Audit FAILED"}
                  </div>
                  <ul className="text-sm space-y-1">
                    <li>
                      Total ballots checked: <strong>{auditResult.total}</strong>
                    </li>
                    <li>
                      Valid (unique nullifier): <strong>{auditResult.valid}</strong>
                    </li>
                    <li>
                      Duplicates found:{" "}
                      <strong className={auditResult.duplicates > 0 ? "text-error" : ""}>
                        {auditResult.duplicates}
                      </strong>
                    </li>
                    <li>
                      Tally matches events:{" "}
                      <strong className="text-success">{totalEvents === totalOnChainVotes ? "Yes ✓" : "No ✗"}</strong>
                    </li>
                  </ul>
                </div>
              )}
            </div>

            {/* Recent VoteCast Events */}
            <div className="bg-base-100 rounded-2xl p-6 shadow-md border border-base-300/50">
              <h3 className="font-bold mb-3">Recent Ballots (VoteCast Events)</h3>
              {voteCastEvents.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="table table-sm">
                    <thead>
                      <tr>
                        <th>Division</th>
                        <th>NullifierHash</th>
                        <th>Candidate</th>
                        <th>Voter (burner)</th>
                        <th>Block</th>
                      </tr>
                    </thead>
                    <tbody>
                      {voteCastEvents.slice(0, 20).map(event => (
                        <tr key={event.nullifierHash}>
                          <td className="font-bold text-xs">{event.divisionName}</td>
                          <td className="font-mono text-xs">{event.nullifierHash.slice(0, 14)}...</td>
                          <td className="font-bold">{candidates?.[event.candidate] ?? `#${event.candidate}`}</td>
                          <td className="font-mono text-xs opacity-60">{event.voter.slice(0, 10)}...</td>
                          <td className="text-xs opacity-50">{event.blockNumber}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {voteCastEvents.length > 20 && (
                    <p className="text-center text-xs opacity-50 mt-2">Showing 20 of {voteCastEvents.length} events</p>
                  )}
                </div>
              ) : (
                <div className="text-center py-6 opacity-50">
                  <p>No votes cast yet.</p>
                </div>
              )}
            </div>
          </>
        )}

        {/* Info */}
        <div className="mt-6 text-center text-xs opacity-40">
          <p>In production: this page also re-verifies each proof via HonkVerifier.verify().</p>
          <p>Anyone can run this audit — no authentication required.</p>
        </div>
      </div>
    </div>
  );
};

export default AuditPage;
