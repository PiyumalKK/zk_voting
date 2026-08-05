import { NextResponse } from "next/server";
import { tryGetServerSession } from "~~/services/auth/serverSession";
import { isCustomChainMode } from "~~/services/auth/session";

/**
 * `GET /api/auth/session` — who am I?
 *
 * The client seam (`useElectionAuth`, M12 pass 2) calls this to decide whether
 * to render wallet controls or a credential identity. It reports `mode` in both
 * backends so the UI has a single source of truth for the swap switch, and
 * returns `session: null` rather than a 401 when signed out — "not signed in"
 * is a normal state for a page that is about to redirect, not an error.
 */
export async function GET() {
  const mode = isCustomChainMode() ? "custom" : "hardhat";
  if (mode === "hardhat") {
    return NextResponse.json({ mode, session: null });
  }

  const loaded = await tryGetServerSession();
  if (!loaded.ok) return loaded.response;
  const { session } = loaded;

  if (!session.username || !session.role) {
    return NextResponse.json({ mode, session: null });
  }

  return NextResponse.json({
    mode,
    session: {
      username: session.username,
      role: session.role,
      divisionId: session.divisionId,
      loggedInAt: session.loggedInAt,
    },
  });
}
