import { NextRequest, NextResponse } from "next/server";
import { CreateOfficerError, createGnOfficerAccount } from "~~/services/auth/gnAccountCreation";
import { loadDivisions } from "~~/services/auth/relayContracts";
import { requireSession } from "~~/services/auth/serverSession";
import { isCustomChainMode } from "~~/services/auth/session";
import { RowSourceError, buildRowSource } from "~~/services/bulkImport/rowSource";
import type { BulkImportSourceInput, ImportRow } from "~~/services/bulkImport/rowSource";
import { streamRowResults } from "~~/services/bulkImport/streamRows";

/**
 * `POST /api/gn-accounts/bulk` — admin-only bulk creation of GN officer
 * accounts, from either an uploaded CSV or a pull from an external
 * identity-management API (`services/bulkImport/rowSource.ts`).
 *
 * Expected row shape: `{ username, division }` — `division` is matched by
 * **name** (case-insensitive) against the live registry, since that is what
 * both a CSV and an identity-management export would naturally carry, not an
 * internal numeric id.
 *
 * Rows are processed strictly one at a time: `createGnOfficerAccount` ends in
 * `executeRelayCall`, which signs with the single admin relay key and waits
 * for the transaction receipt before returning. Running rows concurrently
 * would race that key's nonce; awaiting each row in turn avoids it for free
 * and costs nothing meaningful at the scale this endpoint serves (a
 * division's worth of officers, not thousands).
 *
 * One bad row does not fail the batch — a 40-row import shouldn't lose 39
 * good accounts because row 12 has a typo'd division name.
 */

interface RowResult {
  row: number;
  username?: string;
  divisionName?: string;
  password?: string;
  address?: string;
  assigned?: boolean;
  error?: string;
}

const rowUsername = (row: ImportRow): string => row.username ?? row["gn username"] ?? "";
const rowDivisionName = (row: ImportRow): string => row.division ?? row["division name"] ?? "";

export async function POST(req: NextRequest) {
  if (!isCustomChainMode()) {
    return NextResponse.json({ error: "GN accounts exist only in custom-chain mode." }, { status: 404 });
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

  let divisions;
  try {
    divisions = await loadDivisions();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Cannot reach the election chain." },
      { status: 503 },
    );
  }

  return streamRowResults<RowResult>(rows.length, async send => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2; // header is row 1, so the first data row is row 2 — matches what a spreadsheet shows
      const username = rowUsername(row);
      const divisionName = rowDivisionName(row);

      if (!divisionName) {
        send({ row: rowNumber, username, error: "Missing `division` column." });
        continue;
      }
      const division = divisions.find(candidate => candidate.name.toLowerCase() === divisionName.trim().toLowerCase());
      if (!division) {
        send({ row: rowNumber, username, divisionName, error: `No division named "${divisionName}".` });
        continue;
      }

      try {
        const created = await createGnOfficerAccount({ username, divisionId: division.id }, auth.data, divisions);
        send({
          row: rowNumber,
          username: created.username,
          divisionName: created.divisionName,
          password: created.password,
          address: created.address,
          assigned: created.assigned,
          error: created.assignError && `Created, but on-chain assignment failed: ${created.assignError}`,
        });
      } catch (error) {
        send({
          row: rowNumber,
          username,
          divisionName,
          error: error instanceof CreateOfficerError ? error.message : "Could not create this account.",
        });
      }
    }
  });
}
