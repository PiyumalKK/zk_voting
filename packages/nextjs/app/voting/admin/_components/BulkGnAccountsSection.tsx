"use client";

import { useEffect, useState } from "react";
import { BusyOverlay } from "~~/app/voting/admin/_components/BusyOverlay";
import { Section } from "~~/app/voting/admin/_components/Section";
import { useDivisions } from "~~/hooks/useDivisions";
import { notification } from "~~/utils/scaffold-eth";

/**
 * Bulk creation of GN officer accounts — the batch counterpart of
 * `GnAccountsSection`'s one-at-a-time form.
 *
 * Feeds `POST /api/gn-accounts/bulk` from either a CSV upload or a pull from
 * an external identity-management API — the same `{ source: "csv" | "api" }`
 * shape the route's `RowSource` abstraction expects
 * (`services/bulkImport/rowSource.ts`), so both inputs produce identical
 * results below.
 *
 * Each row's password is shown exactly once, same as the single-account
 * flow — nothing here stores plaintext passwords server-side. "Export CSV"
 * just re-serialises what the API already returned into a downloadable file;
 * per instruction there is no additional encryption on this export.
 */

type Source = "csv" | "api";

interface RowResult {
  row: number;
  username?: string;
  divisionName?: string;
  password?: string;
  address?: string;
  assigned?: boolean;
  error?: string;
}

