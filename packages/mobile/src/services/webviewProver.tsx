import { useEffect, useRef } from "react";
import { View } from "react-native";
import { WebView, WebViewMessageEvent } from "react-native-webview";
import { CONFIG } from "../config";
import { CircuitInputs, setProofRunner } from "./zkproof";

/**
 * WebView-based ZK prover.
 *
 * Mounts a hidden WebView that loads the web app's headless `/prover` page and
 * runs the SAME Barretenberg (UltraHonk, keccak) pipeline the browser voter UI
 * uses. This reuses the proven proof code verbatim, so the output is guaranteed
 * compatible with the on-chain HonkVerifier — and it works in Expo Go (no native
 * modules, no dev build).
 *
 * bb.js already returns the proof WITHOUT public inputs, which is exactly what
 * `vote()` expects for `_proof`, so no stripping is needed here.
 *
 * Trade-off vs native: slower (WASM in a WebView) and needs the app reachable.
 * For production scale, switch to the native prover (see nativeProver.ts).
 */

type Pending = { resolve: (proof: `0x${string}`) => void; reject: (e: Error) => void };

const pending = new Map<string, Pending>();
const readyWaiters: (() => void)[] = [];
let isReady = false;
let poster: ((json: string) => void) | null = null;

function waitReady(): Promise<void> {
  if (isReady) return Promise.resolve();
  return new Promise(res => readyWaiters.push(res));
}

const webviewRunner = async (inputs: CircuitInputs): Promise<`0x${string}`> => {
  await waitReady();
  if (!poster) throw new Error("Prover WebView is not mounted");
  const id = Math.random().toString(36).slice(2);
  const promise = new Promise<`0x${string}`>((resolve, reject) => pending.set(id, { resolve, reject }));
  poster(JSON.stringify({ type: "prove", id, inputs }));
  return promise;
};

/**
 * Hidden WebView host. Mount once near the app root. Registers the WebView proof
 * runner while mounted.
 */
export function ProverWebView() {
  const ref = useRef<WebView>(null);

  useEffect(() => {
    poster = (json: string) => ref.current?.postMessage(json);
    setProofRunner(webviewRunner);
    return () => {
      poster = null;
      isReady = false;
    };
  }, []);

  const onMessage = (event: WebViewMessageEvent) => {
    let msg: any;
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.type === "ready") {
      isReady = true;
      readyWaiters.splice(0).forEach(w => w());
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.type === "proof") entry.resolve(msg.proof as `0x${string}`);
    else entry.reject(new Error(msg.error ?? "Proof generation failed"));
  };

  return (
    <View style={{ width: 0, height: 0, position: "absolute", opacity: 0 }} pointerEvents="none">
      <WebView
        ref={ref}
        source={{ uri: `${CONFIG.apiBaseUrl}/prover` }}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={["*"]}
        // bb.js is heavy — give the WebView room and keep it alive in background.
        androidLayerType="hardware"
      />
    </View>
  );
}
