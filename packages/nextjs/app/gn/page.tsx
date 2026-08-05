"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { NextPage } from "next";
import { createPublicClient, http, parseAbiItem } from "viem";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { useGnDivision } from "~~/hooks/useGnDivision";
import { PHASE_LABELS } from "~~/utils/electionPhase";

const GNDashboard: NextPage = () => {
  const { targetNetwork } = useTargetNetwork();
  // Which division this officer runs comes from the wallet on Hardhat and from
  // the session cookie on the custom chain — `useGnDivision` owns that split so
  // the rest of this page never has to know which backend it is on.
  const { division: myDivision, divisions, isLoading, error, identity, needsSignIn, mode } = useGnDivision();

  const isAuthorized = !!myDivision;
  const phase = myDivision?.phase ?? 0;
  const treeSize = myDivision?.treeSize ?? 0;
  const onChainGN = myDivision?.gnOfficer ?? "";
  const phaseColor = { 1: "text-info", 2: "text-success" }[phase] ?? "";

  // Voter roll for this division: addresses added to the allowlist (VoterAdded events),
  // each annotated with whether they have since registered a commitment.
  // treeSize only counts committed voters; the allowlist can be larger.
  interface RollEntry {
    address: string;
    registered: boolean;
  }
  const [voterRoll, setVoterRoll] = useState<RollEntry[] | null>(null);
  const [showRoll, setShowRoll] = useState(false);
  const allowlistCount = voterRoll?.length ?? null;
  const divisionContract = myDivision?.votingContract;

  useEffect(() => {
    if (!divisionContract) {
      setVoterRoll(null);
      return;
    }
    let cancelled = false;
    const client = createPublicClient({
      chain: targetNetwork,
      transport: http(targetNetwork.rpcUrls.default.http[0]),
    });
    const GET_VOTER_DATA = parseAbiItem(
      "function getVoterData(address _voter) view returns (bool voter, bool registered)",
    );
    (async () => {
      try {
        const logs = await client.getLogs({
          address: divisionContract,
          event: parseAbiItem("event VoterAdded(address indexed voter)"),
          fromBlock: 0n,
          toBlock: "latest",
        });
        const unique = [...new Set(logs.map(l => l.args.voter as string).filter(Boolean))];
        const roll = await Promise.all(
          unique.map(async (addr): Promise<RollEntry> => {
            try {
              const data = await client.readContract({
                address: divisionContract,
                abi: [GET_VOTER_DATA],
                functionName: "getVoterData",
                args: [addr as `0x${string}`],
              });
              return { address: addr, registered: Boolean((data as readonly boolean[])[1]) };
            } catch {
              return { address: addr, registered: false };
            }
          }),
        );
        // Keep only addresses still on the allowlist (voter flag true).
        if (!cancelled) setVoterRoll(roll);
      } catch {
        if (!cancelled) setVoterRoll(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [divisionContract, targetNetwork, treeSize]);

  if (needsSignIn) {
    return (
      <div className="flex flex-col items-center grow pt-16 px-4">
        <div className="text-center">
          <div className="text-5xl mb-4">👨‍💼</div>
          <h1 className="text-2xl font-bold mb-2">GN Portal</h1>
          {mode === "custom" ? (
            <>
              <p className="opacity-60 mb-4">Sign in with your officer credentials to access the GN dashboard.</p>
              <Link href="/login?next=%2Fgn" className="btn btn-primary btn-sm">
                Sign in
              </Link>
            </>
          ) : (
            <p className="opacity-60">Connect your wallet to access the GN dashboard.</p>
          )}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center grow pt-16 px-4">
        <div className="text-center max-w-md">
          <div className="text-5xl mb-4">⚠️</div>
          <h1 className="text-2xl font-bold mb-2">Cannot reach the election chain</h1>
          <p className="opacity-60 mb-4">{error}</p>
          <p className="text-sm opacity-40">Ensure the local node is running and contracts are deployed.</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col items-center grow pt-16 px-4">
        <div className="text-center">
          <span className="loading loading-spinner loading-lg text-primary" />
          <p className="opacity-60 mt-4">Checking your GN authorization on-chain…</p>
        </div>
      </div>
    );
  }

  if (!myDivision) {
    return (
      <div className="flex flex-col items-center grow pt-16 px-4">
        <div className="text-center max-w-md">
          <div className="text-5xl mb-4">🚫</div>
          <h1 className="text-2xl font-bold mb-2">Not a GN Officer</h1>
          <p className="opacity-60 mb-2">
            {mode === "custom"
              ? "This account is not scoped to a registered division:"
              : "This connected wallet is not assigned as GN for any division:"}
          </p>
          <code className="block text-xs bg-base-200 rounded-lg px-3 py-2 mb-4 break-all">{identity}</code>
          <div className="text-left text-sm bg-base-200/50 rounded-lg p-3 mb-4">
            <p className="font-semibold mb-1 opacity-70">Registered GN officers:</p>
            {divisions.map(d => (
              <div key={d.votingContract} className="flex justify-between gap-2 text-xs py-0.5">
                <span className="opacity-60">{d.name}</span>
                <code className="opacity-80">
                  {d.gnOfficer.slice(0, 8)}…{d.gnOfficer.slice(-6)}
                </code>
              </div>
            ))}
          </div>
          <p className="text-sm opacity-40">
            {mode === "custom"
              ? "Ask the Election Authority to create your officer account against a division in the Admin panel."
              : "If your address should be listed above, switch your wallet to the correct account. Otherwise ask the Election Authority to assign you via the Admin panel."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center grow pt-8 px-4">
      <div className="w-full max-w-4xl">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="text-4xl mb-2">👨‍💼</div>
          <h1 className="text-3xl font-extrabold text-base-content">GN Portal</h1>
          <p className="text-lg font-semibold text-primary mt-1">{myDivision.name} Division</p>
          <p className="text-xs opacity-50 mt-1 font-mono">{myDivision.votingContract}</p>
        </div>

        {/* Authorization status */}
        {isAuthorized ? (
          <div className="alert alert-success mb-6">
            <span>
              ✅ You are the authorized GN officer for <strong>{myDivision.name}</strong>
            </span>
          </div>
        ) : (
          <div className="alert alert-warning mb-6">
            <span>⚠️ Config mismatch: on-chain GN is {onChainGN?.slice(0, 10)}... — contact admin.</span>
          </div>
        )}

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-base-100 rounded-2xl p-5 shadow-md border border-base-300/50 text-center">
            <div className="text-3xl font-bold text-primary">{allowlistCount ?? "…"}</div>
            <div className="text-xs opacity-60 mt-1">Allowlisted Voters</div>
            <div className="text-[10px] opacity-40 mt-0.5">You enrolled</div>
          </div>
          <div className="bg-base-100 rounded-2xl p-5 shadow-md border border-base-300/50 text-center">
            <div className="text-3xl font-bold text-secondary">{treeSize}</div>
            <div className="text-xs opacity-60 mt-1">Registered</div>
            <div className="text-[10px] opacity-40 mt-0.5">Committed to tree</div>
          </div>
          <div className="bg-base-100 rounded-2xl p-5 shadow-md border border-base-300/50 text-center">
            <div className={`text-2xl font-bold ${phaseColor}`}>{PHASE_LABELS[phase]}</div>
            <div className="text-xs opacity-60 mt-1">Current Phase</div>
          </div>
          <div className="bg-base-100 rounded-2xl p-5 shadow-md border border-base-300/50 text-center">
            <div className="text-2xl font-bold text-accent">{myDivision.name}</div>
            <div className="text-xs opacity-60 mt-1">Your Division</div>
          </div>
        </div>

        {/* Enrollment explainer */}
        <div className="text-xs opacity-50 -mt-4 mb-4 text-center max-w-2xl mx-auto">
          <strong>Allowlisted</strong> = voters you added to the roll. They become <strong>Registered</strong> only
          after they submit their commitment from the voter app during the Registration phase.
        </div>

        {/* View voter roll button */}
        <div className="text-center mb-8">
          <button
            className="btn btn-outline btn-sm"
            disabled={!voterRoll || voterRoll.length === 0}
            onClick={() => setShowRoll(true)}
          >
            📋 View voter roll{voterRoll ? ` (${voterRoll.length})` : ""}
          </button>
        </div>

        {/* Voter roll modal */}
        {showRoll && voterRoll && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <button
              type="button"
              aria-label="Close voter roll"
              className="absolute inset-0 bg-black/50 cursor-default"
              onClick={() => setShowRoll(false)}
            />
            <div className="relative bg-base-100 rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
              <div className="flex justify-between items-center p-5 border-b border-base-300">
                <div>
                  <h3 className="font-bold text-lg">{myDivision.name} — Voter Roll</h3>
                  <p className="text-xs opacity-60">
                    {voterRoll.length} allowlisted · {voterRoll.filter(v => v.registered).length} registered
                  </p>
                </div>
                <button className="btn btn-ghost btn-sm btn-circle" onClick={() => setShowRoll(false)}>
                  ✕
                </button>
              </div>
              <div className="overflow-y-auto p-5">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Voter Address</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {voterRoll.map((v, i) => (
                      <tr key={v.address}>
                        <td className="opacity-50">{i + 1}</td>
                        <td className="font-mono text-xs break-all">{v.address}</td>
                        <td>
                          {v.registered ? (
                            <span className="badge badge-success badge-sm">Registered</span>
                          ) : (
                            <span className="badge badge-ghost badge-sm">Allowlisted</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Action Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Link
            href={`/gn/register?division=${myDivision.id}`}
            className="bg-base-100 rounded-2xl p-6 shadow-md border border-base-300/50 hover:border-primary/50 hover:shadow-lg transition-all cursor-pointer group"
          >
            <div className="text-2xl mb-3">📷</div>
            <h3 className="font-bold text-lg group-hover:text-primary transition-colors">Register New Voter</h3>
            <p className="text-sm opacity-60 mt-2">Verify NIC → Scan voter QR → Add to {myDivision.name} voter roll</p>
            {phase === 0 || phase === 1 ? (
              <span className="badge badge-success badge-sm mt-3">Available</span>
            ) : (
              <span className="badge badge-error badge-sm mt-3">Not available ({PHASE_LABELS[phase]})</span>
            )}
          </Link>

          <div className="bg-base-100 rounded-2xl p-6 shadow-md border border-base-300/50">
            <div className="text-2xl mb-3">📋</div>
            <h3 className="font-bold text-lg">Division Info</h3>
            <div className="text-sm opacity-60 mt-2 space-y-1">
              <div>
                Contract: <code className="text-xs">{myDivision.votingContract.slice(0, 14)}...</code>
              </div>
              <div>
                GN: <code className="text-xs">{myDivision.gnOfficer.slice(0, 14)}...</code>
              </div>
              <div>
                Allowlisted: {allowlistCount ?? "…"} · Registered: {treeSize}
              </div>
            </div>
          </div>
        </div>

        {/* Phase warnings */}
        {phase === 2 && (
          <div className="mt-6 alert alert-warning">
            <span>⚠️ Voting is in progress. You cannot add new voters during this phase.</span>
          </div>
        )}
        {phase === 3 && (
          <div className="mt-6 alert alert-info">
            <span>Election ended. Results are final. No further actions available.</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default GNDashboard;
