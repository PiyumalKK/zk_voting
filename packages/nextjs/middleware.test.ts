import { NextRequest } from "next/server";
import { sealData } from "iron-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from "~~/services/auth/session";

/**
 * Middleware gating.
 *
 * Two properties matter more than the rest and are asserted first:
 *
 * 1. **Hardhat mode is untouched.** MASTER §6.4 makes this a regression rule —
 *    if the middleware ever starts redirecting in hardhat mode, the MetaMask
 *    flow breaks for every operator.
 * 2. **Failing closed.** A missing `SESSION_SECRET` must not leave the admin
 *    pages open; it must produce an error, not a pass-through.
 *
 * `middleware.ts` is re-imported per test because its module graph reads
 * environment variables that these cases change.
 */

const SECRET = "test-session-secret-at-least-32-chars-long";

const loadMiddleware = async () => (await import("./middleware")).middleware;

/** Builds a request carrying a genuine sealed session cookie. */
const requestWithSession = async (
  pathname: string,
  session?: { username: string; role: "admin" | "gn"; divisionId?: number; mustChangePassword?: boolean },
) => {
  const url = `https://example.test${pathname}`;
  if (!session) return new NextRequest(url);
  const seal = await sealData({ ...session, loggedInAt: Date.now() }, { password: SECRET, ttl: SESSION_TTL_SECONDS });
  return new NextRequest(url, { headers: { cookie: `${SESSION_COOKIE_NAME}=${seal}` } });
};

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("SESSION_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hardhat mode", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "hardhat"));

  it("passes every gated route straight through", async () => {
    const middleware = await loadMiddleware();

    for (const pathname of ["/voting/admin", "/gn/register", "/api/relay", "/api/gn-accounts"]) {
      const response = await middleware(await requestWithSession(pathname));
      expect(response.status, pathname).toBe(200);
      expect(response.headers.get("location"), pathname).toBeNull();
    }
  });

  it("stays inert even with no SESSION_SECRET configured", async () => {
    // Hardhat mode must work in a checkout that has never set up M12's env.
    vi.stubEnv("SESSION_SECRET", "");
    const middleware = await loadMiddleware();

    expect((await middleware(await requestWithSession("/voting/admin"))).status).toBe(200);
  });
});

describe("custom mode — signed out", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "custom"));

  it("redirects a page request to /login, preserving the destination", async () => {
    const middleware = await loadMiddleware();
    const response = await middleware(await requestWithSession("/voting/admin"));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/voting/admin");
  });

  it("preserves the query string of the original destination", async () => {
    const middleware = await loadMiddleware();
    const response = await middleware(new NextRequest("https://example.test/gn/register?step=2"));

    expect(new URL(response.headers.get("location")!).searchParams.get("next")).toBe("/gn/register?step=2");
  });

  it("answers API requests with 401 JSON rather than a redirect", async () => {
    const middleware = await loadMiddleware();
    const response = await middleware(await requestWithSession("/api/relay"));

    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: "Sign in to continue." });
  });

  it("ignores a forged session cookie", async () => {
    const middleware = await loadMiddleware();
    const request = new NextRequest("https://example.test/api/relay", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=not-a-valid-seal` },
    });

    expect((await middleware(request)).status).toBe(401);
  });

  it("ignores a session sealed with a different secret", async () => {
    // The check that matters after a SESSION_SECRET rotation, and against
    // anyone who fabricates a cookie without the server's key.
    const seal = await sealData({ username: "attacker", role: "admin" }, { password: "z".repeat(40) });
    const request = new NextRequest("https://example.test/api/gn-accounts", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${seal}` },
    });

    expect((await (await loadMiddleware())(request)).status).toBe(401);
  });
});

