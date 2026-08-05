import { NextResponse } from "next/server";
import { tryGetServerSession } from "~~/services/auth/serverSession";

/**
 * `POST /api/auth/logout` — destroys the session cookie.
 *
 * POST rather than GET so a prefetch, an `<img>` tag, or a link in an email
 * cannot sign an operator out mid-election.
 *
 * Always reports success, including when no session could be loaded: logging
 * out of an expired — or unreadable — session is not a failure the caller can
 * act on, and the browser should drop the cookie either way.
 */
export async function POST() {
  const loaded = await tryGetServerSession();
  if (loaded.ok) loaded.session.destroy();
  return NextResponse.json({ ok: true });
}
