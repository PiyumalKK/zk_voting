"use client";

import { useCallback, useEffect, useState } from "react";
import { AddressInput } from "@scaffold-ui/components";
import { useAdminElection } from "~~/app/voting/admin/_components/AdminElectionProvider";
import { Section } from "~~/app/voting/admin/_components/Section";
import { SET_GN_OFFICER_ABI } from "~~/app/voting/admin/_components/adminContracts";
import { useDivisions } from "~~/hooks/useDivisions";
import { useElectionWriter } from "~~/hooks/useElectionWriter";
import { notification } from "~~/utils/scaffold-eth";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Assign the on-chain GN officer for a division.
 *
 * Owns its own division selection deliberately: this is a staffing table, and
 * the officer you are appointing is often not the division you are running an
 * election in.
 *
 * In custom-chain mode a non-zero `s_gnOfficer` is *not* enough to conclude the
 * division is staffed. An officer signs in with credentials and the server holds
 * their key, so an address with no matching account cannot produce a
 * transaction — and that is the normal state of a chain deployed before this was
 * understood, where the deploy script wrote Hardhat wallet addresses. Showing
 * those as plain "Assigned" is how a chain that cannot enrol a single voter
 * looks fully configured.
 */
export const GNManagementSection = () => {
  const [gnAddress, setGnAddress] = useState("");
  const [selectedDivision, setSelectedDivision] = useState(0);
  const { divisions, isLoading: divisionsLoading, error: divisionsError, refetch } = useDivisions();
  const { write } = useElectionWriter();

  // From the provider, not `isCustomMode()` directly: every other panel in the
  // admin area reads the mode through `useAdminElection`, and two spellings of
  // the same question are how they drift apart.
  const { isCustom } = useAdminElection();
  /** Lower-cased addresses of every credential account. `null` until loaded / when not applicable. */
  const [accountAddresses, setAccountAddresses] = useState<Set<string> | null>(null);

  const loadAccounts = useCallback(async () => {
    if (!isCustom) return;
    try {
      const response = await fetch("/api/gn-accounts", { credentials: "same-origin" });
      if (!response.ok) return;
      const body = (await response.json()) as { accounts?: { address?: string }[] };
      setAccountAddresses(
        new Set((body.accounts ?? []).map(account => (account.address ?? "").toLowerCase()).filter(Boolean)),
      );
    } catch {
      // A failed read must not turn every row into a warning — leaving this
      // `null` keeps the table honest about not knowing.
    }
  }, [isCustom]);

  useEffect(() => {
    loadAccounts();
    const interval = setInterval(loadAccounts, 4000);
    return () => clearInterval(interval);
  }, [loadAccounts]);

  /**
   * Whether this address can actually sign for its division.
   *
   * Hardhat: any non-zero address is a wallet somebody may hold, so the question
   * does not arise.
   */
  const isUsableOfficer = (address: string): boolean | undefined => {
    if (!address || address === ZERO_ADDRESS) return false;
    if (!isCustom || accountAddresses === null) return undefined;
    return accountAddresses.has(address.toLowerCase());
  };

  const orphaned = divisions.filter(
    division => isUsableOfficer(division.gnOfficer) === false && division.gnOfficer !== ZERO_ADDRESS,
  );

  const unassigned = divisions.filter(division => !division.gnOfficer || division.gnOfficer === ZERO_ADDRESS);

  // Keep selection valid as divisions load in.
  useEffect(() => {
    if (divisions.length > 0 && selectedDivision >= divisions.length) {
      setSelectedDivision(0);
    }
  }, [divisions.length, selectedDivision]);

  const handleAssignGN = async () => {
    if (!gnAddress || !gnAddress.startsWith("0x") || gnAddress.length !== 42) {
      notification.error("Enter a valid Ethereum address.");
      return;
    }
    const div = divisions[selectedDivision];
    if (!div) {
      notification.error("No division selected.");
      return;
    }
    try {
      await write({
        address: div.votingContract,
        abi: SET_GN_OFFICER_ABI,
        functionName: "setGNOfficer",
        args: [gnAddress as `0x${string}`],
      });

      notification.success(`✅ GN assigned to ${div.name}!`);
      setGnAddress("");
      refetch();
      loadAccounts();
    } catch (e: any) {
      notification.error(e?.shortMessage || e?.message || "Failed to assign GN");
    }
  };

  const selected = divisions[selectedDivision];
  const currentDivGN = selected?.gnOfficer || "";
  const isZeroAddr = !currentDivGN || currentDivGN === "0x0000000000000000000000000000000000000000";

  return (
    <Section title="GN Officer Management" hint="Assign GN officers to specific polling divisions.">
      {divisionsError && (
        <div className="alert alert-error mb-4 text-sm">
          <span>⚠️ {divisionsError}</span>
        </div>
      )}

      {orphaned.length > 0 && (
        <div className="alert alert-warning flex-col items-start gap-1 text-sm mb-4">
          <span className="font-bold">
            {orphaned.length} division{orphaned.length === 1 ? "" : "s"} cannot enrol voters.
          </span>
          <p className="text-xs opacity-80">
            {orphaned.map(division => division.name).join(", ")} name{orphaned.length === 1 ? "s" : ""} an on-chain
            officer with no credential account, so nobody can sign for {orphaned.length === 1 ? "it" : "them"}. This can
            happen if the chain was deployed with wallet-mode defaults, or if an officer&apos;s credential account was
            deleted. Create a new officer in <strong>GN Officer Accounts</strong> below to generate a new signing key
            and rebind the division, or assign the zero address (0x000...000) to clear it.
          </p>
        </div>
      )}

      {unassigned.length > 0 && (
        <div className="alert alert-info flex-col items-start gap-1 text-sm mb-4">
          <span className="font-bold">
            {unassigned.length} division{unassigned.length === 1 ? "" : "s"} lack{unassigned.length === 1 ? "s" : ""} an
            assigned officer.
          </span>
          <p className="text-xs opacity-80">
            {unassigned.map(division => division.name).join(", ")} {unassigned.length === 1 ? "has" : "have"} no GN
            officer assigned, so nobody can enrol voters for {unassigned.length === 1 ? "it" : "them"}. Assign an
            officer to enable voter enrolment.
          </p>
        </div>
      )}
      {divisionsLoading && divisions.length === 0 ? (
        <div className="flex items-center gap-2 py-6 opacity-60">
          <span className="loading loading-spinner loading-sm"></span>
          <span>Loading divisions from the ElectionRegistry…</span>
        </div>
      ) : divisions.length === 0 ? (
        <div className="text-sm opacity-60 py-4">No divisions registered yet. Deploy divisions first.</div>
      ) : (
        <>
          {/* Division Selector */}
          <div className="form-control mb-4">
            <label className="label">
              <span className="label-text text-sm font-bold">Select Division</span>
            </label>
            <select
              className="select select-bordered w-full"
              value={selectedDivision}
              onChange={e => setSelectedDivision(Number(e.target.value))}
            >
              {divisions.map((div, idx) => (
                <option key={div.votingContract} value={idx}>
                  {div.name} — {div.votingContract.slice(0, 10)}...
                </option>
              ))}
            </select>
          </div>

          {/* Current GN for selected division */}
          <div className="p-3 bg-base-200/50 rounded-lg mb-4">
            <div className="text-xs opacity-60 mb-1">
              Current GN for <strong>{selected?.name}</strong>
            </div>
            <div className="font-mono text-sm flex items-center gap-2">
              {!isZeroAddr ? (
                <>
                  <span
                    className={
                      isUsableOfficer(currentDivGN) === false ? "text-warning line-through opacity-70" : "text-success"
                    }
                  >
                    {currentDivGN}
                  </span>
                  {isUsableOfficer(currentDivGN) === false && (
                    <span className="badge badge-error badge-outline badge-xs font-sans">No Account</span>
                  )}
                </>
              ) : (
                <span className="opacity-40">None assigned</span>
              )}
            </div>
            {isUsableOfficer(currentDivGN) === false && !isZeroAddr && (
              <div className="text-xs text-warning mt-1">
                No credential account holds this address — this officer cannot sign in.
              </div>
            )}
          </div>

          {/* All divisions overview */}
          <div className="overflow-x-auto mb-4">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Division</th>
                  <th>GN Officer</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {divisions.map((div, idx) => {
                  const gn = div.gnOfficer || "";
                  const assigned = gn && gn !== ZERO_ADDRESS;
                  const usable = isUsableOfficer(gn);
                  return (
                    <tr key={div.votingContract} className={selectedDivision === idx ? "bg-primary/10" : ""}>
                      <td className="font-bold">{div.name}</td>
                      <td className="font-mono text-xs">
                        <span className={assigned && usable === false ? "line-through opacity-70" : ""}>
                          {assigned ? `${gn.slice(0, 10)}...${gn.slice(-4)}` : "—"}
                        </span>
                      </td>
                      <td>
                        {!assigned ? (
                          <span className="badge badge-ghost badge-xs">Empty</span>
                        ) : usable === false ? (
                          <span
                            className="badge badge-warning badge-xs"
                            title="No credential account holds this address, so this officer cannot sign."
                          >
                            No account
                          </span>
                        ) : (
                          <span className="badge badge-success badge-xs">Assigned</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Assign new GN */}
          <div className="space-y-3">
            <div className="form-control">
              <label className="label">
                <span className="label-text text-sm">New GN Address for {selected?.name}</span>
              </label>
              <AddressInput value={gnAddress} onChange={setGnAddress} placeholder="0x..." />
            </div>

            <div className="flex gap-2 justify-end">
              <button className="btn btn-primary btn-sm" disabled={!gnAddress} onClick={handleAssignGN}>
                Assign GN to {selected?.name}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Test accounts */}
      <div className="text-xs opacity-40 mt-3">
        <details>
          <summary className="cursor-pointer">Test GN accounts (Hardhat)</summary>
          <div className="mt-2 space-y-1 font-mono text-xs">
            <div>GN Kaduwela (#1): 0x70997970C51812dc3A010C7d01b50e0d17dc79C8</div>
            <div>GN Colombo (#2): 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC</div>
            <div>GN Gampaha (#3): 0x90F79bf6EB2c4f870365E785982E1f101E93b906</div>
          </div>
        </details>
      </div>
    </Section>
  );
};
