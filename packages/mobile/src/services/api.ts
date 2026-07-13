import { CONFIG } from "../config";

/**
 * Client for the election backend (the Next.js web app's /api routes).
 * All data here is public — the server never sees keys, secrets or votes.
 */

export interface DivisionState {
  name: string;
  votingContract: `0x${string}`;
  gnOfficer: string;
  active: boolean;
  phase: number;
  phaseLabel: string;
  question: string;
  candidates: string[];
  voteCounts: number[];
  totalVotes: number;
  registeredVoters: number;
  registrationEndTime: number;
  votingEndTime: number;
  root: string;
}

export interface ElectionResponse {
  chainId: number;
  registry: string;
  divisionCount: number;
  national: {
    candidates: string[];
    totals: number[];
    totalVotes: number;
    registeredVoters: number;
    turnout: number;
  };
  divisions: DivisionState[];
}

export interface MerklePathResponse {
  division: string;
  commitment: string;
  leafIndex: number;
  circuitIndex: number;
  depth: number;
  root: string;
  siblings: string[];
  treeSize: number;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CONFIG.apiBaseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export interface VerifyVoteResponse {
  found: boolean;
  candidate?: string | null;
  candidateIndex?: number | null;
  blockNumber?: number;
  timestamp?: number;
}

export const api = {
  getElection: () => req<ElectionResponse>("/api/election"),

  getDivision: (contract: string) =>
    req<ElectionResponse>(`/api/election?division=${contract}`).then(r => r.divisions[0]),

  getMerklePath: (division: string, commitment: string) =>
    req<MerklePathResponse>(`/api/merkle-path?division=${division}&commitment=${commitment}`),

  sendOtp: (phone: string) => req<{ sent: boolean; devHint?: string; devCode?: string }>("/api/otp/send", {
    method: "POST",
    body: JSON.stringify({ phone }),
  }),

  verifyOtp: (phone: string, code: string) =>
    req<{ verified: boolean; token?: string; error?: string }>("/api/otp/verify", {
      method: "POST",
      body: JSON.stringify({ phone, code }),
    }),

  /** DEV-only: fund a burner wallet with gas on the local chain. */
  fundBurner: (address: string) =>
    req<{ funded: boolean; txHash?: string; error?: string }>("/api/faucet", {
      method: "POST",
      body: JSON.stringify({ address }),
    }),

  /** Verify whether a vote (identified by nullifier hash) was counted on-chain. */
  verifyVote: (division: string, nullifierHash: string) =>
    req<VerifyVoteResponse>(`/api/verify-vote?division=${division}&nullifierHash=${nullifierHash}`),
};

