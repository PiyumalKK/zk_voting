"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { ChainMode, getChainMode } from "~~/utils/chainMode";

/**
 * Who the operator is, in whichever way this deployment authenticates them
 * (`01-AUTH-DESIGN.md` §2).
 *
 * In **hardhat** mode there is no server session at all: admins and GN officers
 * are identified by the wallet they hold, exactly as before M12. This hook
 * reports `mode: "hardhat"`, `session: null` and — importantly — issues **no
 * network request**, so the hardhat-mode pages behave byte-for-byte as they did
 * (MASTER §6.4).
 *
 * In **custom** mode the identity comes from the iron-session cookie, read once
 * through `GET /api/auth/session`. The result is cached in a module-level store
 * rather than per-component state because the header, the admin page and each
 * of its panels all need it: without sharing, one page render would fire five
 * identical requests.
 */

export interface ElectionSession {
  username: string;
  role: "admin" | "gn";
  /** Division index this GN is scoped to. Never set for admins. */
  divisionId?: number;
  /** True while this officer still holds the password their admin generated. */
  mustChangePassword?: boolean;
  loggedInAt: number;
}

export interface ElectionAuth {
  mode: ChainMode;
  session: ElectionSession | null;
  /** True only while the first session read is outstanding — gates must not flash "denied" before it lands. */
  isLoading: boolean;
  /** Set when the session endpoint itself failed (server misconfigured, node down). */
  error?: string;
  /**
   * Custom mode: the operator holds an admin session.
   *
   * Deliberately **not** an on-chain ownership check. `ADMIN_RELAY_PRIVATE_KEY`
   * is defined to be the contracts' owner key, the relay whitelist is the real
   * boundary, and a mis-provisioned key fails loudly on the first transaction
   * with an `Ownable` revert rather than silently granting access. Hardhat-mode
   * pages must keep their own `owner()` comparison — this is always false there.
   */
  isAdmin: boolean;
  /** Custom mode: the operator holds a GN session. Always false in hardhat mode. */
  isGn: boolean;
  /**
   * The session is authenticated but gated: the officer is still on the
   * password their admin generated, and the server refuses every privileged
   * call until they replace it. Pages use this to explain the state rather than
   * letting the first action fail with a bare 403.
   */
  mustChangePassword: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

interface AuthState {
  status: "idle" | "loading" | "ready" | "error";
  session: ElectionSession | null;
  error?: string;
}

const IDLE: AuthState = { status: "idle", session: null };

let state: AuthState = IDLE;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

const setState = (next: AuthState) => {
  state = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => state;

/**
 * Server render always reports "still loading".
 *
 * The cookie is httpOnly, so the server component tree cannot know the answer
 * anyway, and claiming "signed out" during SSR would render the denied state
 * into the HTML before hydration corrects it.
 */
const getServerSnapshot = (): AuthState => IDLE;

const isSession = (value: unknown): value is ElectionSession => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ElectionSession>;
  return typeof candidate.username === "string" && (candidate.role === "admin" || candidate.role === "gn");
};

/**
 * Reads the session once and shares the promise.
 *
 * Concurrent callers join the in-flight request instead of starting their own —
 * the alternative is a thundering herd of identical `GET /api/auth/session`
 * calls every time a page with several panels mounts.
 */
const loadSession = (): Promise<void> => {
  if (inFlight) return inFlight;

  setState({ status: "loading", session: state.session });

  inFlight = fetch("/api/auth/session", { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then(async response => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body?.error === "string" ? body.error : `Session check failed (${response.status}).`);
      }
      setState({ status: "ready", session: isSession(body?.session) ? body.session : null });
    })
    .catch((error: unknown) => {
      setState({
        status: "error",
        session: null,
        error: error instanceof Error ? error.message : "Could not check your sign-in status.",
      });
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
};

/**
 * Drops the cached session so the next read hits the server.
 *
 * Exported because the write seam calls it when the relay answers 401: a
 * session that expired mid-shift must not leave the header showing a signed-in
 * operator who can no longer sign anything.
 */
export const resetElectionAuthCache = () => {
  inFlight = null;
  setState(IDLE);
};

export const useElectionAuth = (): ElectionAuth => {
  const mode = getChainMode();
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Reads the status from the subscribed snapshot rather than the module
  // variable, so the dependency array is honest: this re-runs after
  // `resetElectionAuthCache()` puts the store back to idle, and starts a fresh
  // read.
  useEffect(() => {
    if (mode !== "custom") return;
    if (snapshot.status === "idle") void loadSession();
  }, [mode, snapshot.status]);

  const refresh = useCallback(async () => {
    if (mode !== "custom") return;
    resetElectionAuthCache();
    await loadSession();
  }, [mode]);

  const signOut = useCallback(async () => {
    if (mode !== "custom") return;
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } finally {
      // Clear locally even if the request failed: the operator asked to be
      // signed out, and leaving the UI showing their identity is worse than a
      // cookie that outlives the click and gets rejected on next use.
      resetElectionAuthCache();
    }
  }, [mode]);

  if (mode !== "custom") {
    return {
      mode,
      session: null,
      isLoading: false,
      isAdmin: false,
      isGn: false,
      mustChangePassword: false,
      refresh,
      signOut,
    };
  }

  return {
    mode,
    session: snapshot.session,
    isLoading: snapshot.status === "idle" || snapshot.status === "loading",
    error: snapshot.error,
    isAdmin: snapshot.session?.role === "admin",
    isGn: snapshot.session?.role === "gn",
    mustChangePassword: snapshot.session?.mustChangePassword === true,
    refresh,
    signOut,
  };
};
