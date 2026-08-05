import { NextRequest, NextResponse } from "next/server";
import { sharedRateLimiter } from "~~/services/auth/rateLimit";
import { executeRelayCall } from "~~/services/auth/relayExecutor";
import { requireSession } from "~~/services/auth/serverSession";
import { isCustomChainMode } from "~~/services/auth/session";

/**
 * `POST /api/relay` — the server-side signer (`01-AUTH-DESIGN.md` §4).
 *
 * Body: `{ target: "0x…", fn: "startVoting", args: [3600] }`.
 *
 * The route itself is deliberately thin: session, rate limit, shape check, then
 * `executeRelayCall`, which owns the whitelist, the scoping rules, the keys and
 * the audit log. Keeping the policy out of the HTTP layer is what lets it be
 * unit-tested exhaustively without a chain.
 *
 * The relay never signs `register`, `vote` or value transfers — voter
 * transactions must not pass through the server, or the anonymity argument
 * collapses. That is enforced by the whitelist, not by this comment.
 */

const RELAY_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function POST(req: NextRequest) {
  if (!isCustomChainMode()) {
    return NextResponse.json(
      { error: "The relay is only available in custom-chain mode; use your wallet instead." },
      { status: 404 },
    );
  }

  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  // Keyed by identity rather than IP: two officers sharing an office should not
  // throttle each other, and one compromised session should not get 30 more
  // calls per minute by changing address.
  const decision = sharedRateLimiter("relay", RELAY_RATE_LIMIT).consume(`${auth.data.role}:${auth.data.username}`);
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Too many transactions in the last minute. Wait a moment and retry." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(decision.retryAfterMs / 1000)) } },
    );
  }

  let body: { target?: unknown; fn?: unknown; args?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const outcome = await executeRelayCall({
    session: auth.data,
    request: {
      target: typeof body.target === "string" ? body.target : "",
      fn: typeof body.fn === "string" ? body.fn : "",
      args: Array.isArray(body.args) ? body.args : [],
    },
  });

  if (!outcome.ok) {
    // `errorName` carries the Solidity custom-error name so the existing UI
    // string matching (`NicRegistry__AlreadyUsed`, `WrongPhase`, …) keeps
    // working unchanged.
    return NextResponse.json({ error: outcome.error, errorName: outcome.errorName }, { status: outcome.status });
  }

  return NextResponse.json({
    txHash: outcome.txHash,
    blockNumber: outcome.blockNumber,
    status: outcome.status,
  });
}
