"use client";

import { useCallback, useEffect, useState } from "react";
import { Section } from "~~/app/voting/admin/_components/Section";
import { useDivisions } from "~~/hooks/useDivisions";
import type { PublicGnAccount } from "~~/services/auth/accounts";
import { notification } from "~~/utils/scaffold-eth";

/**
 * GN officer accounts — custom-chain mode only (M12 build-order item 6).
 *
 * On the custom chain a GN officer has no wallet, so "assigning a GN" is two
 * steps that must not drift apart: a credential account with a server-held
 * signing key, and an on-chain `setGNOfficer` binding that key's address to the
 * division. `POST /api/gn-accounts` does both in one call and reports whether
 * the chain half succeeded, which is what `assignError` below surfaces.
 *
 * The generated password is shown exactly once. Only its bcrypt hash is stored,
 * so there is no "show it again" — the panel says so plainly rather than
 * letting an admin close the dialog and find out later.
 */

interface CreatedAccount {
  username: string;
  password: string;
  address: string;
  divisionId: number;
  divisionName: string;
  assigned: boolean;
  assignError?: string;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const GnAccountsSection = () => {
  const { divisions, refetch: refetchDivisions } = useDivisions();
  const [accounts, setAccounts] = useState<PublicGnAccount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [divisionId, setDivisionId] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedAccount | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/gn-accounts", { credentials: "same-origin" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error ?? `Could not load accounts (${response.status}).`);
      setAccounts(Array.isArray(body.accounts) ? body.accounts : []);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load GN accounts.");
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [load]);

  // Keep the division selector pointed at something that exists.
  useEffect(() => {
    if (divisions.length > 0 && !divisions.some(division => division.id === divisionId)) {
      setDivisionId(divisions[0].id);
    }
  }, [divisions, divisionId]);

