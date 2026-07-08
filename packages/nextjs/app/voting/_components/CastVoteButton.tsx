"use client";

import { useEffect, useState } from "react";
import { mapChainError } from "~~/services/chain/errors";
import { useCastVote, useStorageNamespace, useVotingData } from "~~/services/chain/hooks";
import { useVoterId } from "~~/services/chain/hooks";
import { useChallengeState } from "~~/services/store/challengeStore";
import { hasStoredProof, loadProofFromLocalStorage } from "~~/utils/proofStorage";
import { notification } from "~~/utils/scaffold-eth";

/**
 * Vote submission for the CUSTOM chain backend: a single POST /vote with the
 * ZK proof — no burner wallet, no gas, no funding step. The Go node runs the
 * real HonkVerifier before anything is committed. Counterpart of
 * VoteWithBurnerHardhat/Sepolia, which remain the EVM submission paths.
 */
export const CastVoteButton = ({
  onGenerateProof,
  isGenerating,
  canVote,
}: {
  onGenerateProof?: () => Promise<boolean>;
  isGenerating?: boolean;
  canVote?: boolean;
}) => {
  const [txStatus, setTxStatus] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [hasVoted, setHasVoted] = useState(false);
  const { proofData, setProofData, voteChoice } = useChallengeState();
  const { castVote } = useCastVote();
  const { data: votingData } = useVotingData();
  const { voterId } = useVoterId();
  const namespace = useStorageNamespace();
  const electionId = votingData?.electionId;

  // Auto-restore a previously generated proof for this election.
  useEffect(() => {
    if (!namespace || !voterId || proofData) return;
    if (hasStoredProof(namespace, voterId, electionId)) {
      try {
        const stored = loadProofFromLocalStorage(namespace, voterId, electionId);
        if (stored) setProofData(stored);
      } catch (e) {
        console.error("Error auto-loading proof:", e);
      }
    }
  }, [namespace, voterId, electionId, proofData, setProofData]);

  const submit = async () => {
    try {
      if (!proofData && onGenerateProof) {
        const ok = await onGenerateProof();
        if (!ok) return;
      }
      let latest = proofData;
      if (!latest && namespace && voterId) {
        latest = loadProofFromLocalStorage(namespace, voterId, electionId) ?? null;
      }
      if (!latest) {
        notification.error("Generate your proof first.");
        return;
      }
      if (voteChoice === null) {
        notification.error("Select a candidate first.");
        return;
      }

      // Stale-proof pre-check, mirroring the EVM component: the contract
      // rejects proofs generated against an outdated Merkle root.
      const proofRoot = latest.publicInputs?.[1];
      if (votingData?.root !== undefined && proofRoot !== undefined) {
        try {
          if (BigInt(proofRoot as string) !== votingData.root) {
            notification.error("Your Voter Pass proof is outdated. Regenerate your proof and try again.");
            return;
          }
        } catch {
          // fall through — let the node decide
        }
      }

      setTxStatus("pending");
      await castVote({
        proof: latest.proof as Uint8Array,
        publicInputs: latest.publicInputs as string[],
        candidateIndex: voteChoice,
      });
      setTxStatus("success");
      setHasVoted(true);
      notification.success("Vote cast anonymously — thank you!");
    } catch (e: any) {
      console.error("Error voting:", e);
      const raw: string = e?.raw ?? e?.message ?? "";
      if (raw.includes("NullifierHashAlreadyUsed")) setHasVoted(true);
      notification.error(mapChainError(raw, "Vote submission failed"));
      setTxStatus("error");
    }
  };

  return (
    <div className="bg-base-100/60 backdrop-blur-xl shadow-2xl rounded-3xl p-8 space-y-6 border border-base-300/50 hover:border-primary/30 transition-all duration-500 relative overflow-hidden">
      <div className="space-y-1 text-center">
        <h2 className="text-2xl font-bold">Vote</h2>
        <p className="text-sm opacity-60">Submit your vote privately to the blockchain — no wallet, no gas.</p>
      </div>

      <div className="flex justify-center">
        <button
          className={`btn btn-primary ${txStatus === "pending" || isGenerating ? "loading" : ""} ${
            !canVote || hasVoted || voteChoice === null ? "" : "shadow-lg shadow-primary/25"
          }`}
          disabled={!canVote || hasVoted || txStatus === "pending" || isGenerating || voteChoice === null}
          onClick={submit}
        >
          {isGenerating
            ? "Anonymizing your vote..."
            : txStatus === "pending"
              ? "Voting..."
              : hasVoted
                ? "Already voted"
                : !canVote
                  ? "Must register first"
                  : voteChoice === null
                    ? "Select choice first"
                    : "Cast Vote"}
        </button>
      </div>
    </div>
  );
};
