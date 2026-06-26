"use client";

import { useState } from "react";
////// Checkpoint 7 //////
import { Fr } from "@aztec/bb.js";
import { poseidon2 } from "poseidon-lite";
import { toHex } from "viem";
import { useAccount } from "wagmi";
import { useDeployedContractInfo, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
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

interface CreateCommitmentProps {
  leafEvents?: any[];
}

export const CreateCommitment = ({ leafEvents = [] }: CreateCommitmentProps) => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [isInserting, setIsInserting] = useState(false);
  const [, setIsInserted] = useState(false);
  const { setCommitmentData, commitmentData } = useChallengeState();

  const { address: userAddress, isConnected } = useAccount();

  const { data: deployedContractData } = useDeployedContractInfo({ contractName: "Voting" });

  const { data: voterData } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getVoterData",
    args: [userAddress as `0x${string}`],
  });

  const { data: electionId } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getCurrentElectionId",
  });

  const isVoter = voterData?.[0];
  const hasRegistered = voterData?.[1];

  const canRegister = Boolean(isConnected && isVoter !== false && hasRegistered !== true);

  const { writeContractAsync } = useScaffoldWriteContract({
    contractName: "Voting",
  });

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

  const handleInsertCommitment = async (dataOverride?: CommitmentData) => {
    const localData = dataOverride || commitmentData;
    if (!localData) return;

    setIsInserting(true);
    try {
      await writeContractAsync(
        {
          functionName: "register",
          args: [BigInt(localData.commitment)],
        },
        {
          blockConfirmations: 1,
          onBlockConfirmation: () => {
            if (leafEvents) {
              const newIndex = leafEvents.length;
              const updatedData = { ...localData, index: newIndex };
              setCommitmentData(updatedData);
              setIsInserted(true);

              saveCommitmentToLocalStorage(updatedData, deployedContractData?.address, userAddress, electionId);
            }
          },
        },
      );
    } catch (error) {
      console.error("Error inserting commitment:", error);
    } finally {
      setIsInserting(false);
    }
  };

  const handleRegister = async () => {
    const data = await handleGenerateCommitment();
    await handleInsertCommitment(data);
  };

  const handleDownloadSecret = () => {
    if (!commitmentData) {
      notification.error("Generate or register a commitment first.");
      return;
    }
    const payload = {
      nullifier: commitmentData.nullifier,
      secret: commitmentData.secret,
      commitment: commitmentData.commitment,
      index: commitmentData.index,
      electionId: electionId?.toString(),
      contractAddress: deployedContractData?.address,
      savedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `zk-voting-secret-election-${electionId?.toString() ?? "x"}.json`;
    link.click();
    URL.revokeObjectURL(url);
    notification.success("Secret backup downloaded. Keep it safe and private.");
  };

  return (
    <div className="bg-base-100 shadow-lg rounded-2xl p-6 space-y-5 border border-base-300/50 hover-lift">
      <div className="space-y-1 text-center">
        <h2 className="text-2xl font-bold">Register for this vote</h2>
        <p className="text-sm opacity-60">Generate your anonymous identifier and insert it into the Merkle tree.</p>
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
              Generating commitment...
            </>
          ) : isInserting ? (
            <>
              <span className="loading loading-spinner loading-sm"></span>
              Inserting into Merkle tree...
            </>
          ) : !isConnected ? (
            "Connect wallet to register"
          ) : isVoter === false ? (
            "Not eligible - not on voters list"
          ) : hasRegistered === true ? (
            "✓ Already registered for this vote"
          ) : (
            "Register to vote"
          )}
        </button>

        <div className="flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            className="btn btn-outline btn-sm flex-1"
            onClick={handleDownloadSecret}
            disabled={!commitmentData}
            title="Download your secret and nullifier as a backup file"
          >
            Download secret &amp; nullifier
          </button>
        </div>
        <p className="text-xs opacity-60 text-center">
          Your secret and nullifier are your private voting key. Download and keep them safe — they are required to cast
          your vote and cannot be recovered if lost.
        </p>
      </div>
    </div>
  );
};