describe("custom mode — signed in", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "custom"));

  it("lets an admin through the admin surface", async () => {
    const middleware = await loadMiddleware();

    for (const pathname of ["/voting/admin", "/api/gn-accounts", "/api/relay"]) {
      const request = await requestWithSession(pathname, { username: "admin", role: "admin" });
      expect((await middleware(request)).status, pathname).toBe(200);
    }
  });

  it("lets a GN officer through the GN portal and the relay", async () => {
    const middleware = await loadMiddleware();

    for (const pathname of ["/gn", "/gn/register", "/api/relay"]) {
      const request = await requestWithSession(pathname, { username: "gn-colombo", role: "gn", divisionId: 0 });
      expect((await middleware(request)).status, pathname).toBe(200);
    }
  });

  it("sends a GN officer away from the admin pages", async () => {
    const middleware = await loadMiddleware();
    const request = await requestWithSession("/voting/admin", { username: "gn-colombo", role: "gn", divisionId: 0 });
    const response = await middleware(request);

    expect(response.status).toBe(307);
    // Back to somewhere they are allowed, not to a login they have passed.
    expect(new URL(response.headers.get("location")!).pathname).toBe("/gn");
  });

  it("refuses a GN officer at the admin API with 403, not 401", async () => {
    const middleware = await loadMiddleware();
    const request = await requestWithSession("/api/gn-accounts", { username: "gn-colombo", role: "gn", divisionId: 0 });
    const response = await middleware(request);

    expect(response.status).toBe(403);
  });

  it("sends an admin away from the GN portal", async () => {
    const middleware = await loadMiddleware();
    const request = await requestWithSession("/gn/register", { username: "admin", role: "admin" });
    const response = await middleware(request);

    expect(new URL(response.headers.get("location")!).pathname).toBe("/voting/admin");
  });
});

describe("custom mode — officer still on the admin-issued password", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "custom"));

  const pending = { username: "gn-colombo", role: "gn" as const, divisionId: 0, mustChangePassword: true };

  it("sends every page request to the change-password screen", async () => {
    const middleware = await loadMiddleware();

    for (const pathname of ["/gn", "/gn/register"]) {
      const response = await middleware(await requestWithSession(pathname, pending));
      expect(response.status, pathname).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname, pathname).toBe("/change-password");
    }
  });

  it("refuses the relay, so a shared credential cannot enrol a voter", async () => {
    // The property the whole feature exists for. A redirect would only stop a
    // browser; this is the answer a scripted `addVoters` gets.
    const middleware = await loadMiddleware();
    const response = await middleware(await requestWithSession("/api/relay", pending));

    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({ code: "password_change_required" });
  });

  it("still allows the change-password page and the endpoints it needs", async () => {
    const middleware = await loadMiddleware();
    const response = await middleware(await requestWithSession("/change-password", pending));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("lets an officer who has taken custody return to the page voluntarily", async () => {
    const middleware = await loadMiddleware();
    const request = await requestWithSession("/change-password", {
      username: "gn-colombo",
      role: "gn",
      divisionId: 0,
      mustChangePassword: false,
    });

    expect((await middleware(request)).status).toBe(200);
  });

  it("sends an admin away from the page, since their password lives in the environment", async () => {
    const middleware = await loadMiddleware();
    const request = await requestWithSession("/change-password", { username: "admin", role: "admin" });
    const response = await middleware(request);

    expect(new URL(response.headers.get("location")!).pathname).toBe("/voting/admin");
  });

  it("bounces an unauthenticated visitor to /login", async () => {
    const middleware = await loadMiddleware();
    const response = await middleware(await requestWithSession("/change-password"));

    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });
});

describe("custom mode — misconfigured server", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "custom"));

  it("fails closed when SESSION_SECRET is missing", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    const middleware = await loadMiddleware();

    // The dangerous alternative would be treating "cannot read the session" as
    // "no session required".
    expect((await middleware(new NextRequest("https://example.test/api/relay"))).status).toBe(503);

    const page = await middleware(new NextRequest("https://example.test/voting/admin"));
    expect(page.status).toBe(307);
    expect(new URL(page.headers.get("location")!).searchParams.get("error")).toBe("config");
  });

  it("fails closed when SESSION_SECRET is too short to be safe", async () => {
    vi.stubEnv("SESSION_SECRET", "short");
    const middleware = await loadMiddleware();

    expect((await middleware(new NextRequest("https://example.test/api/relay"))).status).toBe(503);
  });
});
