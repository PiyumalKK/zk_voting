import { NextRequest, NextResponse } from "next/server";
import { AccountStoreError, getAccountStore } from "~~/services/auth/accounts";
import { appendAuditEntry } from "~~/services/auth/auditLog";
import { verifyPassword } from "~~/services/auth/crypto";
import { passwordProblem } from "~~/services/auth/passwordPolicy";
import { clientIpFrom, sharedRateLimiter } from "~~/services/auth/rateLimit";
import { requireSession } from "~~/services/auth/serverSession";
import { isCustomChainMode } from "~~/services/auth/session";

/**
 * `POST /api/auth/password` — a GN officer replaces their own password.
 *
 * This is the one route that may run while `session.mustChangePassword` is set,
 * because it is the action that clears it. Everything else — the relay, the NIC
 * hasher, the account admin API — is refused by `requireSession()` until an
 * officer has been through here.
 *
 * The point is custody, not secrecy. The password an admin generates at account
 * creation is known to two people the moment it is read off the screen, which
 * makes the relay audit log's `username` field ambiguous: any `addVoters` call
 * signed in that window could have come from either of them. After this route
 * runs, it could only have come from the officer.
 */

/**
 * 10 attempts per 15 minutes per IP.
 *
 * Looser than login's 5/minute because a signed-in officer mistyping their new
 * password twice is ordinary, and tighter than nothing because `currentPassword`
 * is verified here — without a limit this endpoint would be a bcrypt oracle for
 * anyone holding a stolen session cookie.
 */
const RATE_LIMIT = { limit: 10, windowMs: 15 * 60_000 };

const passwordRateLimiter = () => sharedRateLimiter("auth:password", RATE_LIMIT);

export async function POST(req: NextRequest) {
  if (!isCustomChainMode()) {
    return NextResponse.json({ error: "Credential login is only available in custom-chain mode." }, { status: 404 });
  }

  const auth = await requireSession(undefined, { allowPasswordChangePending: true });
  if (!auth.ok) return auth.response;
  const { session } = auth;

  // Admin credentials come from `ADMIN_PASSWORD_HASH` in the environment; there
  // is no stored record to rewrite, and silently succeeding would be worse than
  // saying so. Checked before the rate limiter so a misdirected admin does not
  // consume an officer's budget on a shared IP.
  if (session.role === "admin") {
    return NextResponse.json(
      {
        error:
          "The admin password is set by ADMIN_PASSWORD_HASH in the server environment. " +
          "Generate a new bcrypt hash, update the variable and restart to change it.",
      },
      { status: 400 },
    );
  }

  const ip = clientIpFrom(req.headers);
  const decision = passwordRateLimiter().consume(ip);
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Too many password-change attempts. Wait a few minutes and try again." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(decision.retryAfterMs / 1000)) } },
    );
  }

  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!currentPassword) return NextResponse.json({ error: "Enter your current password." }, { status: 400 });

  // Validated before the store is touched, so an unusable new password costs no
  // bcrypt work and reports the real problem rather than a generic failure.
  const problem = passwordProblem(newPassword);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const username = session.username;
  const audit = {
    ts: new Date().toISOString(),
    role: session.role ?? "gn",
    username: username ?? "unknown",
    target: "auth",
    fn: "changePassword",
    args: [] as string[],
  };

  const store = getAccountStore();
  let account;
  try {
    account = await store.findByUsername(username ?? "");
  } catch (error) {
    console.error("[auth] account store unavailable during password change", error);
    return NextResponse.json({ error: "Account store is unavailable." }, { status: 503 });
  }

  // A session for an account that has since been deleted or suspended must not
  // be able to write to the store.
  if (!account || account.disabled) {
    await appendAuditEntry({ ...audit, status: "rejected: no such account" });
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  if (!(await verifyPassword(currentPassword, account.passwordHash))) {
    await appendAuditEntry({ ...audit, status: "rejected: wrong current password" });
    return NextResponse.json({ error: "Your current password is incorrect." }, { status: 401 });
  }

  try {
    await store.changePassword(account.username, newPassword);
  } catch (error) {
    if (error instanceof AccountStoreError) {
      await appendAuditEntry({ ...audit, status: `rejected: ${error.message}` });
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[auth] password change failed", error);
    return NextResponse.json({ error: "Could not save the new password." }, { status: 503 });
  }

  session.mustChangePassword = false;
  await session.save();
  // The officer proved they hold the current password; a later mistyped change
  // should not find the budget already spent by their own successful one.
  passwordRateLimiter().reset(ip);

  // Logged because it is the moment custody transfers: every audit line after
  // this one names a password only the officer has ever seen.
  await appendAuditEntry({ ...audit, status: "success" });

  return NextResponse.json({ ok: true, username: account.username });
}
