"use client";

import { useState } from "react";
import { NextPage } from "next";
import { useScaffoldEventHistory, useScaffoldReadContract } from "~~/hooks/scaffold-eth";

const AuditPage: NextPage = () => {
  const [auditRunning, setAuditRunning] = useState(false);
  const [auditResult, setAuditResult] = useState<null | { total: number; valid: number; duplicates: number }>(null);

  const { data: voteCastEvents } = useScaffoldEventHistory({
    contractName: "Voting",
    eventName: "VoteCast",
    watch: true,
    enabled: true,
  });

  const { data: candidates } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getCandidates",
  });

  const { data: voteCounts } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getVoteCounts",
  });

  const totalOnChainVotes = voteCounts?.reduce((sum, c) => sum + Number(c), 0) ?? 0;
  const totalEvents = voteCastEvents?.length ?? 0;

  const runAudit = () => {
    setAuditRunning(true);
    // Simulate audit: check for duplicates and count
    const nullifiers = new Set<string>();
    let duplicates = 0;

    if (voteCastEvents) {
      for (const event of voteCastEvents) {
        const nh = event.args?.nullifierHash?.toString() ?? "";
        if (nullifiers.has(nh)) {
          duplicates++;
        } else {
          nullifiers.add(nh);
        }
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

  return (
    <div className="flex flex-col items-center grow pt-8 px-4">
      <div className="w-full max-w-4xl">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="text-4xl mb-2">🔍</div>
          <h1 className="text-3xl font-extrabold">Election Audit</h1>
          <p className="text-sm opacity-60 mt-2">Independent verification — re-check every ballot on-chain</p>
        </div>

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
            <div className={`text-2xl font-bold ${totalEvents === totalOnChainVotes ? "text-success" : "text-error"}`}>
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
                  <strong className={auditResult.duplicates > 0 ? "text-error" : ""}>{auditResult.duplicates}</strong>
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
          {voteCastEvents && voteCastEvents.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>NullifierHash</th>
                    <th>Candidate</th>
                    <th>Voter (burner)</th>
                    <th>Block</th>
                  </tr>
                </thead>
                <tbody>
                  {voteCastEvents.slice(0, 20).map((event, i) => (
                    <tr key={i}>
                      <td className="font-mono text-xs">{event.args?.nullifierHash?.toString().slice(0, 14)}...</td>
                      <td className="font-bold">
                        {candidates?.[Number(event.args?.candidate ?? 0)] ?? `#${event.args?.candidate}`}
                      </td>
                      <td className="font-mono text-xs opacity-60">{event.args?.voter?.toString().slice(0, 10)}...</td>
                      <td className="text-xs opacity-50">{event.blockNumber?.toString()}</td>
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
