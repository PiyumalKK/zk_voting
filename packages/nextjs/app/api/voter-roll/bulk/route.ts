import { NextRequest, NextResponse } from "next/server";
import { loadDivisions } from "~~/services/auth/relayContracts";
import { requireSession } from "~~/services/auth/serverSession";
import { isCustomChainMode } from "~~/services/auth/session";
import { RowSourceError, buildRowSource } from "~~/services/bulkImport/rowSource";
import type { BulkImportSourceInput, ImportRow } from "~~/services/bulkImport/rowSource";
import { canonicalizeNic, hashNic } from "~~/services/nic/nicHash";
import { normalisePhone } from "~~/services/otp/otpService";
import { isMockSmsProvider, sendSms } from "~~/services/sms/smsService";
import { EnrolmentInviteStoreError, getEnrolmentInviteStore } from "~~/services/voters/enrolmentInvites";
import { signEnrolmentToken } from "~~/services/voters/enrolmentToken";

/**
 * `POST /api/voter-roll/bulk` — admin-only bulk import of voter eligibility,
 * from either a CSV upload or a pull from an external identity-management
 * API (`services/bulkImport/rowSource.ts`).
 *
 * This does **not** create voter accounts — it can't: a voter's signing key
 * exists only on their own phone (`packages/mobile/src/services/keystore.ts`),
 * generated the moment they open the app, never sent anywhere. What this
 * *does* create is a pending "you're eligible, come claim it" invite per row,
 * delivered by SMS as a link the citizen's own device opens
 * (`packages/mobile/app/claim/[token].tsx`) to finish what a GN officer would
 * otherwise do by hand.
 *
 * Expected row shape: `{ nic, phone, division }`.
 */

const CLAIM_BASE_URL = process.env.ENROLMENT_CLAIM_BASE_URL?.trim() || "slvote://claim/";

/**
 * Dev-server address for the Expo Go-openable "Test Link" (see
 * `.env.example`). `slvote://…` is only a registered URL scheme once the app
 * has been through a real build; inside plain Expo Go only `exp://` opens
 * anything, so testing there needs this alternate link instead of the real
 * claim link.
 */
const EXPO_DEV_SERVER_URL = process.env.EXPO_DEV_SERVER_URL?.trim();

const buildExpoGoTestLink = (token: string): string | undefined => {
  if (!EXPO_DEV_SERVER_URL) return undefined;
  const authority = EXPO_DEV_SERVER_URL.includes(":") ? EXPO_DEV_SERVER_URL : `${EXPO_DEV_SERVER_URL}:8081`;
  return `exp://${authority}/--/claim/${token}`;
};

interface RowResult {
  row: number;
  nic?: string;
  divisionName?: string;
  status?: "sent";
  error?: string;
  /**
   * The raw claim link, echoed back only while the SMS provider is the
   * dev-only mock (`services/sms/smsService.ts`) — the same gate
   * `services/otp/otpService.ts` already applies to `devCode`. There is no
   * real SMS gateway wired into this prototype, so without this the link is
   * unreachable outside a server console; once a real provider is ever
   * configured, this field disappears from the response automatically and
   * the link goes out exclusively over SMS, as intended.
   */
  devLink?: string;
  /**
   * The same claim, as an `exp://` link Expo Go can open directly — only
   * present alongside `devLink` (same mock-provider gate) and only when
   * `EXPO_DEV_SERVER_URL` is configured. `devLink`'s `slvote://` scheme is
   * unusable inside Expo Go until the app has gone through a real build.
   */
  testLink?: string;
}

const rowNic = (row: ImportRow): string => row.nic ?? row["nic number"] ?? "";
const rowPhone = (row: ImportRow): string => row.phone ?? row["phone number"] ?? row.mobile ?? "";
const rowDivisionName = (row: ImportRow): string => row.division ?? row["division name"] ?? "";

export async function POST(req: NextRequest) {
  if (!isCustomChainMode()) {
    return NextResponse.json({ error: "Voter roll import exists only in custom-chain mode." }, { status: 404 });
  }
  const auth = await requireSession("admin");
  if (!auth.ok) return auth.response;

  const pepper = process.env.SERVER_PEPPER;
  if (!pepper) {
    return NextResponse.json({ error: "NIC hashing service is not configured (SERVER_PEPPER)." }, { status: 503 });
  }

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

  const store = getEnrolmentInviteStore();
  const results: RowResult[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 2;
    const rawNic = rowNic(row);
    const rawPhone = rowPhone(row);
    const divisionName = rowDivisionName(row);

    const canonicalNic = canonicalizeNic(rawNic);
    if (!canonicalNic) {
      results.push({ row: rowNumber, nic: rawNic, error: "Invalid NIC format." });
      continue;
    }
    const phone = normalisePhone(rawPhone);
    if (!phone) {
      results.push({ row: rowNumber, nic: rawNic, error: "Invalid Sri Lankan phone number." });
      continue;
    }
    const division = divisions.find(candidate => candidate.name.toLowerCase() === divisionName.trim().toLowerCase());
    if (!division) {
      results.push({ row: rowNumber, nic: rawNic, error: `No division named "${divisionName}".` });
      continue;
    }

    const nicHash = hashNic(canonicalNic, pepper);
    try {
      await store.upsertPending({ nicHash, phone, divisionId: division.id });
      const token = signEnrolmentToken(nicHash, division.id);
      const link = `${CLAIM_BASE_URL}${token}`;
      await sendSms(
        phone,
        `SL Vote: you're eligible to register in ${division.name}. Open this link on your phone to finish: ${link}`,
      );
      results.push({
        row: rowNumber,
        nic: rawNic,
        divisionName: division.name,
        status: "sent",
        devLink: isMockSmsProvider ? link : undefined,
        testLink: isMockSmsProvider ? buildExpoGoTestLink(token) : undefined,
      });
    } catch (error) {
      results.push({
        row: rowNumber,
        nic: rawNic,
        divisionName: division.name,
        error: error instanceof EnrolmentInviteStoreError ? error.message : "Could not send this invite.",
      });
    }
  }

  const succeeded = results.filter(result => result.status === "sent").length;
  return NextResponse.json({ results, succeeded, failed: results.length - succeeded });
}
