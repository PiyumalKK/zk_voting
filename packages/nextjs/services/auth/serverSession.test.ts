import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from "./session";
import type { SessionData } from "./session";
import { sealData } from "iron-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `requireSession()` — the real authorization boundary.
 *
 * The middleware produces friendly redirects, but it only sees requests that
 * match its `matcher` and only stops clients that follow redirects. Every
 * privileged route calls this function, so these cases are what actually
 * guarantee that an officer still holding the password their admin generated
 * cannot reach `POST /api/relay` and enrol a voter.
 */

const SECRET = "test-session-secret-at-least-32-chars-long";

/**
 * A stand-in for Next's cookie store.
 *
 * `getIronSession` only needs `get`/`set` here — it reads the sealed value and
 * would write a refreshed one on `save()`, which these cases do not exercise.
 */
const cookieStore = (seal?: string) => ({
  get: (name: string) => (seal && name === SESSION_COOKIE_NAME ? { name, value: seal } : undefined),
  set: () => undefined,
});

const mockCookies = vi.fn();
vi.mock("next/headers", () => ({ cookies: () => mockCookies() }));

const signIn = async (session: Partial<SessionData>) => {
  const seal = await sealData({ loggedInAt: Date.now(), ...session }, { password: SECRET, ttl: SESSION_TTL_SECONDS });
  mockCookies.mockResolvedValue(cookieStore(seal));
};

const loadRequireSession = async () => (await import("./serverSession")).requireSession;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("SESSION_SECRET", SECRET);
  mockCookies.mockResolvedValue(cookieStore());
});

afterEach(() => {
  vi.unstubAllEnvs();
  mockCookies.mockReset();
});

describe("requireSession", () => {
  it("rejects a request with no session", async () => {
    const requireSession = await loadRequireSession();
    const result = await requireSession();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("admits a signed-in officer who has taken custody of their password", async () => {
    const requireSession = await loadRequireSession();
    await signIn({ username: "gn-colombo", role: "gn", divisionId: 0, mustChangePassword: false });

    const result = await requireSession("gn");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.divisionId).toBe(0);
  });

  it("enforces the role", async () => {
    const requireSession = await loadRequireSession();
    await signIn({ username: "gn-colombo", role: "gn", divisionId: 0 });

    const result = await requireSession("admin");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });
});

describe("requireSession — pending password change", () => {
  const pending = { username: "gn-colombo", role: "gn" as const, divisionId: 0, mustChangePassword: true };

  it("refuses a privileged call even though the credential was correct", async () => {
    // This is the case the feature exists for: the officer is authenticated,
    // but the password is one their admin also knows, so nothing they do here
    // could be attributed to them alone.
    const requireSession = await loadRequireSession();
    await signIn(pending);

    const result = await requireSession("gn");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toMatchObject({ code: "password_change_required" });
    }
  });

  it("refuses the admin API to a gated session as well", async () => {
    const requireSession = await loadRequireSession();
    await signIn({ username: "gn-colombo", role: "gn", mustChangePassword: true });

    expect((await requireSession()).ok).toBe(false);
  });

  it("lets the password-change route through, since it is what clears the gate", async () => {
    const requireSession = await loadRequireSession();
    await signIn(pending);

    const result = await requireSession(undefined, { allowPasswordChangePending: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.mustChangePassword).toBe(true);
  });

  it("does not gate a session that never carried the flag", async () => {
    // Admins are never gated, and a session sealed before this feature existed
    // has no flag at all — neither must be locked out.
    const requireSession = await loadRequireSession();
    await signIn({ username: "admin", role: "admin" });

    expect((await requireSession("admin")).ok).toBe(true);
  });
});
