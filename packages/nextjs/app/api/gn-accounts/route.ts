import { NextRequest, NextResponse } from "next/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AccountStoreError, getAccountStore, isValidUsername, normaliseUsername } from "~~/services/auth/accounts";
import { generatePassword } from "~~/services/auth/crypto";
import { loadDivisions } from "~~/services/auth/relayContracts";
import { executeRelayCall } from "~~/services/auth/relayExecutor";
import { requireSession } from "~~/services/auth/serverSession";
import { isCustomChainMode } from "~~/services/auth/session";

/**
 * `/api/gn-accounts` — admin-only management of GN officer accounts.
 *
 * Creating an account is the moment a new signing key comes into existence, so
 * it happens entirely server-side: the key is generated here, sealed by the
 * account store, and never leaves the process. The admin sees the derived
 * address and a one-time password — nothing that can sign.
 *
 * Creation also assigns the officer on-chain via `setGNOfficer`, through the
 * same relay path an admin would use by hand. Doing it in one step avoids the
 * failure mode where an account exists in the store but has no on-chain
 * authority, which surfaces later as a confusing revert during voter
 * enrolment.
 */

const customModeOnly = () =>
  NextResponse.json({ error: "GN accounts exist only in custom-chain mode." }, { status: 404 });

export async function GET() {
  if (!isCustomChainMode()) return customModeOnly();
  const auth = await requireSession("admin");
  if (!auth.ok) return auth.response;

  try {
    return NextResponse.json({ accounts: await getAccountStore().list() });
  } catch (error) {
    console.error("[gn-accounts] list failed", error);
    return NextResponse.json({ error: "Account store is unavailable." }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  if (!isCustomChainMode()) return customModeOnly();
  const auth = await requireSession("admin");
  if (!auth.ok) return auth.response;

  let body: { username?: unknown; divisionId?: unknown; assign?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const username = typeof body.username === "string" ? normaliseUsername(body.username) : "";
  if (!isValidUsername(username)) {
    return NextResponse.json(
      { error: "Username must be 3–32 characters: letters, digits, dot, underscore or hyphen." },
      { status: 400 },
    );
  }
  const divisionId = Number(body.divisionId);
  if (!Number.isInteger(divisionId) || divisionId < 0) {
    return NextResponse.json({ error: "divisionId must be a non-negative integer." }, { status: 400 });
  }
  const assign = body.assign !== false;

  let divisions;
  try {
    divisions = await loadDivisions();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Cannot reach the election chain." },
      { status: 503 },
    );
  }
  const division = divisions.find(candidate => candidate.id === divisionId);
  if (!division) {
    return NextResponse.json({ error: `No division with id ${divisionId}.` }, { status: 400 });
  }

  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  const password = generatePassword();

  try {
    await getAccountStore().create({ username, password, divisionId, address, privateKey });
  } catch (error) {
    if (error instanceof AccountStoreError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[gn-accounts] create failed", error);
    return NextResponse.json({ error: "Could not save the new account." }, { status: 503 });
  }

  let assigned = false;
  let assignError: string | undefined;
  if (assign) {
    const outcome = await executeRelayCall({
      session: auth.data,
      request: { target: division.votingContract, fn: "setGNOfficer", args: [address] },
    });
    assigned = outcome.ok;
    // The account is kept even if assignment fails: the credentials have
    // already been generated, and the admin can retry `setGNOfficer` from the
    // GN Officer Management panel rather than starting over.
    if (!outcome.ok) assignError = outcome.errorName ?? outcome.error;
  }

  return NextResponse.json({
    username,
    // Shown once. Not stored anywhere in plaintext — only its bcrypt hash is.
    password,
    address,
    divisionId,
    divisionName: division.name,
    assigned,
    assignError,
  });
}

/**
 * Suspends or restores an officer without destroying their key.
 *
 * The `disabled` flag is checked at login and again by the relay before
 * signing, so this is the fast way to take a compromised or absent officer out
 * of service mid-election. Unlike DELETE it is reversible, and it keeps the
 * account's address — which is still the on-chain `gnOfficer` — on record.
 */
export async function PATCH(req: NextRequest) {
  if (!isCustomChainMode()) return customModeOnly();
  const auth = await requireSession("admin");
  if (!auth.ok) return auth.response;

  let body: { username?: unknown; disabled?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const username = typeof body.username === "string" ? normaliseUsername(body.username) : "";
  if (!username) return NextResponse.json({ error: "`username` is required." }, { status: 400 });
  if (typeof body.disabled !== "boolean") {
    return NextResponse.json({ error: "`disabled` must be true or false." }, { status: 400 });
  }

  try {
    return NextResponse.json({ account: await getAccountStore().setDisabled(username, body.disabled) });
  } catch (error) {
    if (error instanceof AccountStoreError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error("[gn-accounts] patch failed", error);
    return NextResponse.json({ error: "Could not update the account." }, { status: 503 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!isCustomChainMode()) return customModeOnly();
  const auth = await requireSession("admin");
  if (!auth.ok) return auth.response;

  const username = normaliseUsername(req.nextUrl.searchParams.get("username") ?? "");
  if (!username) return NextResponse.json({ error: "`username` is required." }, { status: 400 });

  try {
    await getAccountStore().remove(username);
  } catch (error) {
    if (error instanceof AccountStoreError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error("[gn-accounts] delete failed", error);
    return NextResponse.json({ error: "Could not delete the account." }, { status: 503 });
  }

  // Deliberately does not clear the officer on-chain: `setGNOfficer(0x0)` is a
  // separate, deliberate act, and revoking the credentials already removes this
  // server's ability to sign as that officer.
  return NextResponse.json({ ok: true, username });
}
