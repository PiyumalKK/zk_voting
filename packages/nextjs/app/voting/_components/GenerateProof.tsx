"use client";

import { useRef, useState } from "react";
import { UltraHonkBackend } from "@aztec/bb.js";
// @ts-ignore
import { Noir } from "@noir-lang/noir_js";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon1, poseidon2 } from "poseidon-lite";
import { encodeAbiParameters, toHex } from "viem";
import { useAccount } from "wagmi";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { useChallengeState } from "~~/services/store/challengeStore";
import {
  hasStoredProof,
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
  _leaves: any[],
  _circuitData: any,
) => {
  try {
    // Step 1: Compute nullifier hash (matches circuit's hash_1([nullifier]))
    const nullifierHash = poseidon1([BigInt(_nullifier)]);

    // Step 2: Rebuild the Merkle tree from on-chain leaf events
    const calculatedTree = new LeanIMT((a: bigint, b: bigint) => poseidon2([a, b]));
    const leaves = _leaves.map(event => {
      return event?.args.value;
    });
    // Events are newest-first, tree needs oldest-first
    const leavesReversed = leaves.reverse();
    calculatedTree.insertMany(leavesReversed as bigint[]);

    // Step 3: Generate Merkle inclusion proof for our leaf
    const calculatedProof = calculatedTree.generateProof(_index);
    const sibs = calculatedProof.siblings.map(sib => {
      return sib.toString();
    });

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
      index: _index.toString(),
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

    // Step 8: Format for Solidity — encode proof + publicInputs as ABI params
    const proofHex = toHex(proof);
    const inputsHex = publicInputs.map(x =>
      typeof x === "string" ? (x as `0x${string}`) : toHex(x as Uint8Array, { size: 32 }),
    );
    const result = encodeAbiParameters([{ type: "bytes" }, { type: "bytes32[]" }], [proofHex, inputsHex]);
    console.log("encoded result for Solidity:", result.slice(0, 66) + "...");

    return { proof, publicInputs };
  } catch (error) {
    console.log(error);
    throw error;
  }
};

interface CreateCommitmentProps {
  leafEvents?: any[];
}

