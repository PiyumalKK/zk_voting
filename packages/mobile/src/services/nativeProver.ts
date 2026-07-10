import { NativeModules, Platform } from "react-native";
import { CONFIG } from "../config";
import type { CircuitInputs, ProofRunner } from "./zkproof";
import { setProofRunner } from "./zkproof";

/**
 * Native on-device prover — wires the app's `setProofRunner()` to a native
 * Barretenberg/Noir module (Swoir on iOS, noir_android on Android), following
 * github.com/madztheo/noir-react-native-starter.
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ REQUIRES A CUSTOM DEV BUILD — this does NOT work in Expo Go.            │
 * │   1. npx expo prebuild                                                  │
 * │   2. Add the native modules:                                           │
 * │        iOS     → Swoir / SwoirCore / Swoirenberg (Swift PM) + pod install│
 * │        Android → noir_android via Jitpack in android/app/build.gradle   │
 * │   3. Bundle the SRS (~50 MB chunk) in ios/ and android/app/src/main/res/raw│
 * │   4. Build with expo-dev-client (or EAS Build).                        │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * The native module exposes (via NativeModules.NoirModule):
 *   prepareSrs()                              // Android only
 *   setupCircuit(json, size, lowMem) → {circuitId}
 *   generateVkey(circuitId) → {vkey}
 *   prove(inputs, circuitId, vkey) → {proof}  // proofWithPublicInputs
 *
 * ⚠️ SOLIDITY COMPATIBILITY: our on-chain HonkVerifier expects the **keccak**
 * flavour of the Honk proof (the web app uses `UltraHonkBackend.generateProof(
 * witness, { keccak: true })`). Ensure the native module is built with the
 * keccak transcript (Swoir/noir_android expose this; mopro's noir-rs likewise).
 * A non-keccak proof will be REJECTED by the Solidity verifier.
 *
 * ⚠️ PROOF FORMAT: `vote()` takes the raw proof bytes WITHOUT public inputs
 * (it rebuilds the 4 public inputs on-chain). bb.js already returns them
 * separated; the native module returns `proofWithPublicInputs`, so we strip the
 * leading public-input words here. Verify the offset against your circuit's
 * public-input count (4 fields → 4 × 32 bytes) on first run.
 */

interface NoirNativeModule {
  prepareSrs(): Promise<void>;
  setupCircuit(circuitJson: string, size: number, lowMemoryMode: boolean): Promise<{ circuitId: string }>;
  generateVkey(circuitId: string): Promise<{ vkey: string }>;
  prove(inputs: Record<string, unknown>, circuitId: string, vkey: string): Promise<{ proof: string }>;
}

const Noir = NativeModules.NoirModule as NoirNativeModule | undefined;

// Number of PUBLIC field elements in the circuit (nullifier_hash, root, vote, depth).
const PUBLIC_INPUT_COUNT = 4;
const FIELD_HEX_LEN = 64; // 32 bytes as hex

let cached: { circuitId: string; vkey: string } | null = null;

/** One-time per-app-launch circuit setup (SRS + circuit + verification key). */
async function ensureCircuit(): Promise<{ circuitId: string; vkey: string }> {
  if (!Noir) {
    throw new Error(
      "NoirModule native module not found. You are likely running in Expo Go. " +
        "Run `npx expo prebuild` and build a dev client with the Swoir / noir_android modules.",
    );
  }
  if (cached) return cached;

  if (Platform.OS === "android") {
    await Noir.prepareSrs();
  }

  // Load the compiled Noir circuit JSON from the backend (same source the WebView
  // prover uses). Fetching avoids statically bundling the ~800 KB circuit and keeps
  // the Metro graph clean for the WebView-only path.
  const res = await fetch(`${CONFIG.apiBaseUrl}/api/circuit`);
  if (!res.ok) throw new Error("Could not load circuit from the backend");
  const circuit = await res.json();
  const { circuitId } = await Noir.setupCircuit(JSON.stringify(circuit), 1 << 20, false);
  const { vkey } = await Noir.generateVkey(circuitId);
  cached = { circuitId, vkey };
  return cached;
}

/**
 * Strip the public inputs from `proofWithPublicInputs` to get the raw proof the
 * Solidity verifier expects. For keccak-Honk the public inputs are the first
 * `PUBLIC_INPUT_COUNT` 32-byte words after the proof header.
 *
 * NOTE: confirm this offset on first integration — Honk proof layout has been
 * known to shift between bb versions. If verification fails on-chain, log the
 * proof hex and compare against the web app's `honk.generateProof(...).proof`.
 */
function toRawProofHex(proofWithPublicInputs: string): `0x${string}` {
  const hex = proofWithPublicInputs.startsWith("0x") ? proofWithPublicInputs.slice(2) : proofWithPublicInputs;
  const publicInputsLen = PUBLIC_INPUT_COUNT * FIELD_HEX_LEN;
  // Layout: [4-byte length prefix (8 hex)] [public inputs] [proof]
  const raw = hex.slice(8 + publicInputsLen);
  return `0x${raw}`;
}

const nativeRunner: ProofRunner = async (inputs: CircuitInputs) => {
  const { circuitId, vkey } = await ensureCircuit();
  if (!Noir) throw new Error("NoirModule native module not found");
  // The native prover takes the same input object shape the circuit expects.
  const { proof } = await Noir.prove(inputs as unknown as Record<string, unknown>, circuitId, vkey);
  return toRawProofHex(proof);
};

/** Call once at app start (e.g. in app/_layout.tsx) to enable on-device proving. */
export function registerNativeProver() {
  setProofRunner(nativeRunner);
}

export function isNativeProverAvailable(): boolean {
  return !!Noir;
}
