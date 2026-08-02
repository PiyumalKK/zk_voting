import type { SessionOptions } from "iron-session";
import { isCustomMode } from "~~/utils/chainMode";

/**
 * Session shape and cookie policy for no-wallet auth (M12).
 *
 * **Edge-safe by construction.** `middleware.ts` runs in the Edge runtime and
 * imports this module, so nothing here may reach for `node:crypto`, `node:fs`,
 * bcrypt, or viem. Keep those in `crypto.ts` / `accounts.ts`, which only route
 * handlers (Node runtime) import.
 */

export type AuthRole = "admin" | "gn";

export interface SessionData {
  /** Login name. Admin's comes from `ADMIN_USERNAME`; GN's from the account store. */
  username: string;
  role: AuthRole;
  /**
   * Division index this GN officer is scoped to, as returned by
   * `ElectionRegistry.getAllDivisions()`. Undefined for admins.
   *
   * The relay re-resolves the division's contract address from the registry on
   * every call and never trusts a client-supplied target — this id is the only
   * division input, and it comes from the signed cookie.
   */
  divisionId?: number;
  /** Epoch ms, for display and for the audit log. */
  loggedInAt: number;
}

/** 8 hours — `01-AUTH-DESIGN.md` §2. An election shift, not a persistent login. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export const SESSION_COOKIE_NAME = "sl_vote_session";

/** iron-session refuses passwords shorter than this, and so do we — earlier and louder. */
export const MIN_SESSION_SECRET_LENGTH = 32;

export class SessionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionConfigError";
  }
}

/**
 * Builds iron-session options from an explicit secret. Pure — unit tested.
 *
 * `sameSite: "strict"` is what makes the relay safe without CSRF tokens: a
 * cross-site form post cannot attach this cookie, so no third-party page can
 * make the server sign a transaction on an operator's behalf.
 */
export const buildSessionOptions = (secret: string | undefined, isProduction = false): SessionOptions => {
  const password = secret?.trim() ?? "";
  if (password.length < MIN_SESSION_SECRET_LENGTH) {
    throw new SessionConfigError(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters; got ${password.length}. ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }
  return {
    password,
    cookieName: SESSION_COOKIE_NAME,
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      sameSite: "strict",
      // Only over TLS in production. Left off in dev so http://localhost works.
      secure: isProduction,
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    },
  };
};

/** The configured options for this process. Throws if `SESSION_SECRET` is unusable. */
export const getSessionOptions = (): SessionOptions =>
  buildSessionOptions(process.env.SESSION_SECRET, process.env.NODE_ENV === "production");

/**
 * Whether this deployment runs against the custom chain.
 *
 * Everything in M12 is gated on this. In hardhat mode the auth routes report
 * 404, the middleware passes every request through untouched, and MetaMask
 * behaviour is exactly what it was before — the locked decision in MASTER §1.
 *
 * Delegates to `utils/chainMode` so the server, the Edge middleware and the
 * React components all answer this question from the same code. A second
 * spelling of the check is how a page ends up rendering wallet controls on a
 * deployment whose middleware is already demanding a session.
 */
export const isCustomChainMode = (): boolean => isCustomMode();

/**
 * Whether a role may access a given pathname.
 *
 * Pure and exported so both the middleware and the tests use exactly the same
 * table — a route that is gated in one place and not the other is the classic
 * way authorization drifts.
 */
export const isPathAllowedForRole = (pathname: string, role: AuthRole): boolean => {
  if (pathname.startsWith("/voting/admin") || pathname.startsWith("/api/gn-accounts")) return role === "admin";
  // The GN portal reads its division from the session, which admins do not have.
  if (pathname.startsWith("/gn")) return role === "gn";
  // /api/relay serves both roles; the relay itself enforces the per-role whitelist.
  return true;
};