  const call = async (label: string, init: RequestInit & { url: string }) => {
    setBusy(label);
    try {
      const { url, ...rest } = init;
      const response = await fetch(url, { credentials: "same-origin", ...rest });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status}).`);
      return body;
    } finally {
      setBusy(null);
    }
  };

  const handleCreate = async () => {
    const name = username.trim().toLowerCase();
    if (!name) {
      notification.error("Enter a username for the officer.");
      return;
    }
    try {
      const body = (await call("create", {
        url: "/api/gn-accounts",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: name, divisionId }),
      })) as CreatedAccount;

      setCreated(body);
      setUsername("");
      await load();
      refetchDivisions();
      if (!body.assigned) {
        notification.error(`Account created, but setGNOfficer failed: ${body.assignError ?? "unknown error"}`);
      }
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Could not create the account.");
    }
  };

  const handleToggle = async (account: PublicGnAccount) => {
    try {
      await call(`toggle:${account.username}`, {
        url: "/api/gn-accounts",
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: account.username, disabled: !account.disabled }),
      });
      await load();
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Could not update the account.");
    }
  };

  const handleDelete = async (account: PublicGnAccount) => {
    const confirmed = window.confirm(
      `Delete the account "${account.username}"?\n\nTheir signing key is destroyed and they can no longer enrol voters. ` +
        `The division's on-chain gnOfficer is left as-is — clear it from GN Officer Management above if that is what you want.`,
    );
    if (!confirmed) return;
    try {
      await call(`delete:${account.username}`, {
        url: `/api/gn-accounts?username=${encodeURIComponent(account.username)}`,
        method: "DELETE",
      });
      await load();
      setCreated(prev => (prev?.username === account.username ? null : prev));
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Could not delete the account.");
    }
  };

  const divisionName = (id: number) => divisions.find(division => division.id === id)?.name ?? `Division ${id}`;

  /** Whether the chain currently recognises this account's address for its division. */
  const isBoundOnChain = (account: PublicGnAccount) => {
    const division = divisions.find(candidate => candidate.id === account.divisionId);
    if (!division || division.gnOfficer === ZERO_ADDRESS) return false;
    return division.gnOfficer.toLowerCase() === account.address.toLowerCase();
  };

  return (
    <Section
      title="GN Officer Accounts"
      hint="Credential logins for GN officers. Creating one generates a server-held signing key and assigns it on-chain."
    >
      {loadError && (
        <div className="alert alert-error text-sm" role="alert">
          <span>{loadError}</span>
        </div>
      )}

      {created && (
        <div className="alert alert-success flex-col items-start gap-2 text-sm" role="status">
          <div className="font-bold">Account created — copy the password now, it is not stored.</div>
          <div className="font-mono text-xs break-all">
            <div>username: {created.username}</div>
            <div>password: {created.password}</div>
            <div>address: {created.address}</div>
            <div>division: {created.divisionName}</div>
          </div>
          {!created.assigned && (
            <div className="text-xs opacity-80">
              On-chain assignment failed ({created.assignError ?? "unknown error"}). Assign the address above from
              section 6 before this officer enrols anyone.
            </div>
          )}
          <button className="btn btn-xs" onClick={() => setCreated(null)}>
            I have saved it
          </button>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <div className="form-control">
          <label className="label" htmlFor="gn-username">
            <span className="label-text text-sm font-bold">Username</span>
          </label>
          <input
            id="gn-username"
            type="text"
            className="input input-bordered w-full"
            placeholder="gn.kaduwela"
            value={username}
            autoCapitalize="none"
            spellCheck={false}
            onChange={event => setUsername(event.target.value)}
            disabled={busy === "create"}
          />
        </div>

        <div className="form-control">
          <label className="label" htmlFor="gn-division">
            <span className="label-text text-sm font-bold">Division</span>
          </label>
          <select
            id="gn-division"
            className="select select-bordered w-full"
            value={divisionId}
            onChange={event => setDivisionId(Number(event.target.value))}
            disabled={busy === "create" || divisions.length === 0}
          >
            {divisions.map(division => (
              <option key={division.votingContract} value={division.id}>
                {division.name}
              </option>
            ))}
          </select>
        </div>

        <button
          className="btn btn-primary btn-sm"
          onClick={handleCreate}
          disabled={busy === "create" || !username.trim() || divisions.length === 0}
        >
          {busy === "create" ? "Creating…" : "Create officer"}
        </button>
      </div>

      <p className="text-xs opacity-50">
        Usernames are 3–32 characters: letters, digits, dot, underscore or hyphen. The officer signs in at{" "}
        <code>/login</code>.
      </p>

      {accounts === null ? (
        <div className="flex items-center gap-2 opacity-60 text-sm">
          <span className="loading loading-spinner loading-sm" />
          Loading accounts…
        </div>
      ) : accounts.length === 0 ? (
        <p className="text-sm opacity-60">No GN accounts yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Username</th>
                <th>Division</th>
                <th>Address</th>
                <th>On chain</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map(account => (
                <tr key={account.id}>
                  <td className="font-bold">{account.username}</td>
                  <td>{divisionName(account.divisionId)}</td>
                  <td className="font-mono text-xs">
                    {account.address.slice(0, 10)}…{account.address.slice(-4)}
                  </td>
                  <td>
                    {isBoundOnChain(account) ? (
                      <span className="badge badge-success badge-xs">Assigned</span>
                    ) : (
                      <span className="badge badge-warning badge-xs">Not assigned</span>
                    )}
                  </td>
                  <td>
                    {account.disabled ? (
                      <span className="badge badge-ghost badge-xs">Suspended</span>
                    ) : (
                      <span className="badge badge-success badge-xs">Active</span>
                    )}
                  </td>
                  <td className="flex gap-1 justify-end">
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => handleToggle(account)}
                      disabled={busy === `toggle:${account.username}`}
                    >
                      {account.disabled ? "Restore" : "Suspend"}
                    </button>
                    <button
                      className="btn btn-ghost btn-xs text-error"
                      onClick={() => handleDelete(account)}
                      disabled={busy === `delete:${account.username}`}
                    >
                      Delete
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
