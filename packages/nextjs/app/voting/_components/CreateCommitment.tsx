"use client";

import { useState } from "react";
////// Checkpoint 7 //////
import { Fr } from "@aztec/bb.js";
import { poseidon2 } from "poseidon-lite";
import { decodeEventLog, toHex } from "viem";
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
    notification.success("Voting Key automatically downloaded. Keep it safe and private.");
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
          onBlockConfirmation: (txnReceipt: any) => {
            let newIndex = leafEvents ? leafEvents.length : 0; // fallback
            
            if (txnReceipt && txnReceipt.logs) {
              for (const log of txnReceipt.logs) {
                try {
                  const decoded = decodeEventLog({
                    abi: deployedContractData?.abi as any,
                    data: log.data,
                    topics: log.topics,
                  });
                  if (decoded.eventName === "NewLeaf") {
                    newIndex = Number((decoded.args as any).index);
                    break;
                  }
                } catch (e) {
                  // Ignore logs that don't match
                }
              }
            }

            const updatedData = { ...localData, index: newIndex };
            setCommitmentData(updatedData);
            setIsInserted(true);

            saveCommitmentToLocalStorage(updatedData, deployedContractData?.address, userAddress, electionId);
            
            // Auto-download the voting key once the block is confirmed and index is assigned
            handleDownloadSecret(updatedData);
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

  return (
    <div className="bg-base-100/60 backdrop-blur-xl shadow-2xl rounded-3xl p-8 space-y-6 border border-base-300/50 hover:border-primary/30 transition-all duration-500 relative overflow-hidden">
      <div className="space-y-1 text-center">
        <h2 className="text-2xl font-bold">Register for this vote</h2>
        <p className="text-sm opacity-60">Securely register to get your anonymous voting pass.</p>
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
              Securing & Downloading Key...
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

        <p className="text-xs opacity-60 text-center">
          Your private Voting Key will be automatically downloaded once registration is complete. Keep it safe — it is required to cast your vote and cannot be recovered if lost.
        </p>
      </div>
    </div>
  );
};
