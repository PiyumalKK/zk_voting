"use client";

import { useEffect, useState } from "react";
import { BusyOverlay } from "~~/app/voting/admin/_components/BusyOverlay";
import { Section } from "~~/app/voting/admin/_components/Section";
import { useDivisions } from "~~/hooks/useDivisions";
import { notification } from "~~/utils/scaffold-eth";

/**
 * Bulk creation of divisions — the batch counterpart of `AddDivisionSection`'s
 * one-at-a-time form, for the case where an election has thousands of GN
 * divisions and creating each one by hand is not practical.
 *
 * Feeds `POST /api/divisions/bulk` from either a CSV upload or a pull from an
 * external identity-management API — the same `{ source: "csv" | "api" }`
 * shape `BulkGnAccountsSection` uses, so both inputs produce identical
 * results below. Each row runs the exact create-then-authorise sequence the
 * manual form runs, so a division created here needs no extra step before a
 * GN officer can be assigned to it (in GN Officer Management above) and start
 * enrolling voters.
 */

type Source = "csv" | "api";

interface RowResult {
  row: number;
  name?: string;
  votingContract?: string;
  authorised?: boolean;
  error?: string;
}

const csvCell = (value: string | number | boolean | undefined): string => {
  const text = value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const downloadCsv = (results: RowResult[]) => {
  const header = ["name", "votingContract", "authorised", "error"];
  const lines = [header.join(",")];
  for (const result of results) {
    lines.push(
      [csvCell(result.name), csvCell(result.votingContract), csvCell(result.authorised), csvCell(result.error)].join(
        ",",
      ),
    );
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `divisions-import-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

/**
 * Persists the last import's results across navigation, same reasoning and
 * pattern as `BulkVoterRollSection` — the operator's workflow spans other
 * admin tabs (assigning a GN officer, checking the division list), so
 * losing the table on every page change would force a re-import to see it
 * again.
 */
const RESULTS_STORAGE_KEY = "bulkDivisionsResults";

export const BulkDivisionsSection = () => {
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
      const response = await fetch("/api/divisions/bulk", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error ?? `Import failed (${response.status}).`);

      setResults(payload.results ?? []);
      refetchDivisions();
      notification.success(`Created ${payload.succeeded} division(s), ${payload.failed} failed.`);
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Bulk import failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <BusyOverlay show={busy} label="Importing divisions…" />
      <Section
        title="Bulk Division Import"
        hint="Deploy many divisions at once, from a CSV or an identity-management API. Column/field: name (division / division name also accepted). Each row runs the same deploy-register-authorise sequence as the manual form above."
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
            <label className="label" htmlFor="bulk-division-csv">
              <span className="label-text text-sm font-bold">CSV file</span>
            </label>
            <input
              id="bulk-division-csv"
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
              <label className="label" htmlFor="bulk-division-api-url">
                <span className="label-text text-sm font-bold">API URL</span>
              </label>
              <input
                id="bulk-division-api-url"
                type="text"
                className="input input-bordered w-full"
                placeholder="https://identity.example.gov.lk/divisions"
                value={apiUrl}
                onChange={event => setApiUrl(event.target.value)}
                disabled={busy}
              />
            </div>
            <div className="form-control">
              <label className="label" htmlFor="bulk-division-api-key">
                <span className="label-text text-sm font-bold">API key (optional)</span>
              </label>
              <input
                id="bulk-division-api-key"
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
          {busy ? "Importing…" : "Import divisions"}
        </button>

        {results && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm opacity-70">
                {results.filter(result => result.votingContract).length} succeeded,{" "}
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
            <div className={`overflow-x-auto ${results.length > 15 ? "max-h-[32rem] overflow-y-auto" : ""}`}>
              <table className="table table-sm">
                <thead className="sticky top-0 z-10 bg-base-100">
                  <tr>
                    <th>Row</th>
                    <th>Name</th>
                    <th>Voting Contract</th>
                    <th>Authorised</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map(result => (
                    <tr key={result.row}>
                      <td>{result.row}</td>
                      <td className="font-bold">{result.name}</td>
                      <td className="font-mono text-xs">
                        {result.votingContract
                          ? `${result.votingContract.slice(0, 10)}…${result.votingContract.slice(-4)}`
                          : ""}
                      </td>
                      <td>
                        {result.votingContract ? (
                          result.authorised ? (
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
