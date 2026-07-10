import { NextRequest, NextResponse } from "next/server";
import { normalisePhone, verifyOtp } from "~~/services/otp/otpService";

/**
 * POST /api/otp/verify   body: { phone: string, code: string }
 *
 * Verifies the one-time code. On success returns a short-lived, HMAC-signed
 * proof-of-phone token. The native app presents this token to unlock the voting
 * function. The token is NEVER linked to the anonymous on-chain vote.
 */
export async function POST(req: NextRequest) {
  let phone: string | undefined;
  let code: string | undefined;
  try {
    ({ phone, code } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!phone || typeof phone !== "string" || !code || typeof code !== "string") {
    return NextResponse.json({ error: "`phone` and `code` are required" }, { status: 400 });
  }

  const normalised = normalisePhone(phone);
  if (!normalised) {
    return NextResponse.json({ error: "Invalid Sri Lankan phone number" }, { status: 400 });
  }

  const result = verifyOtp(normalised, code.trim());
  if (!result.ok) {
    return NextResponse.json({ verified: false, error: result.error }, { status: 401 });
  }

  return NextResponse.json({ verified: true, token: result.token });
}
