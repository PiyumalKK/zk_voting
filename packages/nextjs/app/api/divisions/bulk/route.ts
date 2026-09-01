import { NextRequest, NextResponse } from "next/server";
import { loadDivisions } from "~~/services/auth/relayContracts";
import { requireSession } from "~~/services/auth/serverSession";
import { isCustomChainMode } from "~~/services/auth/session";
import { RowSourceError, buildRowSource } from "~~/services/bulkImport/rowSource";
import type { BulkImportSourceInput, ImportRow } from "~~/services/bulkImport/rowSource";
import { streamRowResults } from "~~/services/bulkImport/streamRows";
import {
  CreateDivisionError,
  createDivisionOnChain,
  normaliseDivisionName,
} from "~~/services/divisions/divisionCreation";

/**
 * `POST /api/divisions/bulk` — admin-only bulk creation of polling divisions,
 * from either an uploaded CSV or a pull from an external identity-management
 * API (`services/bulkImport/rowSource.ts`) — the batch counterpart of the
 * manual "Add Division" form (`AddDivisionSection`).
 *
 * Expected row shape: `{ name }` (a `division`/`division name` header also
 * works, matching what a GN-officer import CSV already calls the column).
 *
 * Custom-chain mode only: creation goes through the server relay
 * (`createDivisionOnChain`), which needs the admin's server-held signing key.
 * Hardhat mode has no such key — its single-division form keeps using
 * MetaMask via `useElectionWriter`, unchanged.
 *
 * Rows are processed one at a time, same reasoning as `POST
 * /api/gn-accounts/bulk`: each row ends in `executeRelayCall`, which signs
 * with the single admin relay key and awaits the receipt, so concurrent rows
 * would race that key's nonce. One bad row does not fail the batch.
 */

interface RowResult {
  row: number;
  name?: string;
  votingContract?: string;
  authorised?: boolean;
  error?: string;
}

const rowName = (row: ImportRow): string => row.name ?? row.division ?? row["division name"] ?? "";

export async function POST(req: NextRequest) {
  if (!isCustomChainMode()) {
    return NextResponse.json(
      { error: "Bulk division import is only available in custom-chain mode; use the manual form instead." },
      { status: 404 },
    );
  }
  const auth = await requireSession("admin");
  if (!auth.ok) return auth.response;

  let body: BulkImportSourceInput;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let rows: ImportRow[];
  try {
    rows = await buildRowSource(body).fetchRows();
  } catch (error) {
    if (error instanceof RowSourceError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Could not read the import source." }, { status: 502 });
  }
  if (rows.length === 0) {
    return NextResponse.json({ error: "The import source contained no rows." }, { status: 400 });
  }

  // Case-insensitive, trimmed — same rule `normaliseDivisionName` applies
  // client-side in `AddDivisionSection`. Grown as rows succeed below, so a
  // CSV that repeats a name (or duplicates one it just created) is caught
  // without a fresh on-chain read per row.
  let divisions;
  try {
    divisions = await loadDivisions();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Cannot reach the election chain." },
      { status: 503 },
    );
  }
  const existingNames = new Set(divisions.map(division => normaliseDivisionName(division.name)));

  return streamRowResults<RowResult>(rows.length, async send => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2; // header is row 1, so the first data row is row 2 — matches what a spreadsheet shows
      const name = rowName(row);

      try {
        const created = await createDivisionOnChain(name, auth.data, existingNames);
        existingNames.add(normaliseDivisionName(created.name));
        send({
          row: rowNumber,
          name: created.name,
          votingContract: created.votingContract,
          authorised: created.authorised,
          error: created.assignError && `Created, but ${created.assignError}`,
        });
      } catch (error) {
        send({
          row: rowNumber,
          name: name || undefined,
          error: error instanceof CreateDivisionError ? error.message : "Could not create this division.",
        });
      }
    }
  });
}
