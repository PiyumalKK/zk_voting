import { toHex } from "viem";
import { deriveFromSecrets } from "./crypto";

/**
 * ZK proof service.
 *
 * The circuit (main.nr) expects, in this exact order:
 *   PUBLIC : nullifier_hash, root, vote, depth
 *   PRIVATE: nullifier, secret, index, siblings[16]
 *
 * Building the witness inputs (below) is pure JS and fully correct here.
 *
 * GENERATING the proof requires the Barretenberg (Honk) prover. Options:
 *
 *   1. NATIVE (recommended, production): run Barretenberg on-device via native
 *      modules — Swoir (iOS) + noir_android (Android). See
 *      github.com/madztheo/noir-react-native-starter (supports Honk, which our
 *      HonkVerifier contract uses). Requires a custom Expo dev build
 *      (`expo prebuild` + expo-dev-client), NOT Expo Go, and the SRS bundled.
 *      Alternatively use zkmopro/mopro (Rust/UniFFI, has a React Native target).
 *
 *   2. WEBVIEW (fallback): load bb.js WASM in a hidden react-native-webview and
 *      post the proof back.
 *
 * Either way, wire the implementation through `setProofRunner()` at app start.
 * `ProofRunner` is that injection point — the crypto/flow above stays identical.
 */

export interface CircuitInputs {
  // public
  nullifier_hash: string;
  root: string;
  vote: string;
  depth: string;
  // private
  nullifier: string;
  secret: string;
  index: string;
  siblings: string[];
}

export interface VoteProofParams {
  nullifier: string;
  secret: string;
  circuitIndex: number;
  siblings: string[]; // length 16, decimal strings
  root: string; // decimal string
  candidateIndex: number;
  depth: number;
}

/** Assemble the witness inputs exactly as the Noir circuit expects them. */
export function buildCircuitInputs(p: VoteProofParams): CircuitInputs {
  const { nullifierHash } = deriveFromSecrets(p.nullifier, p.secret);
  return {
    nullifier_hash: nullifierHash,
    root: p.root,
    vote: p.candidateIndex.toString(),
    depth: p.depth.toString(),
    nullifier: p.nullifier,
    secret: p.secret,
    index: p.circuitIndex.toString(),
    siblings: p.siblings,
  };
}

export interface VoteCallData {
  proof: `0x${string}`;
  nullifierHash: `0x${string}`;
  root: `0x${string}`;
  vote: `0x${string}`;
  depth: `0x${string}`;
}

/** Convert a decimal field string to a 32-byte hex word for the contract call. */
function toBytes32(decimal: string): `0x${string}` {
  return toHex(BigInt(decimal), { size: 32 });
}

/**
 * A ProofRunner produces the raw proof bytes from circuit inputs.
 * Wire this to a WebView-based bb.js prover (see docs). Injected so the crypto
 * flow stays testable and the heavy WASM stays at the edge.
 */
export type ProofRunner = (inputs: CircuitInputs) => Promise<`0x${string}`>;

let runner: ProofRunner | null = null;

export function setProofRunner(r: ProofRunner) {
  runner = r;
}

/**
 * Generate everything the vote() contract call needs.
 * Throws a clear error if the WASM prover has not been wired yet.
 */
export async function generateVoteCallData(p: VoteProofParams): Promise<VoteCallData> {
  const inputs = buildCircuitInputs(p);

  if (!runner) {
    throw new Error(
      "ZK prover not wired. Add the WebView bb.js prover and call setProofRunner() at app start. " +
        "See src/services/zkproof.ts for the expected interface.",
    );
  }

  const proof = await runner(inputs);

  return {
    proof,
    nullifierHash: toBytes32(inputs.nullifier_hash),
    root: toBytes32(inputs.root),
    vote: toBytes32(inputs.vote),
    depth: toBytes32(inputs.depth),
  };
}
