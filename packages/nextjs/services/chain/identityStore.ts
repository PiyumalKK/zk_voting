"use client";

import { create } from "zustand";

/**
 * Identity state for the CUSTOM chain backend only:
 * - voterId: the opaque ID (e.g. email) the admin allowlisted — the custom
 *   chain's replacement for "connected wallet address". Persisted in
 *   localStorage. It only gates registration; voting stays anonymous (the ZK
 *   proof carries no identity).
 * - adminPassword: unlocks the Next.js admin signing proxy
 *   (app/api/admin/[action]/route.ts). Kept in sessionStorage — the RSA admin
 *   key itself never reaches the browser.
 *
 * Values are hydrated from storage in a useEffect (not at module init) so the
 * server render and first client render match.
 */

const VOTER_ID_KEY = "zk-voting-voter-id";
const ADMIN_PW_KEY = "zk-voting-admin-session";

interface IdentityState {
  hydrated: boolean;
  voterId: string;
  adminPassword: string | null;
  hydrate: () => void;
  setVoterId: (id: string) => void;
  setAdminPassword: (pw: string | null) => void;
}

export const useIdentityStore = create<IdentityState>(set => ({
  hydrated: false,
  voterId: "",
  adminPassword: null,
  hydrate: () => {
    if (typeof window === "undefined") return;
    set(state =>
      state.hydrated
        ? state
        : {
            hydrated: true,
            voterId: window.localStorage.getItem(VOTER_ID_KEY) ?? "",
            adminPassword: window.sessionStorage.getItem(ADMIN_PW_KEY),
          },
    );
  },
  setVoterId: id => {
    window.localStorage.setItem(VOTER_ID_KEY, id);
    set({ voterId: id });
  },
  setAdminPassword: pw => {
    if (pw === null) window.sessionStorage.removeItem(ADMIN_PW_KEY);
    else window.sessionStorage.setItem(ADMIN_PW_KEY, pw);
    set({ adminPassword: pw });
  },
}));
