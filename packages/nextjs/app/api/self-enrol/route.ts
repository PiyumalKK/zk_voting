import { NextRequest, NextResponse } from "next/server";
import { loadDivisions } from "~~/services/auth/relayContracts";
import { isCustomChainMode } from "~~/services/auth/session";
import { getEnrolmentInviteStore } from "~~/services/voters/enrolmentInvites";
import { verifyEnrolmentToken } from "~~/services/voters/enrolmentToken";
import { executeSelfEnrol } from "~~/services/voters/selfEnrolRelay";

/**
 * `POST /api/self-enrol` — completes a bulk-imported voter's enrolment from
 * their own device, using the SMS claim link's token instead of a GN
 * session. **No `requireSession()` call here on purpose**: the token itself,
 * verified below and checked against `EnrolmentInviteStore`, is the entire
 * authorization — exactly the same trust boundary `/api/otp/verify` and
 * `/api/nic/hash`'s hardhat-mode branch already draw for a non-session
 * caller.
 *
 * Body: `{ token, address }`. `address` is the voting address the caller's
 * phone generated locally (`packages/mobile/src/services/keystore.ts`) — it
 * never touches this server as anything but a public address to allowlist.
 */
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export async function POST(req: NextRequest) {
  if (!isCustomChainMode()) {
    return NextResponse.json({ error: "Self-enrolment exists only in custom-chain mode." }, { status: 404 });
  }

  let body: { token?: unknown; address?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : "";
  const address = typeof body.address === "string" ? body.address : "";
  if (!token) return NextResponse.json({ error: "`token` is required." }, { status: 400 });
  if (!ADDRESS_PATTERN.test(address)) {
    return NextResponse.json({ error: "`address` must be a 20-byte hex address." }, { status: 400 });
  }

  const claim = verifyEnrolmentToken(token);
  if (!claim) {
    return NextResponse.json({ error: "This link is invalid or has expired." }, { status: 401 });
  }

  const store = getEnrolmentInviteStore();
  const invite = await store.findByNicHash(claim.nicHash);
  if (!invite || invite.divisionId !== claim.divisionId) {
    return NextResponse.json({ error: "This link is invalid or has expired." }, { status: 401 });
  }
  if (invite.status === "claimed") {
    return NextResponse.json({ error: "This link has already been used." }, { status: 409 });
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
  const division = divisions.find(candidate => candidate.id === invite.divisionId);
  if (!division) {
    return NextResponse.json({ error: "Your division no longer exists on the registry." }, { status: 410 });
  }

  const outcome = await executeSelfEnrol({
    nicHash: claim.nicHash as `0x${string}`,
    device: address as `0x${string}`,
    division,
  });
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error, errorName: outcome.errorName }, { status: outcome.status });
  }

  try {
    await store.claim(claim.nicHash);
  } catch (error) {
    // The on-chain writes already landed — the voter IS enrolled. A failure to
    // flip the local "claimed" flag must not be reported as an enrolment
    // failure; at worst a re-opened link fails later at `reserveNicHash`
    // itself (NicRegistry__AlreadyRegistered), which is a safe failure mode.
    console.error("[self-enrol] enrolled on-chain but could not mark the invite claimed", error);
  }

  return NextResponse.json({ ok: true, divisionName: division.name });
}
