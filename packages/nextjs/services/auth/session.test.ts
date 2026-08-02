import {
  MIN_SESSION_SECRET_LENGTH,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  SessionConfigError,
  buildSessionOptions,
  isPathAllowedForRole,
} from "./session";
import { describe, expect, it } from "vitest";

describe("buildSessionOptions", () => {
  const secret = "a".repeat(MIN_SESSION_SECRET_LENGTH);

  it("refuses a missing or short secret rather than falling back to a default", () => {
    expect(() => buildSessionOptions(undefined)).toThrow(SessionConfigError);
    expect(() => buildSessionOptions("too-short")).toThrow(/at least 32/);
  });

  it("sets the cookie flags the threat model depends on", () => {
    const options = buildSessionOptions(secret);
    // httpOnly keeps the cookie away from injected scripts; SameSite=strict is
    // what makes the relay safe without CSRF tokens.
    expect(options.cookieOptions?.httpOnly).toBe(true);
    expect(options.cookieOptions?.sameSite).toBe("strict");
    expect(options.cookieName).toBe(SESSION_COOKIE_NAME);
    expect(options.ttl).toBe(SESSION_TTL_SECONDS);
  });

  it("requires TLS only in production, so http://localhost works in dev", () => {
    expect(buildSessionOptions(secret, false).cookieOptions?.secure).toBe(false);
    expect(buildSessionOptions(secret, true).cookieOptions?.secure).toBe(true);
  });

  it("expires after an 8-hour shift", () => {
    expect(SESSION_TTL_SECONDS).toBe(8 * 60 * 60);
  });
});

describe("isPathAllowedForRole", () => {
  it("restricts the admin surface to admins", () => {
    expect(isPathAllowedForRole("/voting/admin", "admin")).toBe(true);
    expect(isPathAllowedForRole("/voting/admin", "gn")).toBe(false);
    expect(isPathAllowedForRole("/api/gn-accounts", "gn")).toBe(false);
  });

  it("restricts the GN portal to GN officers", () => {
    // Admins have no divisionId, so the GN pages have nothing to scope to.
    expect(isPathAllowedForRole("/gn/register", "gn")).toBe(true);
    expect(isPathAllowedForRole("/gn/register", "admin")).toBe(false);
  });

  it("lets both roles reach the relay, which applies its own whitelist", () => {
    expect(isPathAllowedForRole("/api/relay", "admin")).toBe(true);
    expect(isPathAllowedForRole("/api/relay", "gn")).toBe(true);
  });
});
