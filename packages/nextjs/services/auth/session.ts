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
  /**
   * Set while this officer is still on the password their admin generated.
   *
   * The session is real — they are authenticated — but `requireSession()`
   * refuses every privileged call until they replace it. Mirrored from the
   * account record at login so the check costs no store read per request.
   */
  mustChangePassword?: boolean;
  /** Epoch ms, for display and for the audit log. */
  loggedInAt: number;
}

/** Where an officer is sent, and the only page they may use, until they set their own password. */
export const CHANGE_PASSWORD_PATH = "/change-password";

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
export const getSessionOptions = (): SessionOptions => {
  // Cookies are Secure in production by default. Set SESSION_COOKIE_INSECURE=true
  // when serving over plain HTTP (e.g. an ALB with no TLS), or the browser drops
  // the Secure cookie and login silently never sticks.
  const secure = process.env.NODE_ENV === "production" && process.env.SESSION_COOKIE_INSECURE !== "true";
  return buildSessionOptions(process.env.SESSION_SECRET, secure);
};

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
/**
 * Whether a path stays open to a session that has not yet changed its password.
 *
 * Deliberately a tiny allowlist — everything not named here is closed. The
 * three entries are what the change-password page itself needs to function:
 * the page, the endpoint that performs the change, and the session read the
 * client seam does on mount. Signing out must also keep working, or an officer
 * who cannot complete the change is stuck with no way back to the login form.
 *
 * Pure and shared with `requireSession()` so the Edge redirect and the Node
 * enforcement cannot disagree about which paths are exempt.
 */
export const isPathAllowedWhilePasswordPending = (pathname: string): boolean =>
  pathname === CHANGE_PASSWORD_PATH ||
  pathname === "/api/auth/password" ||
  pathname === "/api/auth/session" ||
  pathname === "/api/auth/logout";

export const isPathAllowedForRole = (pathname: string, role: AuthRole): boolean => {
  if (pathname.startsWith("/voting/admin") || pathname.startsWith("/api/gn-accounts")) return role === "admin";
  // The GN portal reads its division from the session, which admins do not have.
  if (pathname.startsWith("/gn")) return role === "gn";
  // /api/relay serves both roles; the relay itself enforces the per-role whitelist.
  return true;
};
