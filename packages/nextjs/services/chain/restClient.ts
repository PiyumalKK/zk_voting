/**
 * Thin fetch client for the Go blockchain node's public REST API
 * (packages/blockchain — see its API.md for the wire contract). Only used when
 * scaffold.config.ts chainBackend === "custom". Admin writes do NOT go here —
 * they go through the Next.js signing proxy (app/api/admin/[action]/route.ts)
 * because they need the RSA admin signature, which must never reach the browser.
 */
import { ChainError } from "./errors";
import type { RegisterResult, VoterListEntry, VoterStatus, VotingData } from "./types";
import scaffoldConfig from "~~/scaffold.config";

const BASE = scaffoldConfig.chainApiUrl.replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new ChainError(`Cannot reach the blockchain node at ${BASE}. Is it running?`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new ChainError(text || `${res.status} ${res.statusText}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ─── Reads ────────────────────────────────────────────────────────────────────

/** Raw /voting-data wire shape — root/election_id are strings by design (2^53 safety). */
interface VotingDataWire {
  question: string;
  phase: number;
  registration_end_time: number;
  voting_end_time: number;
  tree_size: number;
  depth: number;
  root: string;
  candidate_count: number;
  election_id: string;
}

export async function fetchVotingData(): Promise<VotingData> {
  const d = await request<VotingDataWire>("/voting-data");
  return {
    question: d.question,
    phase: d.phase,
    registrationEndTime: d.registration_end_time,
    votingEndTime: d.voting_end_time,
    treeSize: d.tree_size,
    depth: d.depth,
    root: BigInt(d.root),
    candidateCount: d.candidate_count,
    electionId: d.election_id,
  };
}

export const fetchCandidates = () => request<string[]>("/candidates");

export async function fetchVoteCounts(): Promise<bigint[]> {
  const tally = await request<{ candidate: string; votes: string }[]>("/vote-counts");
  return tally.map(t => BigInt(t.votes));
}

export async function fetchVoterStatus(voterId: string): Promise<VoterStatus> {
  return request<VoterStatus>(`/voter/${encodeURIComponent(voterId)}`);
}

/** Merkle leaves, oldest-first, already scoped to the current election. */
export async function fetchLeaves(): Promise<bigint[]> {
  const commitments = await request<string[]>("/commitments");
  return commitments.map(c => BigInt(c));
}

export async function fetchVoters(): Promise<VoterListEntry[]> {
  const voters = await request<{ voter_id: string; allowed: boolean }[]>("/voters");
  return voters.map(v => ({ id: v.voter_id, allowed: v.allowed }));
}

// ─── Voter writes ─────────────────────────────────────────────────────────────

export async function postRegister(voterId: string, commitmentHex: string): Promise<RegisterResult> {
  const res = await post<{ leaf_index: number; election_id?: string }>("/register", {
    voter_id: voterId,
    commitment: commitmentHex,
  });
  return { leafIndex: res.leaf_index, electionId: res.election_id };
}

export async function postVote(vote: {
  proofHex: string;
  nullifierHashHex: string;
  rootHex: string;
  candidateIndex: number;
  depth: number;
}): Promise<void> {
  await post("/vote", {
    proof: vote.proofHex,
    nullifier_hash: vote.nullifierHashHex,
    root: vote.rootHex,
    candidate_index: vote.candidateIndex,
    depth: vote.depth,
  });
}

// ─── Admin (via the Next.js signing proxy, NOT the node directly) ──────────────

export async function adminAction(action: string, body: unknown, password: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/admin/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-password": password },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ChainError("Cannot reach the admin proxy.");
  }
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401) throw new ChainError("Wrong admin password.");
    throw new ChainError(text || `${res.status} ${res.statusText}`);
  }
}
