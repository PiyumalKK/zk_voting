"use client";

import { useEffect, useRef, useState } from "react";
import { UltraHonkBackend } from "@aztec/bb.js";
// @ts-ignore
import { Noir } from "@noir-lang/noir_js";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon1, poseidon2 } from "poseidon-lite";
import { toHex } from "viem";
import { hardhat, sepolia } from "viem/chains";
import { CastVoteButton } from "~~/app/voting/_components/CastVoteButton";
import { VoteSelector } from "~~/app/voting/_components/VoteChoice";
import { VoteWithBurnerHardhat } from "~~/app/voting/_components/VoteWithBurnerHardhat";
import { VoteWithBurnerSepolia } from "~~/app/voting/_components/VoteWithBurnerSepolia";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import { isCustomChain, useStorageNamespace, useVoterId, useVoterStatus, useVotingData } from "~~/services/chain/hooks";
import { useChallengeState } from "~~/services/store/challengeStore";
import {
  loadCommitmentFromLocalStorage,
  saveCommitmentToLocalStorage,
  saveProofToLocalStorage,
} from "~~/utils/proofStorage";
import { notification } from "~~/utils/scaffold-eth";

const generateProof = async (
  _root: bigint,
  _vote: number,
  _depth: number,
  _nullifier: string,
  _secret: string,
  _index: number,
  _leaves: bigint[],
  _circuitData: any,
) => {
  try {
    // Step 1: Compute nullifier hash (matches circuit's hash_1([nullifier]))
    const nullifierHash = poseidon1([BigInt(_nullifier)]);

    // Step 2: Rebuild the Merkle tree from the normalized leaf list
    // (already oldest-first / insertion order — see useLeaves()).
    const calculatedTree = new LeanIMT((a: bigint, b: bigint) => poseidon2([a, b]));
    calculatedTree.insertMany(_leaves);

    // Step 3: Generate Merkle inclusion proof for our leaf
    const calculatedProof = calculatedTree.generateProof(_index);
    const sibs = calculatedProof.siblings.map(sib => {
      return sib.toString();
    });

    // Calculate Circuit Index to fix LeanIMT vs Noir binary_merkle_root incompatibility
    let circuitIndex = 0;
    const siblingsNum = calculatedProof.siblings.length;
    const maxIndex = 1 << siblingsNum;
    const leaf = poseidon2([BigInt(_nullifier), BigInt(_secret)]);
    let foundCircuitIndex = false;

    for (let cIndex = 0; cIndex < maxIndex; cIndex++) {
      let current = leaf;
      for (let i = 0; i < siblingsNum; i++) {
        const isRight = (cIndex >> i) & 1;
        const sibling = calculatedProof.siblings[i] as bigint;
        if (isRight) {
          current = poseidon2([sibling, current]);
        } else {
          current = poseidon2([current, sibling]);
        }
      }
      if (current === calculatedProof.root) {
        circuitIndex = cIndex;
        foundCircuitIndex = true;
        break;
      }
    }

    if (!foundCircuitIndex) {
      throw new Error("Could not find a valid circuit index for the given Merkle path.");
    }

    // Step 4: Pad siblings to fixed length 16 (circuit expects [Field; 16])
    const lengthDiff = 16 - sibs.length;
    for (let i = 0; i < lengthDiff; i++) {
      sibs.push("0");
    }

    // Step 5: Prepare circuit inputs (exact order matching main.nr)
    const input = {
      nullifier_hash: nullifierHash.toString(),
      nullifier: BigInt(_nullifier).toString(),
      secret: BigInt(_secret).toString(),
      root: _root.toString(),
      // Candidate index encoded as a Field string. Circuit range-checks to 8 bits;
      // contract enforces upper bound vs candidates.length.
      vote: BigInt(_vote).toString(),
      depth: _depth.toString(),
      index: circuitIndex.toString(),
      siblings: sibs,
    };

    // Step 6: Create witness by executing the circuit locally
    const noir = new Noir(_circuitData);
    const { witness } = await noir.execute(input);
    console.log("witness generated successfully");

    // Step 7: Generate the ZK proof using UltraHonk backend
    const honk = new UltraHonkBackend(_circuitData.bytecode, { threads: 1 });
    const originalLog = console.log;
    console.log = () => {};
    const { proof, publicInputs } = await honk.generateProof(witness, {
      keccak: true,
    });
    console.log = originalLog;
    console.log("proof generated successfully, size:", proof.length, "bytes");

    return { proof, publicInputs };
  } catch (error) {
    console.log(error);
    throw error;
  }
};