export const GenerateProof = ({ leafEvents = [] }: CreateCommitmentProps) => {
  const [, setCircuitData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const { commitmentData, setCommitmentData, proofData, setProofData, voteChoice } = useChallengeState();
  const { address: userAddress, isConnected } = useAccount();
  const { data: deployedContractData } = useDeployedContractInfo({ contractName: "Voting" });
  const proofFileInputRef = useRef<HTMLInputElement>(null);
  const secretFileInputRef = useRef<HTMLInputElement>(null);

  const [nullifierInput, setNullifierInput] = useState<string>("");
  const [secretInput, setSecretInput] = useState<string>("");
  const [indexInput, setIndexInput] = useState<string>("");

  const { data: votingData } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getVotingData",
  });

  const root = votingData?.[7];
  const treeDepth = votingData?.[6];

  const { data: electionId } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getCurrentElectionId",
  });

  const { data: voterData } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getVoterData",
    args: [userAddress as `0x${string}`],
  });

  const isVoter = voterData?.[0];
  const hasRegistered = voterData?.[1];

  const canVote = Boolean(isConnected && isVoter === true && hasRegistered === true);

  const hasExistingProof = hasStoredProof(deployedContractData?.address, userAddress, electionId);

  const getCircuitDataAndGenerateProof = async () => {
    setIsLoading(true);
    try {
      // Ensure commitment inputs are loaded from localStorage when available
      const storedCommitment =
        deployedContractData?.address && userAddress
          ? loadCommitmentFromLocalStorage(deployedContractData.address, userAddress, electionId)
          : null;

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

      if (!leafEvents || leafEvents.length === 0) {
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
        leafEvents as any,
        fetchedCircuitData,
      );
      setProofData({
        proof: generatedProof.proof,
        publicInputs: generatedProof.publicInputs,
      });

      saveProofToLocalStorage(
        { proof: generatedProof.proof, publicInputs: generatedProof.publicInputs },
        deployedContractData?.address,
        voteChoice,
        userAddress,
        electionId,
      );
    } catch (error) {
      console.error("Error in getCircuitDataAndGenerateProof:", error);
      notification.error((error as Error).message || "Failed to generate proof");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownloadProof = () => {
    if (!proofData) {
      notification.error("Generate or load a proof first.");
      return;
    }
    const payload = {
      proof: Array.from(proofData.proof),
      publicInputs: proofData.publicInputs,
      electionId: electionId?.toString(),
      root: (root as bigint | undefined)?.toString(),
      contractAddress: deployedContractData?.address,
      savedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `zk-voting-proof-election-${electionId?.toString() ?? "x"}.json`;
    link.click();
    URL.revokeObjectURL(url);
    notification.success("Proof downloaded.");
  };

  const handleUploadProof = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed?.proof) || !Array.isArray(parsed?.publicInputs)) {
        notification.error("File is not a valid proof.");
        return;
      }
      const restored = { proof: new Uint8Array(parsed.proof), publicInputs: parsed.publicInputs };
      setProofData(restored);
      saveProofToLocalStorage(
        restored,
        deployedContractData?.address,
        voteChoice ?? undefined,
        userAddress,
        electionId,
      );
      notification.success("Proof loaded. You can now cast your vote.");
    } catch (error) {
      console.error("Error using uploaded proof:", error);
      notification.error("Invalid proof file.");
    }
  };

  const handleProofFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void handleUploadProof(file);
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
        saveCommitmentToLocalStorage(
          { commitment, nullifier, secret, index },
          deployedContractData?.address,
          userAddress,
          electionId,
        );
      }
      notification.success("Secret restored. You can now generate your proof.");
    } catch (error) {
      console.error("Error using uploaded secret:", error);
      notification.error("Invalid secret file.");
    }
  };

  const handleSecretFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void handleUploadSecret(file);
  };

  return (
    <div className="bg-base-100 shadow-lg rounded-2xl p-6 space-y-5 border border-base-300/50 hover-lift">
      <div className="space-y-1">
        <h2 className="text-2xl font-bold text-center"> Generate ZK proof off-chain </h2>
        <p className="text-sm opacity-60">
          Prove membership in the Merkle tree and add your voting decision to the proof.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2 justify-center">
          <button
            type="button"
            className={`btn ${canVote && !hasExistingProof && voteChoice !== null ? "btn-primary shadow-lg shadow-primary/25" : "btn-disabled"}`}
            onClick={canVote && !hasExistingProof && voteChoice !== null ? getCircuitDataAndGenerateProof : undefined}
            disabled={isLoading || !canVote || hasExistingProof || voteChoice === null}
          >
            {isLoading
              ? "Generating proof..."
              : hasExistingProof
                ? "Proof already exists"
                : !canVote
                  ? "Must register first"
                  : voteChoice === null
                    ? "Select choice first"
                    : "Generate proof"}
          </button>
        </div>

        <div className="flex justify-center">
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => secretFileInputRef.current?.click()}
            title="Restore your secret and nullifier from a downloaded backup file"
          >
            Upload secret to generate proof
          </button>
          <input
            ref={secretFileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleSecretFileChange}
          />
        </div>
        <p className="text-xs opacity-60 text-center">
          Cleared your browser data? Upload the secret file you downloaded during registration to regenerate your proof.
        </p>

        <div className="flex flex-col sm:flex-row gap-2 justify-center">
          <button
            type="button"
            className="btn btn-outline btn-sm flex-1"
            onClick={() => proofFileInputRef.current?.click()}
            title="Load a previously downloaded proof file"
          >
            Upload proof
          </button>
          <button
            type="button"
            className="btn btn-outline btn-sm flex-1"
            onClick={handleDownloadProof}
            disabled={!proofData}
            title="Download your generated proof as a backup file"
          >
            Download proof
          </button>
          <input
            ref={proofFileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleProofFileChange}
          />
        </div>
      </div>
    </div>
  );
};
