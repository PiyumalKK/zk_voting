import { NextRequest, NextResponse } from "next/server";
import { getAccountStore } from "~~/services/auth/accounts";
import { burnPasswordComparison, safeEquals, verifyPassword } from "~~/services/auth/crypto";
import { clientIpFrom, sharedLoginGuard, sharedRateLimiter } from "~~/services/auth/rateLimit";
import { tryGetServerSession } from "~~/services/auth/serverSession";
import { isCustomChainMode } from "~~/services/auth/session";
import type { AuthRole } from "~~/services/auth/session";

/**
 * `POST /api/auth/login` — credential login for admin and GN officers.
 *
 * Custom-chain mode only. In hardhat mode operators authenticate by holding a
 * wallet, and this endpoint reports 404 so a stray deployment cannot be probed
 * for credentials that were never configured.
 *
 * Two independent throttles, per `01-AUTH-DESIGN.md` §6:
 * - 5 attempts/minute per IP, which blunts scripted spraying across accounts;
 * - lockout for 15 minutes after 5 consecutive failures on one username, which
 *   is what actually protects a specific officer's credentials.
 */

const RATE_LIMIT = { limit: 5, windowMs: 60_000 };
const LOCKOUT = { maxFailures: 5, lockoutMs: 15 * 60_000 };

const loginRateLimiter = () => sharedRateLimiter("auth:login", RATE_LIMIT);
const loginGuard = () => sharedLoginGuard("auth:login", LOCKOUT);

/** One message for every credential failure — it must not reveal which half was wrong. */
const INVALID_CREDENTIALS = "Incorrect username or password.";

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

export async function POST(req: NextRequest) {
  if (!isCustomChainMode()) {
    return NextResponse.json({ error: "Credential login is only available in custom-chain mode." }, { status: 404 });
  }

  const ip = clientIpFrom(req.headers);
  const ipDecision = loginRateLimiter().consume(ip);
  if (!ipDecision.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Wait a minute and try again." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(ipDecision.retryAfterMs / 1000)) } },
    );
  }

  let body: { username?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required." }, { status: 400 });
  }

  const guard = loginGuard();
  const lock = guard.status(username);
  if (lock.locked) {
    return NextResponse.json(
      { error: `Account locked after repeated failures. Try again in ${minutes(lock.retryAfterMs)} minute(s).` },
      { status: 429, headers: { "Retry-After": String(Math.ceil(lock.retryAfterMs / 1000)) } },
    );
  }

  const fail = () => {
    const status = guard.recordFailure(username);
    if (status.locked) {
      return NextResponse.json(
        { error: `Account locked for ${minutes(status.retryAfterMs)} minutes after repeated failures.` },
        { status: 429 },
      );
    }
    return NextResponse.json({ error: INVALID_CREDENTIALS }, { status: 401 });
  };

  let role: AuthRole;
  let divisionId: number | undefined;
  // Admins are never gated: their credential lives in `ADMIN_PASSWORD_HASH`, so
  // there is no second party who was handed it by this application and nothing
  // this endpoint could rotate. Changing it means editing the environment and
  // restarting, which is the deployment's business, not the app's.
  let mustChangePassword = false;

  const adminUsername = process.env.ADMIN_USERNAME?.trim().toLowerCase();
  const adminHash = process.env.ADMIN_PASSWORD_HASH?.trim();

  if (adminUsername && safeEquals(username, adminUsername)) {
    if (!adminHash) {
      console.error("[auth] ADMIN_USERNAME is set but ADMIN_PASSWORD_HASH is not — admin login cannot succeed.");
      return NextResponse.json({ error: "Admin login is not configured on this server." }, { status: 503 });
    }
    if (!(await verifyPassword(password, adminHash))) return fail();
    role = "admin";
  } else {
    let account;
    try {
      account = await getAccountStore().findByUsername(username);
    } catch (error) {
      console.error("[auth] GN account store unavailable", error);
      return NextResponse.json({ error: "Account store is unavailable." }, { status: 503 });
    }
    if (!account || account.disabled) {
      // Spend the same time a real verification would, so a missing account is
      // not distinguishable from a wrong password by response latency.
      await burnPasswordComparison();
      return fail();
    }
    if (!(await verifyPassword(password, account.passwordHash))) return fail();
    role = "gn";
    divisionId = account.divisionId;
    mustChangePassword = account.mustChangePassword;
  }

  guard.recordSuccess(username);
  loginRateLimiter().reset(ip);

  const loaded = await tryGetServerSession();
  if (!loaded.ok) return loaded.response;
  const { session } = loaded;

  session.username = username;
  session.role = role;
  session.divisionId = divisionId;
  session.mustChangePassword = mustChangePassword;
  session.loggedInAt = Date.now();
  await session.save();

  // A gated session is still a successful sign-in — the credential was correct.
  // The client uses the flag to route to `/change-password` rather than the
  // portal; the server enforces it regardless of where the client goes.
  return NextResponse.json({ username, role, divisionId, mustChangePassword });
}
