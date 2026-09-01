import crypto from "crypto";

/**
 * The SMS claim-link token — same stateless HMAC-signed shape as
 * `services/otp/otpService.ts`'s `signPhoneToken`/`verifyPhoneToken` (proof-
 * of-phone token for voting), reused here for the same reason: no external
 * deps, no separate token-storage table.
 *
 * One-time use is enforced separately, by `EnrolmentInviteStore`'s `status`
 * field — this module only proves "this token was issued by us, for this
 * NIC/division, and has not expired." A forwarded link still fails once the
 * real citizen has already claimed the underlying invite.
 */

const SIGNING_SECRET =
  process.env.ENROLMENT_TOKEN_SECRET?.trim() || "dev-insecure-enrolment-token-secret-change-in-production";

const DEFAULT_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours — long enough for an SMS to be read and acted on

interface TokenPayload {
  nicHash: string;
  divisionId: number;
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function signEnrolmentToken(nicHash: string, divisionId: number, ttlMs = DEFAULT_TTL_MS): string {
  const payload = base64url(JSON.stringify({ nicHash, divisionId, exp: Date.now() + ttlMs } satisfies TokenPayload));
  const sig = base64url(crypto.createHmac("sha256", SIGNING_SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyEnrolmentToken(token: string): { nicHash: string; divisionId: number } | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = base64url(crypto.createHmac("sha256", SIGNING_SECRET).update(payload).digest());
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
    ) as Partial<TokenPayload>;
    if (typeof data.exp !== "number" || Date.now() > data.exp) return null;
    if (typeof data.nicHash !== "string" || typeof data.divisionId !== "number") return null;
    return { nicHash: data.nicHash, divisionId: data.divisionId };
  } catch {
    return null;
  }
}
