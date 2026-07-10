"use client";

import { useState } from "react";
import { useVoterId, useVoterStatus } from "~~/services/chain/hooks";

/**
 * Identity card for the CUSTOM chain backend: the voter enters the ID the
 * admin allowlisted (e.g. an email or index number) — the wallet-free
 * replacement for "Connect wallet". Rendered only when
 * NEXT_PUBLIC_CHAIN_BACKEND=custom; on the EVM backend identity is the
 * connected wallet and this card is not shown.
 *
 * Privacy note: this ID only gates registration (allowlist + commitment).
 * Votes are submitted with a ZK proof and carry no identity at all.
 */
export const VoterIdCard = () => {
  const { voterId, setVoterId, ready } = useVoterId();
  const status = useVoterStatus();
  const [draft, setDraft] = useState<string | null>(null);

  const editing = draft !== null || !ready;
  const value = draft ?? voterId;

  const save = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setVoterId(trimmed);
    setDraft(null);
  };

  return (
    <div className="bg-base-100/60 backdrop-blur-xl shadow-2xl rounded-3xl p-6 space-y-3 border border-base-300/50">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-bold">Your voter ID</h2>
          <p className="text-xs opacity-60">
            The ID the election admin registered for you (e.g. your email). Used only for registration — your vote stays
            anonymous.
          </p>
        </div>
        {ready && !editing && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm bg-base-200 px-3 py-1 rounded-lg">{voterId}</span>
            {status && (
              <span className={`badge badge-sm ${status.allowed ? "badge-success" : "badge-error"}`}>
                {status.allowed ? "On voters list" : "Not on voters list"}
              </span>
            )}
            <button className="btn btn-ghost btn-xs" onClick={() => setDraft(voterId)}>
              Change
            </button>
          </div>
        )}
      </div>

      {editing && (
        <div className="flex gap-2">
          <input
            type="text"
            className="input input-bordered flex-1"
            placeholder="you@example.com"
            value={value}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => e.key === "Enter" && save()}
          />
          <button className="btn btn-primary" disabled={!value.trim()} onClick={save}>
            Save
          </button>
          {ready && (
            <button className="btn btn-ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
};
