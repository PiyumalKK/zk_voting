import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import type { IronSession } from "iron-session";
import { getSessionOptions } from "~~/services/auth/session";
import type { AuthRole, SessionData } from "~~/services/auth/session";

/**
 * Session access for route handlers (Node runtime).
 *
 * The middleware reads the session from the `NextRequest`/`NextResponse` pair
 * instead — see `middleware.ts`. Both use the same options from `session.ts`,
 * so a cookie sealed by a login route is readable by the middleware and vice
 * versa.
 */

export const getServerSession = async (): Promise<IronSession<SessionData>> =>
  getIronSession<SessionData>(await cookies(), getSessionOptions());

/** The response sent when the server cannot construct a session at all. */
const misconfigured = () =>
  Response.json({ error: "Authentication is not configured on this server." }, { status: 503 });

/**
 * Loads the session, turning a configuration failure into a 503.
 *
 * `getSessionOptions()` throws when `SESSION_SECRET` is missing or too short.
 * Every route that touches a session has to handle that, or a server started
 * without the variable answers with a 500 and a stack trace instead of saying
 * which variable is wrong.
 */
export const tryGetServerSession = async (): Promise<
  { ok: true; session: IronSession<SessionData> } | { ok: false; response: Response }
> => {
  try {
    return { ok: true, session: await getServerSession() };
  } catch (error) {
    console.error("[auth] session configuration error", error);
    return { ok: false, response: misconfigured() };
  }
};

export interface RequireSessionOptions {
  /**
   * Let the call through even when the officer still owes a password change.
   *
   * Exactly one route sets this: `POST /api/auth/password`, which is the action
   * that clears the condition. Anything else passing it would reopen the hole
   * this gate exists to close, so it is spelled out at the call site rather
   * than inferred from the pathname.
   */
  allowPasswordChangePending?: boolean;
}

/**
 * Loads the session and checks the role, returning a `Response` to send when
 * the caller is not entitled to proceed.
 *
 * Route handlers re-check the role even though the middleware already did:
 * middleware is a convenience layer that can be bypassed by any future route
 * that falls outside its matcher, so authorization is enforced where the
 * privileged work actually happens.
 *
 * The same reasoning is why the pending-password gate lives here and not only
 * in `middleware.ts`. A redirect stops a browser; it does not stop a `curl`
 * against `/api/relay` carrying a valid cookie. This function is the single
 * chokepoint every privileged path already passes through — `POST /api/relay`
 * (and therefore `addVoters`), `POST /api/nic/hash`, and all of
 * `/api/gn-accounts` — so gating it here covers them and anything added later.
 */
export const requireSession = async (
  role?: AuthRole,
  { allowPasswordChangePending = false }: RequireSessionOptions = {},
): Promise<{ ok: true; data: SessionData; session: IronSession<SessionData> } | { ok: false; response: Response }> => {
  const loaded = await tryGetServerSession();
  if (!loaded.ok) return { ok: false, response: loaded.response };
  const { session } = loaded;

  if (!session.username || !session.role) {
    return {
      ok: false,
      response: Response.json({ error: "Sign in to continue." }, { status: 401 }),
    };
  }
  if (role && session.role !== role) {
    return {
      ok: false,
      response: Response.json({ error: "Your account may not perform this action." }, { status: 403 }),
    };
  }
  if (session.mustChangePassword && !allowPasswordChangePending) {
    return {
      ok: false,
      response: Response.json(
        {
          error: "Set your own password before continuing.",
          // A machine-readable marker so the client seam can route to the
          // change-password page instead of showing this as a flat failure.
          code: "password_change_required",
        },
        { status: 403 },
      ),
    };
  }
  return {
    ok: true,
    session,
    data: {
      username: session.username,
      role: session.role,
      divisionId: session.divisionId,
      mustChangePassword: session.mustChangePassword,
      loggedInAt: session.loggedInAt,
    },
  };
};