interface GenerateProofProps {
  /** Merkle leaves of the current election, oldest-first (from useLeaves()) */
  leaves?: bigint[];
}

export const GenerateProof = ({ leaves = [] }: GenerateProofProps) => {
  const [, setCircuitData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const { commitmentData, setCommitmentData, setProofData, voteChoice } = useChallengeState();
  const secretFileInputRef = useRef<HTMLInputElement>(null);

  const [nullifierInput, setNullifierInput] = useState<string>("");
  const [secretInput, setSecretInput] = useState<string>("");
  const [indexInput, setIndexInput] = useState<string>("");
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [hasLocalKey, setHasLocalKey] = useState(false);

  // Backend-agnostic chain state (services/chain).
  const { data: votingData } = useVotingData();
  const { voterId, ready: identityReady } = useVoterId();
  const voterStatus = useVoterStatus();
  const storageNamespace = useStorageNamespace();

  const root = votingData?.root;
  const treeDepth = votingData?.depth;
  const electionId = votingData?.electionId;

  const isVoter = voterStatus?.allowed;
  const hasRegistered = voterStatus?.registered;

  useEffect(() => {
    if (storageNamespace && voterId) {
      const stored = loadCommitmentFromLocalStorage(storageNamespace, voterId, electionId);
      if (stored?.secret || commitmentData?.secret) {
        setHasLocalKey(true);
      } else {
        setHasLocalKey(false);
      }
    }
  }, [storageNamespace, voterId, electionId, commitmentData]);

  const canVote = Boolean(identityReady && isVoter === true && hasRegistered === true);

  const network = useTargetNetwork();

  const getCircuitDataAndGenerateProof = async (): Promise<boolean> => {
    setIsLoading(true);
    try {
      // Ensure commitment inputs are loaded from localStorage when available
      const storedCommitment =
        storageNamespace && voterId ? loadCommitmentFromLocalStorage(storageNamespace, voterId, electionId) : null;

      // Reflect stored values in the UI if inputs are empty
      if ((!nullifierInput || !secretInput || indexInput?.trim() === "") && storedCommitment) {
        setNullifierInput(storedCommitment.nullifier);
        setSecretInput(storedCommitment.secret);
        setIndexInput(storedCommitment.index?.toString() ?? "");
      }

      const response = await fetch("/api/circuit");
      if (!response.ok) {
        throw new Error("Failed to fetch circuit data");
      }

      const fetchedCircuitData = await response.json();
      setCircuitData(fetchedCircuitData);

      const effectiveNullifier = (
        nullifierInput?.trim() ||
        commitmentData?.nullifier ||
        storedCommitment?.nullifier
      )?.trim();
      const effectiveSecret = (secretInput?.trim() || commitmentData?.secret || storedCommitment?.secret)?.trim();
      const effectiveIndex =
        indexInput?.trim() !== "" ? Number(indexInput) : (commitmentData?.index ?? storedCommitment?.index);

      if (voteChoice === null) {
        throw new Error("Please select a candidate first");
      }

      if (!leaves || leaves.length === 0) {
        throw new Error("There are no commitments in the tree yet. Please insert a commitment first.");
      }

      if (!effectiveNullifier || !effectiveSecret || effectiveIndex === undefined) {
        throw new Error(
          "Missing commitment inputs. Paste your saved data or ensure you have generated & inserted a commitment.",
        );
      }

      const generatedProof = await generateProof(
        root as bigint,
        voteChoice,
        treeDepth as unknown as number,
        effectiveNullifier,
        effectiveSecret,
        effectiveIndex as number,
        leaves,
        fetchedCircuitData,
      );
      setProofData({
        proof: generatedProof.proof,
        publicInputs: generatedProof.publicInputs,
      });

      saveProofToLocalStorage(
        { proof: generatedProof.proof, publicInputs: generatedProof.publicInputs },
        storageNamespace,
        voteChoice,
        voterId,
        electionId,
      );
      return true;
    } catch (error) {
      console.error("Error in getCircuitDataAndGenerateProof:", error);
      notification.error((error as Error).message || "Failed to generate proof");
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const handleUploadSecret = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed?.nullifier || !parsed?.secret) {
        notification.error("File is missing a nullifier or secret.");
        return;
      }
      const nullifier = toHex(BigInt(parsed.nullifier), { size: 32 });
      const secret = toHex(BigInt(parsed.secret), { size: 32 });
      const commitment = toHex(poseidon2([BigInt(parsed.nullifier), BigInt(parsed.secret)]), { size: 32 });
      const index = typeof parsed.index === "number" ? parsed.index : undefined;

      setNullifierInput(nullifier);
      setSecretInput(secret);
      setIndexInput(index?.toString() ?? "");

      const restored = { commitment, nullifier, secret, index };
      setCommitmentData(restored);
      if (index !== undefined) {
        saveCommitmentToLocalStorage({ commitment, nullifier, secret, index }, storageNamespace, voterId, electionId);
      }
      notification.success("Voter Pass restored. You can now cast your vote.");
    } catch (error) {
      console.error("Error using uploaded secret:", error);
      notification.error("Invalid Voter Pass file.");
    }
  };

  const handleSecretFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) {
      setUploadedFileName(file.name);
      void handleUploadSecret(file);
    }
  };

  return (
    <div className="bg-base-100/60 backdrop-blur-xl shadow-2xl rounded-3xl p-8 space-y-8 border border-base-300/50 hover:border-primary/30 transition-all duration-500 relative overflow-hidden">
      <VoteSelector />

      {voteChoice !== null && (
        <div className="pt-6 border-t border-base-300/50">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2 justify-center">
              {isCustomChain ? (
                <CastVoteButton
                  onGenerateProof={getCircuitDataAndGenerateProof}
                  isGenerating={isLoading}
                  canVote={canVote}
                />
              ) : (
                <>
                  {network.targetNetwork.id === hardhat.id && (
                    <VoteWithBurnerHardhat
                      onGenerateProof={getCircuitDataAndGenerateProof}
                      isGenerating={isLoading}
                      canVote={canVote}
                    />
                  )}
                  {network.targetNetwork.id === sepolia.id && (
                    <VoteWithBurnerSepolia
                      onGenerateProof={getCircuitDataAndGenerateProof}
                      isGenerating={isLoading}
                      canVote={canVote}
                    />
                  )}
                </>
              )}
            </div>

            <div className="flex flex-col gap-4 mt-4">
              {hasLocalKey && !uploadedFileName ? (
                <div className="flex flex-col items-center gap-2">
                  <div className="badge badge-success badge-outline gap-2 p-3 font-medium bg-success/5 border-success/20">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    Voter Pass Secured
                  </div>
                </div>
              ) : (
                <div className="flex justify-center">
                  {uploadedFileName ? (
                    <div className="flex items-center gap-2 bg-base-200/50 px-4 py-2 rounded-xl border border-base-300">
                      <span className="text-sm font-medium opacity-80 truncate max-w-[200px]" title={uploadedFileName}>
                        {uploadedFileName}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs btn-circle"
                        onClick={() => {
                          setUploadedFileName(null);
                          setNullifierInput("");
                          setSecretInput("");
                          setIndexInput("");
                        }}
                        title="Remove uploaded file"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => secretFileInputRef.current?.click()}
                      title="Restore your Voter Pass from a downloaded backup file"
                    >
                      Upload Voter Pass
                    </button>
                  )}
                </div>
              )}
              <input
                ref={secretFileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={handleSecretFileChange}
              />
              {!hasLocalKey && !uploadedFileName && (
                <p className="text-xs opacity-60 text-center">
                  Cleared your browser data? Upload the Voter Pass you downloaded during registration.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
