"use client";

import { useEffect, useState } from "react";
import { Section } from "~~/app/voting/admin/_components/Section";
import { notification } from "~~/utils/scaffold-eth";

/**
 * Bulk voter eligibility import — sends each row an SMS claim link instead of
 * requiring a GN visit. See `app/api/voter-roll/bulk/route.ts` for what this
 * actually does and does not do: it can never create a voter account outright
 * (the signing key only exists on the citizen's own phone), so this loads a
 * *pending invite* per row that the citizen's device redeems itself via
 * `packages/mobile/app/claim/[token].tsx`.
 */

type Source = "csv" | "api";

interface RowResult {
  row: number;
  nic?: string;
  divisionName?: string;
  status?: "sent";
  error?: string;
  /**
   * The raw claim link — present only while there's no real SMS gateway
   * wired in (see the matching gate in `app/api/voter-roll/bulk/route.ts`).
   * Hidden behind a "Get link" button rather than shown inline, per request,
   * so the table reads as "an SMS was sent" by default and the link is only
   * one deliberate click away for testing/demo purposes.
   */
  devLink?: string;
  /**
   * Same claim, as an `exp://` link Expo Go can open directly. `devLink`'s
   * `slvote://` scheme only becomes an openable URL once the app has been
   * through a real build — inside plain Expo Go it isn't a registered scheme
   * at all, which is why phones testing via Expo Go see it as inert text
   * rather than a link. Present only when `EXPO_DEV_SERVER_URL` is set.
   */
  testLink?: string;
}

/**
 * Persists the last import's results across navigation — the operator's
 * workflow spans switching to the mobile app to test a claim link and coming
 * back, so losing the table (and its one-time-use links) on every page
 * change would defeat the point. Same `localStorage`-backed pattern as
 * `useDivisions`' hidden-division list. Only this table's own rows are
 * stored, never anything that isn't already returned by the bulk-import
 * response.
 */
const RESULTS_STORAGE_KEY = "bulkVoterRollResults";

