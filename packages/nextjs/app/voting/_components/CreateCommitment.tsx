"use client";

import { useState } from "react";
////// Checkpoint 7 //////
import { Fr } from "@aztec/bb.js";
import { poseidon2 } from "poseidon-lite";
import { toHex } from "viem";
import { mapChainError } from "~~/services/chain/errors";
import {
  useRegisterVoter,
  useStorageNamespace,
  useVoterId,
  useVoterStatus,
  useVotingData,
} from "~~/services/chain/hooks";
import { useChallengeState } from "~~/services/store/challengeStore";
import { saveCommitmentToLocalStorage } from "~~/utils/proofStorage";
import { notification } from "~~/utils/scaffold-eth";

const generateCommitment = async (): Promise<CommitmentData> => {
  ////// Checkpoint 7 //////
  const nullifier = BigInt(Fr.random().toString());
  const secret = BigInt(Fr.random().toString());
  const commitment = poseidon2([nullifier, secret]);

  const commitmentHex = toHex(commitment, { size: 32 });
  const nullifierHex = toHex(nullifier, { size: 32 });
  const secretHex = toHex(secret, { size: 32 });

  return {
    commitment: commitmentHex,
    nullifier: nullifierHex,
    secret: secretHex,
  };
};

interface CommitmentData {
  commitment: string;
  nullifier: string;
  secret: string;
  index?: number;
}

export const CreateCommitment = () => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [isInserting, setIsInserting] = useState(false);
  const { setCommitmentData, commitmentData } = useChallengeState();

  // Backend-agnostic identity/status/registration (services/chain):
  // EVM → connected wallet + register() tx; custom → voter ID + POST /register.
  const { voterId, ready: identityReady, isWallet } = useVoterId();
  const voterStatus = useVoterStatus();
  const { register } = useRegisterVoter();
  const { data: votingData } = useVotingData();
  const storageNamespace = useStorageNamespace();

  const electionId = votingData?.electionId;
  const isVoter = voterStatus?.allowed;
  const hasRegistered = voterStatus?.registered;

  const canRegister = Boolean(identityReady && isVoter !== false && hasRegistered !== true);

  const handleGenerateCommitment = async () => {
    setIsGenerating(true);
    try {
      const data = await generateCommitment();
      setCommitmentData(data);
      return data;
    } catch (error) {
      console.error("Error generating commitment:", error);
      throw error;
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownloadSecret = (dataOverride?: CommitmentData) => {
    const dataToUse = dataOverride || commitmentData;
    if (!dataToUse) {
      notification.error("Generate or register a commitment first.");
      return;
    }
    const payload = {
      nullifier: dataToUse.nullifier,
      secret: dataToUse.secret,
      commitment: dataToUse.commitment,
      index: dataToUse.index,
      electionId: electionId,
      contractAddress: storageNamespace,
      savedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `voter-pass-election-${electionId ?? "x"}.json`;
    link.click();
    URL.revokeObjectURL(url);
    notification.success("Voter Pass automatically downloaded. Keep it safe and private.");
  };

  const handleInsertCommitment = async (dataOverride?: CommitmentData) => {
    const localData = dataOverride || commitmentData;
    if (!localData) return;

    setIsInserting(true);
    try {
      const { leafIndex } = await register(localData.commitment);

      const updatedData = { ...localData, index: leafIndex };
      setCommitmentData(updatedData);

      saveCommitmentToLocalStorage(updatedData, storageNamespace, voterId, electionId);

      // Auto-download the voting key once the registration is confirmed and the index is assigned
      handleDownloadSecret(updatedData);
    } catch (error: any) {
      console.error("Error inserting commitment:", error);
      notification.error(mapChainError(error?.raw ?? error?.message ?? "", "Registration failed"));
    } finally {
      setIsInserting(false);
    }
  };

  const handleRegister = async () => {
    const data = await handleGenerateCommitment();
    await handleInsertCommitment(data);
  };

  return (
    <div className="bg-base-100/60 backdrop-blur-xl shadow-2xl rounded-3xl p-8 space-y-6 border border-base-300/50 hover:border-primary/30 transition-all duration-500 relative overflow-hidden">
      <div className="space-y-1 text-center">
        <h2 className="text-2xl font-bold">Register to vote</h2>
        <p className="text-sm opacity-60">Securely register to get your anonymous Voter Pass.</p>
      </div>

      <div className="flex flex-col gap-3">
        <button
          className={`btn btn-lg ${
            hasRegistered === true
              ? "btn-success cursor-not-allowed shadow-lg shadow-success/20"
              : isGenerating || isInserting
                ? "btn-primary"
                : !canRegister
                  ? "btn-disabled"
                  : "btn-primary shadow-lg shadow-primary/25"
          }`}
          onClick={hasRegistered === true ? undefined : handleRegister}
          disabled={isGenerating || isInserting || !canRegister}
        >
          {isGenerating ? (
            <>
              <span className="loading loading-spinner loading-sm"></span>
              Preparing pass...
            </>
          ) : isInserting ? (
            <>
              <span className="loading loading-spinner loading-sm"></span>
              Securing & Downloading Voter Pass...
            </>
          ) : !identityReady ? (
            isWallet ? (
              "Connect wallet to register"
            ) : (
              "Enter your voter ID above to register"
            )
          ) : isVoter === false ? (
            "Not eligible - not on voters list"
          ) : hasRegistered === true ? (
            "✓ Registered! Wait for voting to open."
          ) : (
            "Register to vote"
          )}
        </button>

        <p className="text-xs opacity-60 text-center">
          Your private Voter Pass will be automatically downloaded once registration is complete. Keep it safe — it is
          required to cast your vote and cannot be recovered if lost.
        </p>
      </div>
    </div>
  );
};
