import { NextRequest, NextResponse } from "next/server";
import { isMockProvider, normalisePhone, sendOtp } from "~~/services/otp/otpService";

/**
 * POST /api/otp/send   body: { phone: string }
 *
 * Generates and delivers a one-time code to the voter's phone. In development the
 * code is logged to the server console (mock provider); swap in Firebase/Twilio
 * for production. Rate-limited per number.
 */
export async function POST(req: NextRequest) {
  let phone: string | undefined;
  try {
    ({ phone } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!phone || typeof phone !== "string") {
    return NextResponse.json({ error: "`phone` is required" }, { status: 400 });
  }

  const normalised = normalisePhone(phone);
  if (!normalised) {
    return NextResponse.json({ error: "Invalid Sri Lankan phone number" }, { status: 400 });
  }

  const result = await sendOtp(normalised);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, retryAfterMs: result.retryAfterMs }, { status: 429 });
  }

  return NextResponse.json({
    sent: true,
    phone: normalised,
    // Dev only (mock provider): return the code so the app can auto-fill it.
    // With a real SMS provider `devCode` is undefined and the code is never exposed.
    devCode: result.devCode,
    devHint: isMockProvider ? "Dev mode: code auto-filled" : undefined,
  });
}
