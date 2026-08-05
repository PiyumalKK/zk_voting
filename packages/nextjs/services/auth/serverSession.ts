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

/**
 * Loads the session and checks the role, returning a `Response` to send when
 * the caller is not entitled to proceed.
 *
 * Route handlers re-check the role even though the middleware already did:
 * middleware is a convenience layer that can be bypassed by any future route
 * that falls outside its matcher, so authorization is enforced where the
 * privileged work actually happens.
 */
export const requireSession = async (
  role?: AuthRole,
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
  return {
    ok: true,
    session,
    data: {
      username: session.username,
      role: session.role,
      divisionId: session.divisionId,
      loggedInAt: session.loggedInAt,
    },
  };
};