const csvCell = (value: string | number | boolean | undefined): string => {
  const text = value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const downloadCsv = (results: RowResult[]) => {
  const header = ["username", "division", "password", "address", "assigned", "error"];
  const lines = [header.join(",")];
  for (const result of results) {
    lines.push(
      [
        csvCell(result.username),
        csvCell(result.divisionName),
        csvCell(result.password),
        csvCell(result.address),
        csvCell(result.assigned),
        csvCell(result.error),
      ].join(","),
    );
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `gn-officer-accounts-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

/**
 * Persists the last import's results across navigation, same reasoning and
 * pattern as `BulkVoterRollSection` — the operator's workflow spans other
 * admin tabs (assigning the officer, checking a division), so losing the
 * table on every page change would force a re-import to see it again.
 */
const RESULTS_STORAGE_KEY = "bulkGnAccountsResults";

export const BulkGnAccountsSection = () => {
  const { refetch: refetchDivisions } = useDivisions();
  const [source, setSource] = useState<Source>("csv");
  const [csvFileName, setCsvFileName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<RowResult[] | null>(null);

  // Load whatever the last import left behind, once, on mount.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(RESULTS_STORAGE_KEY);
      if (stored) setResults(JSON.parse(stored));
    } catch {}
  }, []);

  // Keep it in sync so the table is still there after navigating away and back.
  useEffect(() => {
    try {
      if (results) localStorage.setItem(RESULTS_STORAGE_KEY, JSON.stringify(results));
      else localStorage.removeItem(RESULTS_STORAGE_KEY);
    } catch {}
  }, [results]);

  const handleClear = () => setResults(null);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setCsvFileName(file.name);
    setCsvText(await file.text());
  };

  const handleImport = async () => {
    const body =
      source === "csv"
        ? { source: "csv" as const, csv: csvText }
        : { source: "api" as const, url: apiUrl.trim(), apiKey: apiKey.trim() || undefined };

    if (source === "csv" && !csvText.trim()) {
      notification.error("Choose a CSV file first.");
      return;
    }
    if (source === "api" && !apiUrl.trim()) {
      notification.error("Enter the identity-management API URL.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/gn-accounts/bulk", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error ?? `Import failed (${response.status}).`);

      const rows: RowResult[] = payload.results ?? [];
      setResults(rows);
      refetchDivisions();
      notification.success(`Imported ${payload.succeeded} account(s), ${payload.failed} failed.`);
      // Passwords are shown exactly once and never recoverable afterwards — an
      // admin who forgets to click "Export CSV" loses them for good. Download
      // automatically so that can't happen; the button below stays for a
      // second copy if the browser blocked this one or it's needed again.
      if (rows.some(row => row.password)) {
        downloadCsv(rows);
      }
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Bulk import failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <BusyOverlay show={busy} label="Importing GN officer accounts…" />
      <Section
        title="Bulk GN Officer Import"
        hint="Create many GN officer accounts at once, from a CSV or an identity-management API. Columns/fields: username, division."
      >
        <div className="flex gap-2">
          <button
            type="button"
            className={`btn btn-sm ${source === "csv" ? "btn-primary" : "btn-outline"}`}
            onClick={() => setSource("csv")}
            disabled={busy}
          >
            CSV upload
          </button>
          <button
            type="button"
            className={`btn btn-sm ${source === "api" ? "btn-primary" : "btn-outline"}`}
            onClick={() => setSource("api")}
            disabled={busy}
          >
            Identity-management API
          </button>
        </div>

        {source === "csv" ? (
          <div className="form-control">
            <label className="label" htmlFor="bulk-gn-csv">
              <span className="label-text text-sm font-bold">CSV file</span>
            </label>
            <input
              id="bulk-gn-csv"
              type="file"
              accept=".csv,text/csv"
              className="file-input file-input-bordered w-full"
              onChange={event => void handleFile(event.target.files?.[0])}
              disabled={busy}
            />
            {csvFileName && <p className="text-xs opacity-60 mt-1">Loaded: {csvFileName}</p>}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="form-control">
              <label className="label" htmlFor="bulk-gn-api-url">
                <span className="label-text text-sm font-bold">API URL</span>
              </label>
              <input
                id="bulk-gn-api-url"
                type="text"
                className="input input-bordered w-full"
                placeholder="https://identity.example.gov.lk/gn-officers"
                value={apiUrl}
                onChange={event => setApiUrl(event.target.value)}
                disabled={busy}
              />
            </div>
            <div className="form-control">
              <label className="label" htmlFor="bulk-gn-api-key">
                <span className="label-text text-sm font-bold">API key (optional)</span>
              </label>
              <input
                id="bulk-gn-api-key"
                type="password"
                className="input input-bordered w-full"
                value={apiKey}
                onChange={event => setApiKey(event.target.value)}
                disabled={busy}
                autoComplete="off"
              />
            </div>
          </div>
        )}

        <button className="btn btn-primary btn-sm" onClick={handleImport} disabled={busy}>
          {busy ? "Importing…" : "Import accounts"}
        </button>

        {results && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm opacity-70">
                {results.filter(result => result.password).length} succeeded,{" "}
                {results.filter(result => result.error).length} failed.
              </p>
              <div className="flex gap-2">
                <button className="btn btn-xs" onClick={() => downloadCsv(results)}>
                  Export CSV
                </button>
                <button type="button" className="btn btn-xs" onClick={handleClear}>
                  Clear
                </button>
              </div>
            </div>
            <div className="alert alert-warning text-xs" role="alert">
              <span>
                Passwords below are plain text and shown only this once — nothing is stored server-side except their
                hash. A CSV with these was downloaded automatically; use Export CSV if your browser blocked it or you
                need another copy.
              </span>
            </div>
            <div className={`overflow-x-auto ${results.length > 15 ? "max-h-[32rem] overflow-y-auto" : ""}`}>
              <table className="table table-sm">
                <thead className="sticky top-0 z-10 bg-base-100">
                  <tr>
                    <th>Row</th>
                    <th>Username</th>
                    <th>Division</th>
                    <th>Password</th>
                    <th>Address</th>
                    <th>Assigned</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map(result => (
                    <tr key={result.row}>
                      <td>{result.row}</td>
                      <td className="font-bold">{result.username}</td>
                      <td>{result.divisionName}</td>
                      <td className="font-mono text-xs break-all">{result.password}</td>
                      <td className="font-mono text-xs">
                        {result.address ? `${result.address.slice(0, 10)}…${result.address.slice(-4)}` : ""}
                      </td>
                      <td>
                        {result.password ? (
                          result.assigned ? (
                            <span className="badge badge-success badge-xs">Yes</span>
                          ) : (
                            <span className="badge badge-warning badge-xs">No</span>
                          )
                        ) : (
                          ""
                        )}
                      </td>
                      <td className="text-error text-xs">{result.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Section>
    </>
  );
};
