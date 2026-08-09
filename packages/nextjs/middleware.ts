import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import {
  CHANGE_PASSWORD_PATH,
  getSessionOptions,
  isCustomChainMode,
  isPathAllowedForRole,
  isPathAllowedWhilePasswordPending,
} from "~~/services/auth/session";
import type { SessionData } from "~~/services/auth/session";
import { homePathForRole } from "~~/utils/chainMode";

/**
 * Route gating for no-wallet auth (M12).
 *
 * **Inert in hardhat mode.** The very first check returns `next()` when the app
 * is pointed at Hardhat, so the MetaMask flow behaves exactly as it did before
 * M12 — the locked decision in MASTER §1 and the regression rule in §6.4.
 *
 * Runs in the Edge runtime, so it may only import `services/auth/session.ts`
 * (types, cookie options, the path table). Anything reaching for `node:crypto`,
 * `node:fs` or bcrypt belongs in a route handler.
 *
 * This layer is convenience, not the security boundary: it produces friendly
 * redirects instead of raw 401s. `/api/relay` and `/api/gn-accounts` re-check
 * the session and the role themselves.
 */

/** API prefixes answer with JSON; everything else is a page and gets a redirect. */
const isApiPath = (pathname: string) => pathname.startsWith("/api/");

export async function middleware(req: NextRequest) {
  if (!isCustomChainMode()) return NextResponse.next();

  const { pathname, search } = req.nextUrl;
  const response = NextResponse.next();

  let session: SessionData | undefined;
  try {
    session = await getIronSession<SessionData>(req, response, getSessionOptions());
  } catch (error) {
    // A missing or too-short SESSION_SECRET must not silently unlock the admin
    // pages: fail closed and say what is wrong in the server log.
    console.error("[middleware] session configuration error", error);
    return isApiPath(pathname)
      ? NextResponse.json({ error: "Authentication is not configured on this server." }, { status: 503 })
      : NextResponse.redirect(new URL("/login?error=config", req.url));
  }

  if (!session?.username || !session?.role) {
    if (isApiPath(pathname)) {
      return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.url);
    // Preserve where they were headed so login can send them back.
    loginUrl.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  // An officer still on the password their admin generated goes nowhere but the
  // change-password page. This is the friendly half of the rule: `requireSession()`
  // refuses the same requests with a 403 regardless of whether they arrived
  // through a browser, so bypassing this redirect gains nothing.
  if (session.mustChangePassword && !isPathAllowedWhilePasswordPending(pathname)) {
    if (isApiPath(pathname)) {
      return NextResponse.json(
        { error: "Set your own password before continuing.", code: "password_change_required" },
        { status: 403 },
      );
    }
    return NextResponse.redirect(new URL(CHANGE_PASSWORD_PATH, req.url));
  }

  // GN officers may return to the page voluntarily to rotate a password later —
  // that is a feature, not a leak. Admins cannot: theirs lives in the server
  // environment, so the page would only offer them a form that always fails.
  if (pathname === CHANGE_PASSWORD_PATH && session.role === "admin") {
    return NextResponse.redirect(new URL(homePathForRole(session.role), req.url));
  }

  if (!isPathAllowedForRole(pathname, session.role)) {
    if (isApiPath(pathname)) {
      return NextResponse.json({ error: "Your account may not perform this action." }, { status: 403 });
    }
    // Send each role somewhere it is actually allowed to be, rather than
    // bouncing an authenticated user to a login page they have already passed.
    // Same table the login page redirects with, so the two cannot disagree.
    return NextResponse.redirect(new URL(homePathForRole(session.role), req.url));
  }

  return response;
}

export const config = {
  matcher: [
    "/voting/admin/:path*",
    "/gn/:path*",
    "/api/relay/:path*",
    "/api/gn-accounts/:path*",
    // Matched so an unauthenticated visitor is bounced to /login rather than
    // shown a password form with no session behind it.
    "/change-password",
  ],
};
