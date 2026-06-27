"use client";

import { useEffect, useState } from "react";
import { Address } from "@scaffold-ui/components";
import { createPublicClient, createTestClient, createWalletClient, getContract, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { useAccount } from "wagmi";
import { useDeployedContractInfo, useScaffoldEventHistory, useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { useChallengeState } from "~~/services/store/challengeStore";
import {
  hasStoredProof,
  loadBurnerWalletFromLocalStorage,
  loadProofFromLocalStorage,
  saveBurnerWalletToLocalStorage,
} from "~~/utils/proofStorage";
import { notification } from "~~/utils/scaffold-eth";

type LocalProofData = {
  proof: Uint8Array;
  publicInputs: any[];
};

const sendVoteWithBurner = async ({
  viemContract,
  publicClient,
  walletAddress,
  proofData,
}: {
  viemContract: any;
  publicClient: ReturnType<typeof createPublicClient>;
  walletAddress: `0x${string}`;
  proofData: LocalProofData;
}): Promise<string> => {
  // Fund the burner wallet with enough ETH for gas (Hardhat only)
  const needed = parseEther("0.01");
  const bal = await publicClient.getBalance({ address: walletAddress });
  if (bal < needed) {
    const testClient = createTestClient({
      chain: hardhat,
      mode: "hardhat",
      transport: http("http://localhost:8545"),
    });
    await testClient.setBalance({ address: walletAddress, value: needed });
  }

  // Call vote() with proof + 4 public inputs (exact circuit order)
  const hash = await viemContract.write.vote([
    uint8ArrayToHexString(proofData.proof),
    proofData.publicInputs[0],
    proofData.publicInputs[1],
    proofData.publicInputs[2],
    proofData.publicInputs[3],
  ]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return receipt.transactionHash;
};

export const VoteWithBurnerHardhat = ({ contractAddress }: { contractAddress?: `0x${string}` }) => {
  const [burnerWallet, setBurnerWallet] = useState<{ address: `0x${string}`; privateKey: `0x${string}` } | null>(null);
  const [txStatus, setTxStatus] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [hasProofStored, setHasProofStored] = useState<boolean>(false);
  const [hasVoted, setHasVoted] = useState<boolean>(false);
  const { proofData, setProofData } = useChallengeState();
  const { address: userAddress } = useAccount();

  const generateBurnerWallet = () => {
    // Generate a fresh random wallet — no link to the registration address
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const wallet = {
      privateKey: privateKey as `0x${string}`,
      address: account.address as `0x${string}`,
    };

    setBurnerWallet(wallet);

    const effectiveContractAddress = contractAddress || contractInfo?.address;
    if (effectiveContractAddress && userAddress) {
      saveBurnerWalletToLocalStorage(wallet.privateKey, wallet.address, effectiveContractAddress, userAddress);
    }

    return wallet;
  };

  const { data: contractInfo } = useDeployedContractInfo({ contractName: "Voting" });

  const { data: electionId } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getCurrentElectionId",
  });

  const { data: votingData } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getVotingData",
  });

  const currentRoot = votingData?.[7];

  const { data: voteCastEvents } = useScaffoldEventHistory({
    contractName: "Voting",
    eventName: "VoteCast",
    watch: true,
    enabled: !!burnerWallet?.address,
  });

  useEffect(() => {
    if (burnerWallet?.address && voteCastEvents) {
      const hasVotedAlready = voteCastEvents.some(
        event => event.args?.voter?.toLowerCase() === burnerWallet.address.toLowerCase(),
      );
      setHasVoted(hasVotedAlready);
    } else {
      setHasVoted(false);
    }
  }, [burnerWallet?.address, voteCastEvents]);

  useEffect(() => {
    const checkAndLoadStoredProof = () => {
      const effectiveContractAddress = contractAddress || contractInfo?.address;
      if (effectiveContractAddress && userAddress) {
        const proofExists = hasStoredProof(effectiveContractAddress, userAddress, electionId);
        setHasProofStored(proofExists);

        if (proofExists && !proofData) {
          try {
            const storedProof = loadProofFromLocalStorage(effectiveContractAddress, userAddress, electionId);
            if (storedProof) {
              setProofData(storedProof);
            }
          } catch (error) {
            console.error("Error auto-loading proof:", error);
          }
        }
      } else {
        setHasProofStored(false);
      }
    };

    checkAndLoadStoredProof();
  }, [contractAddress, contractInfo?.address, userAddress, proofData, setProofData, electionId]);

  useEffect(() => {
    const effectiveContractAddress = contractAddress || contractInfo?.address;
    if (effectiveContractAddress && userAddress) {
      try {
        const storedBurnerWallet = loadBurnerWalletFromLocalStorage(effectiveContractAddress, userAddress);
        if (storedBurnerWallet) {
          const account = privateKeyToAccount(storedBurnerWallet.privateKey as `0x${string}`);
          setBurnerWallet({
            privateKey: storedBurnerWallet.privateKey as `0x${string}`,
            address: account.address as `0x${string}`,
          });
        } else {
          setBurnerWallet(null);
        }
      } catch (error) {
        console.error("Error auto-loading burner wallet:", error);
        setBurnerWallet(null);
      }
    } else {
      setBurnerWallet(null);
    }
  }, [contractAddress, contractInfo?.address, userAddress]);

  return (
    <div className="bg-base-100 shadow-lg rounded-2xl p-6 space-y-4 border border-base-300/50 hover-lift">
      <div className="space-y-1 text-center">
        <h2 className="text-2xl font-bold">Vote</h2>
        <p className="text-sm opacity-60">Use a local burner wallet to submit the on-chain vote with the proof.</p>
      </div>

      {burnerWallet && (
        <div className="flex items-center gap-2 justify-center">
          <span className="text-sm">Burner Wallet:</span>
          <Address address={burnerWallet.address} />
        </div>
      )}

      <div className="flex justify-center">
        <button
          className={`btn btn-primary ${!hasProofStored || !proofData || txStatus === "pending" || hasVoted ? "" : "shadow-lg shadow-primary/25"}`}
          disabled={!hasProofStored || !proofData || txStatus === "pending" || hasVoted}
          onClick={async () => {
            try {
              if (!proofData) {
                console.error("Please generate proof first");
                return;
              }

              // The contract requires the proof's root to match the current on-chain
              // tree root. If the voter set changed or the contract was redeployed/reset
              // after this proof was made, the root won't match and vote() reverts.
              const proofRoot = proofData.publicInputs?.[1];
              if (currentRoot !== undefined && proofRoot !== undefined) {
                try {
                  if (BigInt(proofRoot as string) !== BigInt(currentRoot as bigint)) {
                    notification.error(
                      "This proof is stale: its Merkle root no longer matches the current voter tree. " +
                        "Upload your secret on the proof page and regenerate the proof, then try again.",
                    );
                    return;
                  }
                } catch {
                  // If comparison fails for any reason, fall through and let the chain decide.
                }
              }

              setTxStatus("pending");

              const wallet = burnerWallet ?? generateBurnerWallet();
              const publicClient = createPublicClient({ chain: hardhat, transport: http("http://localhost:8545") });
              const address = (contractAddress || contractInfo?.address) as string | undefined;
              if (!address) throw new Error("Contract not found");
              const abi = (contractInfo?.abi as any) || [];
              const voterClient = createWalletClient({
                account: privateKeyToAccount(wallet.privateKey),
                chain: hardhat,
                transport: http("http://localhost:8545"),
              });
              const viemContract = getContract({ address: address as `0x${string}`, abi, client: voterClient });

              await sendVoteWithBurner({
                viemContract,
                publicClient,
                walletAddress: wallet.address,
                proofData: proofData as LocalProofData,
              });

              setTxStatus("success");
            } catch (e) {
              console.error("Error voting:", e);
              const err = e as { shortMessage?: string; message?: string };
              const raw = `${err?.shortMessage ?? ""} ${err?.message ?? ""}`;
              let friendly = err?.shortMessage || err?.message || "Vote transaction failed";
              if (raw.includes("NullifierHashAlreadyUsed")) {
                friendly = "You have already voted with this identity.";
                setHasVoted(true);
              } else if (raw.includes("InvalidRoot")) {
                friendly =
                  "This proof is stale: its Merkle root no longer matches the current voter tree. " +
                  "Upload your secret on the proof page and regenerate the proof.";
              } else if (raw.includes("InvalidProof")) {
                friendly = "The proof is invalid for the current election. Regenerate it from your secret.";
              } else if (raw.includes("WrongPhase")) {
                friendly = "Voting is not open right now.";
              } else if (raw.includes("InvalidCandidate")) {
                friendly = "The selected candidate is invalid.";
              } else if (raw.includes("EmptyTree")) {
                friendly = "No one has registered yet, so there is nothing to vote against.";
              }
              notification.error(friendly);
              setTxStatus("error");
            }
          }}
        >
          {txStatus === "pending" ? "Voting..." : hasVoted ? "Already voted" : "Vote with burner wallet"}
        </button>
      </div>
    </div>
  );
};

const uint8ArrayToHexString = (buffer: Uint8Array): `0x${string}` => {
  const hex: string[] = [];
  buffer.forEach(function (i) {
    let h = i.toString(16);
    if (h.length % 2) {
      h = "0" + h;
    }
    hex.push(h);
  });
  return `0x${hex.join("")}`;
};
