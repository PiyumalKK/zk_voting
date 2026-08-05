import { ElectionAuth, resetElectionAuthCache, useElectionAuth } from "./useElectionAuth";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The identity half of the M12 seam.
 *
 * The case that matters most is the first one: in hardhat mode this hook must
 * make **no** network call, because every admin and GN page mounts it and the
 * locked decision in MASTER §1 is that hardhat mode behaves exactly as it did
 * before M12.
 */

const ADMIN_SESSION = { username: "returning-officer", role: "admin", loggedInAt: 1_700_000_000_000 };
const GN_SESSION = { username: "gn.kaduwela", role: "gn", divisionId: 0, loggedInAt: 1_700_000_000_000 };

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;

const enableCustomMode = () => vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "custom");

beforeEach(() => {
  resetElectionAuthCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetElectionAuthCache();
});

describe("useElectionAuth — hardhat mode", () => {
  it("reports the mode without contacting the server", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "hardhat");

    const { result } = renderHook(() => useElectionAuth());

    expect(result.current.mode).toBe("hardhat");
    expect(result.current.session).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isAdmin).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an unset backend as hardhat", () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "");

    const { result } = renderHook(() => useElectionAuth());

    expect(result.current.mode).toBe("hardhat");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never claims admin rights, because ownership there is a wallet question", () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "hardhat");

    const { result } = renderHook(() => useElectionAuth());

    expect(result.current.isAdmin).toBe(false);
    expect(result.current.isGn).toBe(false);
  });
});

describe("useElectionAuth — custom mode", () => {
  it("loads the session and exposes the admin role", async () => {
    enableCustomMode();
    fetchMock.mockResolvedValue(jsonResponse({ mode: "custom", session: ADMIN_SESSION }));

    const { result } = renderHook(() => useElectionAuth());

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.session).toEqual(ADMIN_SESSION);
    expect(result.current.isAdmin).toBe(true);
    expect(result.current.isGn).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("carries the GN's division id through", async () => {
    enableCustomMode();
    fetchMock.mockResolvedValue(jsonResponse({ mode: "custom", session: GN_SESSION }));

    const { result } = renderHook(() => useElectionAuth());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isGn).toBe(true);
    expect(result.current.session?.divisionId).toBe(0);
  });

  it("shares one request across every component that asks", async () => {
    enableCustomMode();
    fetchMock.mockResolvedValue(jsonResponse({ mode: "custom", session: ADMIN_SESSION }));

    const first = renderHook(() => useElectionAuth());
    const second = renderHook(() => useElectionAuth());
    const third = renderHook(() => useElectionAuth());

    await waitFor(() => expect(first.result.current.isLoading).toBe(false));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.result.current.session).toEqual(ADMIN_SESSION);
    expect(third.result.current.isAdmin).toBe(true);
  });

  it("reports signed-out rather than erroring when there is no session", async () => {
    enableCustomMode();
    fetchMock.mockResolvedValue(jsonResponse({ mode: "custom", session: null }));

    const { result } = renderHook(() => useElectionAuth());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.session).toBeNull();
    expect(result.current.error).toBeUndefined();
    expect(result.current.isAdmin).toBe(false);
  });

  it("surfaces a misconfigured server instead of silently denying access", async () => {
    enableCustomMode();
    fetchMock.mockResolvedValue(jsonResponse({ error: "SESSION_SECRET is not configured." }, 503));

    const { result } = renderHook(() => useElectionAuth());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toContain("SESSION_SECRET");
    expect(result.current.session).toBeNull();
  });

  it("survives a network failure with a readable message", async () => {
    enableCustomMode();
    fetchMock.mockRejectedValue(new Error("Failed to fetch"));

    const { result } = renderHook(() => useElectionAuth());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe("Failed to fetch");
    expect(result.current.session).toBeNull();
  });

  it("ignores a malformed session body rather than trusting it", async () => {
    enableCustomMode();
    fetchMock.mockResolvedValue(jsonResponse({ mode: "custom", session: { username: "x", role: "superuser" } }));

    const { result } = renderHook(() => useElectionAuth());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.session).toBeNull();
    expect(result.current.isAdmin).toBe(false);
  });
});

describe("useElectionAuth — signing out", () => {
  const renderSignedIn = async (): Promise<{ result: { current: ElectionAuth } }> => {
    enableCustomMode();
    fetchMock.mockResolvedValue(jsonResponse({ mode: "custom", session: ADMIN_SESSION }));
    const rendered = renderHook(() => useElectionAuth());
    await waitFor(() => expect(rendered.result.current.isLoading).toBe(false));
    return rendered;
  };

  it("posts to the logout route and clears the identity", async () => {
    const { result } = await renderSignedIn();
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    fetchMock.mockResolvedValue(jsonResponse({ mode: "custom", session: null }));

    await act(async () => {
      await result.current.signOut();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST" }));
    await waitFor(() => expect(result.current.session).toBeNull());
  });

  it("clears the identity even when the logout request fails", async () => {
    const { result } = await renderSignedIn();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    fetchMock.mockResolvedValue(jsonResponse({ mode: "custom", session: null }));

    await act(async () => {
      await result.current.signOut().catch(() => undefined);
    });

    await waitFor(() => expect(result.current.session).toBeNull());
  });

  it("refresh re-reads the session from the server", async () => {
    const { result } = await renderSignedIn();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(jsonResponse({ mode: "custom", session: GN_SESSION }));

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => expect(result.current.session).toEqual(GN_SESSION));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