export const BulkVoterRollSection = () => {
  const [source, setSource] = useState<Source>("csv");
  const [csvFileName, setCsvFileName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<RowResult[] | null>(null);
  /** Keyed `${row}:${column}` so the claim link and the test link reveal independently. */
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

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

  const handleClear = () => {
    setResults(null);
    setRevealedKeys(new Set());
    setCopiedKey(null);
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setCsvFileName(file.name);
    setCsvText(await file.text());
  };

  const handleImport = async () => {
    if (source === "csv" && !csvText.trim()) {
      notification.error("Choose a CSV file first.");
      return;
    }
    if (source === "api" && !apiUrl.trim()) {
      notification.error("Enter the identity-management API URL.");
      return;
    }

    const body =
      source === "csv"
        ? { source: "csv" as const, csv: csvText }
        : { source: "api" as const, url: apiUrl.trim(), apiKey: apiKey.trim() || undefined };

    setBusy(true);
    try {
      const response = await fetch("/api/voter-roll/bulk", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error ?? `Import failed (${response.status}).`);

      setResults(payload.results ?? []);
      setRevealedKeys(new Set());
      setCopiedKey(null);
      notification.success(`Sent ${payload.succeeded} invite(s), ${payload.failed} failed.`);
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Bulk import failed.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Reveals one row's link (claim or test) and copies it to the clipboard in
   * one click — the operator's stated workflow is "copy this and send it
   * myself over WhatsApp or whatever," so the button should hand them a
   * ready-to-paste value immediately rather than requiring a second copy
   * step. Keyed by column as well as row, so revealing the claim link
   * doesn't also reveal that row's test link.
   */
  const revealAndCopy = async (key: string, link: string) => {
    setRevealedKeys(prev => new Set(prev).add(key));
    try {
      await navigator.clipboard.writeText(link);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(prev => (prev === key ? null : prev)), 2000);
    } catch {
      notification.error("Could not reach the clipboard — the link is shown below, copy it by hand.");
    }
  };

  const renderLinkCell = (row: number, column: "link" | "test", link: string | undefined, buttonLabel: string) => {
    if (!link) return null;
    const key = `${row}:${column}`;
    if (!revealedKeys.has(key)) {
      return (
        <button type="button" className="btn btn-xs btn-outline" onClick={() => void revealAndCopy(key, link)}>
          {buttonLabel}
        </button>
      );
    }
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-xs break-all">{link}</span>
        <button type="button" className="btn btn-xs" onClick={() => void revealAndCopy(key, link)}>
          {copiedKey === key ? "Copied" : "Copy"}
        </button>
      </div>
    );
  };

  return (
    <Section
      title="Bulk Voter Roll Import"
      hint="Import voter eligibility from a CSV or an identity-management API. Columns/fields: nic, phone, division. Each row gets an SMS with a link that finishes their enrolment on their own phone — no GN visit required."
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
          <label className="label" htmlFor="bulk-voter-csv">
            <span className="label-text text-sm font-bold">CSV file</span>
          </label>
          <input
            id="bulk-voter-csv"
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
            <label className="label" htmlFor="bulk-voter-api-url">
              <span className="label-text text-sm font-bold">API URL</span>
            </label>
            <input
              id="bulk-voter-api-url"
              type="text"
              className="input input-bordered w-full"
              placeholder="https://identity.example.gov.lk/voters"
              value={apiUrl}
              onChange={event => setApiUrl(event.target.value)}
              disabled={busy}
            />
          </div>
          <div className="form-control">
            <label className="label" htmlFor="bulk-voter-api-key">
              <span className="label-text text-sm font-bold">API key (optional)</span>
            </label>
            <input
              id="bulk-voter-api-key"
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
        {busy ? "Importing…" : "Send invites"}
      </button>

      {results && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm opacity-70">
              {results.filter(result => result.status === "sent").length} sent,{" "}
              {results.filter(result => result.error).length} failed.
            </p>
            <button type="button" className="btn btn-xs" onClick={handleClear}>
              Clear
            </button>
          </div>
          {results.some(result => result.devLink) && (
            <div className="alert alert-warning text-xs" role="alert">
              <span>
                No SMS gateway is configured, so nothing was actually texted — this is the mock provider (see{" "}
                <code>services/sms/smsService.ts</code>). Use <strong>Get link</strong> below to grab the claim link
                each invite would have sent, and deliver it yourself (WhatsApp, AirDrop, etc.) for testing.
                {results.some(result => result.testLink) ? (
                  <>
                    {" "}
                    The <strong>Link</strong> column&apos;s <code>slvote://</code> link only opens on a phone that has
                    been through a real app build — inside plain Expo Go it isn&apos;t a registered URL scheme, so it
                    won&apos;t open. Use <strong>Test Link</strong> instead there: it&apos;s the same claim as an{" "}
                    <code>exp://</code> link Expo Go can open directly.
                  </>
                ) : (
                  <>
                    {" "}
                    Testing in Expo Go? It won&apos;t open <code>slvote://</code> links directly — set{" "}
                    <code>EXPO_DEV_SERVER_URL</code> in <code>.env.local</code> to also get a Test Link it can open.
                  </>
                )}
              </span>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>NIC</th>
                  <th>Division</th>
                  <th>Status</th>
                  <th>Link</th>
                  <th>Test Link</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {results.map(result => (
                  <tr key={result.row}>
                    <td>{result.row}</td>
                    <td className="font-mono text-xs">{result.nic}</td>
                    <td>{result.divisionName}</td>
                    <td>{result.status === "sent" && <span className="badge badge-success badge-xs">Sent</span>}</td>
                    <td className="max-w-xs">{renderLinkCell(result.row, "link", result.devLink, "Get link")}</td>
                    <td className="max-w-xs">{renderLinkCell(result.row, "test", result.testLink, "Get test link")}</td>
                    <td className="text-error text-xs">{result.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Section>
  );
};
