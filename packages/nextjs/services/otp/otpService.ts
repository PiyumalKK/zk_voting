import crypto from "crypto";

/**
 * OTP service — production-shaped, dependency-free.
 *
 * Responsibilities:
 *  - Generate + store one-time codes per phone (hashed, with expiry + attempt limit).
 *  - Deliver codes through a pluggable provider (mock in dev; Firebase/Twilio in prod).
 *  - Issue a short-lived HMAC-signed proof-of-phone token on successful verification.
 *
 * PRIVACY: the OTP proves the voter's phone is present at auth time. It gates access
 * to the voting function in the app; it is NEVER linked to the on-chain vote (which is
 * cast anonymously via a burner wallet). The server stores no vote data.
 *
 * NOTE: the in-memory store is per-server-instance. For multi-instance production,
 * back it with Redis (same interface).
 */

const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 30 * 1000; // 30s between sends
const TOKEN_TTL_MS = 10 * 60 * 1000; // proof-of-phone token valid 10 min

const SIGNING_SECRET = process.env.OTP_SIGNING_SECRET ?? "dev-insecure-otp-secret-change-in-production";

interface OtpRecord {
  codeHash: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
}

// Persist across Next.js dev Fast Refresh / route recompiles (which would otherwise
// reset a module-level Map and drop pending codes between send and verify).
const store: Map<string, OtpRecord> =
  (globalThis as unknown as { __slvoteOtpStore?: Map<string, OtpRecord> }).__slvoteOtpStore ??
  ((globalThis as unknown as { __slvoteOtpStore?: Map<string, OtpRecord> }).__slvoteOtpStore = new Map());

function hashCode(phone: string, code: string): string {
  return crypto.createHmac("sha256", SIGNING_SECRET).update(`${phone}:${code}`).digest("hex");
}

export function normalisePhone(phone: string): string | null {
  const trimmed = phone.trim().replace(/[\s-]/g, "");
  // Accept Sri Lankan formats: +947XXXXXXXX, 07XXXXXXXX, 947XXXXXXXX
  if (/^\+947\d{8}$/.test(trimmed)) return trimmed;
  if (/^947\d{8}$/.test(trimmed)) return `+${trimmed}`;
  if (/^07\d{8}$/.test(trimmed)) return `+94${trimmed.slice(1)}`;
  return null;
}

// ---- Pluggable delivery provider -------------------------------------------

export interface OtpProvider {
  send(phone: string, code: string): Promise<void>;
}

/** Dev provider: logs the code to the server console instead of sending SMS. */
const mockProvider: OtpProvider = {
  async send(phone, code) {
    console.log(`[OTP][mock] → ${phone}: ${code}`);
  },
};

// Swap this for a Firebase/Twilio provider in production (same interface).
const provider: OtpProvider = mockProvider;

export const isMockProvider = provider === mockProvider;

// ---- Public API -------------------------------------------------------------

export type SendResult = { ok: true; devCode?: string } | { ok: false; error: string; retryAfterMs?: number };

export async function sendOtp(phone: string): Promise<SendResult> {
  const existing = store.get(phone);
  const now = Date.now();

  if (existing && now - existing.lastSentAt < RESEND_COOLDOWN_MS) {
    return {
      ok: false,
      error: "Please wait before requesting another code",
      retryAfterMs: RESEND_COOLDOWN_MS - (now - existing.lastSentAt),
    };
  }

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  store.set(phone, {
    codeHash: hashCode(phone, code),
    expiresAt: now + CODE_TTL_MS,
    attempts: 0,
    lastSentAt: now,
  });

  await provider.send(phone, code);
  // In dev (mock provider) return the code so the app can show/auto-fill it.
  // NEVER returned when a real SMS provider is configured.
  return { ok: true, devCode: isMockProvider ? code : undefined };
}

export type VerifyResult = { ok: true; token: string } | { ok: false; error: string };

export function verifyOtp(phone: string, code: string): VerifyResult {
  const record = store.get(phone);
  const now = Date.now();

  if (!record) return { ok: false, error: "No code requested for this number" };
  if (now > record.expiresAt) {
    store.delete(phone);
    return { ok: false, error: "Code expired — request a new one" };
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    store.delete(phone);
    return { ok: false, error: "Too many attempts — request a new code" };
  }

  record.attempts += 1;

  if (hashCode(phone, code) !== record.codeHash) {
    return { ok: false, error: "Incorrect code" };
  }

  store.delete(phone); // single-use
  return { ok: true, token: signPhoneToken(phone) };
}

// ---- Proof-of-phone token (HMAC, no external deps) --------------------------

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function signPhoneToken(phone: string): string {
  const payload = base64url(JSON.stringify({ phone, exp: Date.now() + TOKEN_TTL_MS }));
  const sig = base64url(crypto.createHmac("sha256", SIGNING_SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyPhoneToken(token: string): { phone: string } | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = base64url(crypto.createHmac("sha256", SIGNING_SECRET).update(payload).digest());
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    if (typeof data.exp !== "number" || Date.now() > data.exp) return null;
    return { phone: data.phone };
  } catch {
    return null;
  }
}
