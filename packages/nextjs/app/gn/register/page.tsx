"use client";

import { useEffect, useRef, useState } from "react";
import { NextPage } from "next";
import { createPublicClient, http } from "viem";
import { hardhat } from "viem/chains";
import { useAccount } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { findDivisionForGN, useDivisions } from "~~/hooks/useDivisions";
import { wagmiConfig } from "~~/services/web3/wagmiConfig";
import { notification } from "~~/utils/scaffold-eth";

const publicClient = createPublicClient({ chain: hardhat, transport: http("http://127.0.0.1:8545") });

const VOTING_ABI = [
  { name: "s_gnOfficer", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    name: "addVoters",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "voters", type: "address[]" },
      { name: "statuses", type: "bool[]" },
    ],
    outputs: [],
  },
] as const;

type Step = 1 | 2 | 3 | 4;

const GNRegisterVoter: NextPage = () => {
  const [step, setStep] = useState<Step>(1);
  const [voterNIC, setVoterNIC] = useState("");
  const [voterAddress, setVoterAddress] = useState("");
  const [voterPhone, setVoterPhone] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [scanning, setScanning] = useState(false);

  const { address, isConnected } = useAccount();
  const { divisions, isLoading } = useDivisions();
  const myDivision = findDivisionForGN(divisions, address) ?? null;

  // NIC validation (Sri Lankan format)
  const validateNIC = (nic: string): boolean => {
    const oldFormat = /^\d{9}[VvXx]$/;
    const newFormat = /^\d{12}$/;
    return oldFormat.test(nic) || newFormat.test(nic);
  };

  const handleVerifyNIC = () => {
    if (!validateNIC(voterNIC)) {
      notification.error("Invalid NIC format. Use 9 digits + V/X or 12-digit new format.");
      return;
    }
    notification.success("NIC validated ✓");
    setStep(2);
  };

  // QR Scanner
  const startQRScan = async () => {
    try {
      setScanning(true);
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
      if ("BarcodeDetector" in window) {
        const detector = new (window as any).BarcodeDetector({ formats: ["qr_code"] });
        const scanInterval = setInterval(async () => {
          if (videoRef.current && videoRef.current.readyState === videoRef.current.HAVE_ENOUGH_DATA) {
            try {
              const barcodes = await detector.detect(videoRef.current);
              if (barcodes.length > 0) {
                handleQRResult(barcodes[0].rawValue);
                clearInterval(scanInterval);
                stopCamera();
              }
            } catch {}
          }
        }, 300);
      }
    } catch {
      notification.error("Camera access denied.");
      setScanning(false);
    }
  };

  const stopCamera = () => {
    if (videoRef.current?.srcObject) {
      (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      videoRef.current.srcObject = null;
    }
    setScanning(false);
  };

  const handleQRResult = (data: string) => {
    try {
      const parsed = JSON.parse(data);
      if (parsed.address?.startsWith("0x")) {
        setVoterAddress(parsed.address);
        notification.success(`Address scanned: ${parsed.address.slice(0, 10)}...`);
        setStep(3);
        return;
      }
    } catch {}
    if (data.startsWith("0x") && data.length === 42) {
      setVoterAddress(data);
      notification.success(`Address scanned: ${data.slice(0, 10)}...`);
      setStep(3);
    } else {
      notification.error("Invalid QR code");
    }
  };

  const handleManualAddress = () => {
    if (!voterAddress.startsWith("0x") || voterAddress.length !== 42) {
      notification.error("Invalid address. Must be 0x... (42 chars)");
      return;
    }
    setStep(3);
  };

  // Submit: call addVoters on the CORRECT division contract via connected wallet
  const handleSubmit = async () => {
    if (!voterAddress || !voterPhone || !myDivision) return;

    setIsSubmitting(true);
    try {
      const walletClient = await getWalletClient(wagmiConfig);
      if (!walletClient) {
        notification.error("Wallet not connected.");
        return;
      }

      const hash = await walletClient.writeContract({
        address: myDivision.votingContract,
        abi: VOTING_ABI,
        functionName: "addVoters",
        args: [[voterAddress as `0x${string}`], [true]],
      });

      await publicClient.waitForTransactionReceipt({ hash });
      notification.success(`✅ Voter added to ${myDivision.name}!`);
      setStep(4);
    } catch (error: any) {
      const msg = error?.shortMessage || error?.message || "Transaction failed";
      if (msg.includes("Not owner or GN")) {
        notification.error("You are not authorized as GN for this division.");
      } else if (msg.includes("Cannot add voters now")) {
        notification.error("Cannot add voters in current phase (Voting or Ended).");
      } else {
        notification.error(msg);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setStep(1);
    setVoterNIC("");
    setVoterAddress("");
    setVoterPhone("");
  };

  useEffect(() => {
    return () => stopCamera();
  }, []);

  // Access gate: must be connected + must be a GN
  if (!isConnected) {
    return <CenterMessage icon="🔒" title="Connect Wallet" subtitle="Connect your wallet to access the GN portal." />;
  }
  if (isLoading) {
    return <CenterMessage icon="⏳" title="Checking authorization" subtitle="Reading your GN status from chain…" />;
  }
  if (!myDivision) {
    return (
      <CenterMessage
        icon="🚫"
        title="Not Authorized"
        subtitle={`Your address (${address?.slice(0, 10)}...) is not assigned as GN for any division.`}
      />
    );
  }

  return (
    <div className="flex flex-col items-center grow pt-8 px-4">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold">Register Voter</h1>
          <p className="text-sm text-primary font-semibold">{myDivision.name} Division</p>
          <p className="text-xs opacity-50 mt-1">
            Step {step}/4 — {["Verify NIC", "Scan Address", "Confirm", "Done"][step - 1]}
          </p>
          <div className="flex gap-1 mt-3 justify-center">
            {[1, 2, 3, 4].map(s => (
              <div
                key={`step-${s}`}
                className={`h-1.5 w-16 rounded-full transition-all ${s <= step ? "bg-primary" : "bg-base-300"}`}
              />
            ))}
          </div>
        </div>

        {/* Step 1: NIC */}
        {step === 1 && (
          <Card>
            <h3 className="font-bold mb-4">🪪 Verify Voter NIC</h3>
            <input
              type="text"
              placeholder="e.g., 200012345678 or 912345678V"
              className="input input-bordered w-full mb-2"
              value={voterNIC}
              onChange={e => setVoterNIC(e.target.value.trim())}
              maxLength={12}
            />
            <p className="text-xs opacity-50 mb-4">Old format: 9 digits + V/X · New: 12 digits</p>
            <button className="btn btn-primary w-full" onClick={handleVerifyNIC} disabled={!voterNIC}>
              Verify NIC →
            </button>
          </Card>
        )}

        {/* Step 2: Scan QR */}
        {step === 2 && (
          <Card>
            <h3 className="font-bold mb-4">📷 Scan Voter&apos;s Address QR</h3>
            <p className="text-sm opacity-60 mb-4">Ask voter to show the QR code from their app.</p>

            {scanning ? (
              <div className="relative rounded-xl overflow-hidden mb-4">
                <video ref={videoRef} className="w-full rounded-xl" autoPlay playsInline muted />
                <div className="absolute inset-0 border-4 border-primary/50 rounded-xl pointer-events-none" />
                <button className="btn btn-sm btn-error absolute top-2 right-2" onClick={stopCamera}>
                  Stop
                </button>
              </div>
            ) : (
              <button className="btn btn-primary w-full mb-4" onClick={startQRScan}>
                📷 Open Camera
              </button>
            )}

            <div className="divider text-xs opacity-50">OR paste manually</div>
            <input
              type="text"
              placeholder="0x..."
              className="input input-bordered w-full font-mono text-sm mb-3"
              value={voterAddress}
              onChange={e => setVoterAddress(e.target.value.trim())}
            />
            <button className="btn btn-outline w-full" onClick={handleManualAddress} disabled={!voterAddress}>
              Use Address →
            </button>
          </Card>
        )}

        {/* Step 3: Confirm */}
        {step === 3 && (
          <Card>
            <h3 className="font-bold mb-4">✅ Confirm & Register</h3>
            <div className="space-y-2 mb-4">
              <InfoRow label="Division" value={myDivision.name} />
              <InfoRow label="NIC" value={voterNIC} />
              <InfoRow label="Address" value={`${voterAddress.slice(0, 10)}...${voterAddress.slice(-6)}`} />
            </div>
            <input
              type="tel"
              placeholder="Phone: +94 77 123 4567"
              className="input input-bordered w-full mb-4"
              value={voterPhone}
              onChange={e => setVoterPhone(e.target.value)}
            />
            <button
              className={`btn btn-primary w-full ${isSubmitting ? "loading" : ""}`}
              onClick={handleSubmit}
              disabled={isSubmitting || !voterPhone}
            >
              {isSubmitting ? "Adding to Blockchain..." : "Add to Voter Roll →"}
            </button>
          </Card>
        )}

        {/* Step 4: Success */}
        {step === 4 && (
          <Card>
            <div className="text-center">
              <div className="text-5xl mb-4">✅</div>
              <h3 className="font-bold text-xl mb-2">Voter Enrolled!</h3>
              <p className="text-sm opacity-60 mb-1">
                {voterAddress.slice(0, 14)}... added to <strong>{myDivision.name}</strong>
              </p>
              <p className="text-xs opacity-40 mb-6">
                NIC: {voterNIC} · Phone: {voterPhone}
              </p>
              <button className="btn btn-primary" onClick={resetForm}>
                Register Next Voter →
              </button>
            </div>
          </Card>
        )}

        {/* Back */}
        {step > 1 && step < 4 && (
          <button className="btn btn-ghost btn-sm mt-4 w-full" onClick={() => setStep((step - 1) as Step)}>
            ← Back
          </button>
        )}
      </div>
    </div>
  );
};

export default GNRegisterVoter;

// --- Helper components ---
const Card = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-base-100 rounded-2xl p-6 shadow-md border border-base-300/50">{children}</div>
);

const InfoRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between items-center p-3 bg-base-200/50 rounded-lg">
    <span className="text-sm opacity-60">{label}</span>
    <span className="font-mono text-sm font-bold">{value}</span>
  </div>
);

const CenterMessage = ({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) => (
  <div className="flex flex-col items-center grow pt-16 px-4 text-center">
    <div className="text-5xl mb-4">{icon}</div>
    <h1 className="text-2xl font-bold mb-2">{title}</h1>
    <p className="opacity-60 max-w-md">{subtitle}</p>
  </div>
);
