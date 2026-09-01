/**
 * SMS delivery — pluggable provider, same shape as `services/otp/otpService.ts`'s
 * `OtpProvider`. Kept as a sibling module rather than folded into the OTP
 * service: OTP proves "this phone is present right now" for voting, this
 * proves nothing on its own — it just carries a claim link. Different job,
 * same interface so a real provider (Twilio/Firebase/a local gateway) can
 * implement both with one adapter later.
 */

export interface SmsProvider {
  send(phone: string, message: string): Promise<void>;
}

/** Dev provider: logs the message to the server console instead of sending SMS. */
const mockProvider: SmsProvider = {
  async send(phone, message) {
    console.log(`[SMS][mock] → ${phone}: ${message}`);
  },
};

// Swap this for a real SMS gateway in production (same interface).
const provider: SmsProvider = mockProvider;

export const isMockSmsProvider = provider === mockProvider;

export const sendSms = (phone: string, message: string): Promise<void> => provider.send(phone, message);
