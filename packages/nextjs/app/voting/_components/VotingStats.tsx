"use client";

import { useEffect, useState } from "react";
import { Address } from "@scaffold-ui/components";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-eth";

const PHASE_LABELS = ["Setup", "Registration", "Voting", "Ended"] as const;
const PHASE_BADGE: Record<number, string> = {
  0: "badge-ghost",
  1: "badge-info",
  2: "badge-success",
  3: "badge-neutral",
};

const PALETTES = [
  { bar: "bg-success", border: "border-success/20", bg: "bg-success/5", text: "text-success" },
  { bar: "bg-error", border: "border-error/20", bg: "bg-error/5", text: "text-error" },
  { bar: "bg-primary", border: "border-primary/20", bg: "bg-primary/5", text: "text-primary" },
  { bar: "bg-secondary", border: "border-secondary/20", bg: "bg-secondary/5", text: "text-secondary" },
  { bar: "bg-accent", border: "border-accent/20", bg: "bg-accent/5", text: "text-accent" },
  { bar: "bg-warning", border: "border-warning/20", bg: "bg-warning/5", text: "text-warning" },
  { bar: "bg-info", border: "border-info/20", bg: "bg-info/5", text: "text-info" },
];

function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "ended";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export const VotingStats = () => {
  const { data: deployedContractData } = useDeployedContractInfo({ contractName: "Voting" });

  const { data: votingData } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getVotingData",
  });

  const { data: candidates } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getCandidates",
  });

  const { data: voteCounts } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getVoteCounts",
  });

  // Live ticking clock for countdown.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const question = votingData?.[0] as string | undefined;
  const owner = votingData?.[1] as `0x${string}` | undefined;
  const phase = Number(votingData?.[2] ?? 0);
  const registrationEnd = Number(votingData?.[3] ?? 0);
  const votingEnd = Number(votingData?.[4] ?? 0);

  const list = (candidates as readonly string[] | undefined) ?? [];
  const counts = (voteCounts as readonly bigint[] | undefined) ?? [];
  const total = counts.reduce((acc, c) => acc + c, 0n);

  const phaseLabel = PHASE_LABELS[phase] ?? "Unknown";
  const badge = PHASE_BADGE[phase] ?? "badge-ghost";

  const remaining =
    phase === 1 && registrationEnd > now
      ? formatRemaining(registrationEnd - now)
      : phase === 2 && votingEnd > now
        ? formatRemaining(votingEnd - now)
        : null;

  const remainingLabel = phase === 1 ? "Registration closes in" : phase === 2 ? "Voting closes in" : null;

  return (
    <div className="bg-base-100 shadow-lg rounded-2xl p-6 space-y-4 border border-base-300/50 hover-lift">
      <div className="text-center space-y-2">
        <div className="flex justify-center">
          <span className={`badge ${badge} badge-lg`}>Phase: {phaseLabel}</span>
        </div>
        <h2 className="text-2xl font-bold">{question || "Loading..."}</h2>
        <div className="flex flex-wrap justify-center gap-x-10 gap-y-1 text-sm">
          <div>
            Contract: <Address address={deployedContractData?.address} />
          </div>
          <div>
            Owner: <Address address={owner} />
          </div>
        </div>
        <div className="text-xs opacity-60">Total votes cast: {total.toString()}</div>
        {remaining && remainingLabel && (
          <div className="text-xs font-medium opacity-80">
            {remainingLabel}: <span className="font-mono">{remaining}</span>
          </div>
        )}
      </div>

      {list.length === 0 ? (
        <p className="text-center text-sm opacity-60">No candidates configured yet.</p>
      ) : (
        <>
          <div
            className={`grid gap-3 ${list.length <= 2 ? "grid-cols-2" : list.length <= 3 ? "grid-cols-3" : "grid-cols-2 md:grid-cols-3"}`}
          >
            {list.map((name, idx) => {
              const c = counts[idx] ?? 0n;
              const pct = total > 0n ? Number((c * 1000n) / total) / 10 : 0;
              const p = PALETTES[idx % PALETTES.length];
              return (
                <div key={`${idx}-${name}`} className={`rounded-xl border ${p.border} ${p.bg} p-4 text-center`}>
                  <div className="text-xs opacity-60 font-medium uppercase tracking-wider truncate" title={name}>
                    {name}
                  </div>
                  <div className={`text-2xl font-bold ${p.text}`}>{c.toString()}</div>
                  <div className="text-xs opacity-60">{pct.toFixed(1)}%</div>
                </div>
              );
            })}
          </div>

          {total > 0n && (
            <div className="w-full bg-base-200 rounded-full h-3 overflow-hidden flex shadow-inner">
              {list.map((name, idx) => {
                const c = counts[idx] ?? 0n;
                const pct = total > 0n ? Number((c * 1000n) / total) / 10 : 0;
                const p = PALETTES[idx % PALETTES.length];
                return (
                  <div
                    key={`bar-${idx}-${name}`}
                    className={`${p.bar} h-3 transition-all duration-500`}
                    style={{ width: `${pct}%` }}
                    title={`${name}: ${pct.toFixed(1)}%`}
                  />
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
};
