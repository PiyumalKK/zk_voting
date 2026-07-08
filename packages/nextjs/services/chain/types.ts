/**
 * Normalized chain-data types — the contract between the voting UI and
 * whichever backend serves it (Hardhat/EVM via wagmi, or the Go node's REST
 * API). Components consume ONLY these shapes via the hooks in ./hooks.ts;
 * neither tuple indices (EVM) nor JSON field names (REST) leak past this
 * module. That is the whole plug-and-play seam.
 */

export type ChainBackend = "hardhat" | "custom";

/** Phase enum values, matching Voting.sol's Phase and the Go node's `phase`. */
export const PHASE = { Setup: 0, Registration: 1, Voting: 2, Ended: 3 } as const;
export const PHASE_LABELS = ["Setup", "Registration", "Voting", "Ended"] as const;

export interface VotingData {
  question: string;
  /** 0 Setup, 1 Registration, 2 Voting, 3 Ended */
  phase: number;
  /** Unix seconds; 0 when not set */
  registrationEndTime: number;
  votingEndTime: number;
  treeSize: number;
  depth: number;
  /** Current LeanIMT Merkle root (BN254 field element) */
  root: bigint;
  candidateCount: number;
  /** Scopes Voter Passes / localStorage across resetElection() */
  electionId: string;
}

export interface VoterStatus {
  allowed: boolean;
  registered: boolean;
}

export interface VoterListEntry {
  /** Wallet address (hardhat) or opaque voter ID such as an email (custom) */
  id: string;
  allowed: boolean;
}

export interface RegisterResult {
  /** LeanIMT leaf index assigned to the commitment — goes into the Voter Pass */
  leafIndex: number;
  electionId?: string;
}

/** Everything needed to submit an anonymous vote (identical for both backends). */
export interface VoteSubmission {
  /** Raw UltraHonk proof bytes (keccak flavor) */
  proof: Uint8Array;
  /** Circuit public inputs in order: [nullifierHash, root, vote, depth] as 0x-hex */
  publicInputs: string[];
  candidateIndex: number;
}
