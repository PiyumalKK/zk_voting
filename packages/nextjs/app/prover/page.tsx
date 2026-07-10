"use client";

import { useEffect, useRef, useState } from "react";
import { UltraHonkBackend } from "@aztec/bb.js";
// @ts-ignore noir_js types are not always resolvable in this context
import { Noir } from "@noir-lang/noir_js";
import { toHex } from "viem";

/**
 * Headless proof generator for the native app.
 *
 * The mobile app loads this page inside a hidden WebView and posts the circuit
 * inputs to it. This page runs the SAME Barretenberg (UltraHonk, keccak) pipeline
 * the web voter UI uses, then posts the proof back. Reusing this proven code
 * guarantees the proof is byte-for-byte compatible with the on-chain HonkVerifier.
 *
 * Protocol (JSON strings):
 *   app → page : { type: "prove", id, inputs }        // inputs = CircuitInputs
 *   page → app : { type: "ready" }
 *                { type: "proof", id, proof, publicInputs }
 *                { type: "error", id, error }
 */

type ProveMessage = { type: "prove"; id: string; inputs: Record<string, unknown> };

export default function ProverPage() {
  const [status, setStatus] = useState("loading circuit…");
  const circuitRef = useRef<any>(null);

  useEffect(() => {
    const post = (msg: unknown) => {
      const data = JSON.stringify(msg);
      (window as any).ReactNativeWebView?.postMessage(data);
    };

    const loadCircuit = async () => {
      const res = await fetch("/api/circuit");
      circuitRef.current = await res.json();
      setStatus("ready");
      post({ type: "ready" });
    };

    const handleProve = async (raw: string) => {
      let msg: ProveMessage;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type !== "prove") return;

      try {
        setStatus("generating proof…");
        const circuit = circuitRef.current;
        if (!circuit) throw new Error("circuit not loaded");

        const noir = new Noir(circuit);
        const { witness } = await noir.execute(msg.inputs as any);

        const honk = new UltraHonkBackend(circuit.bytecode, { threads: 1 });
        const originalLog = console.log;
        console.log = () => {};
        const { proof, publicInputs } = await honk.generateProof(witness, { keccak: true });
        console.log = originalLog;

        post({ type: "proof", id: msg.id, proof: toHex(proof), publicInputs });
        setStatus("ready");
      } catch (e: any) {
        post({ type: "error", id: msg.id, error: e?.message ?? "proof generation failed" });
        setStatus("ready");
      }
    };

    const onMessage = (ev: MessageEvent) => handleProve(typeof ev.data === "string" ? ev.data : "");

    // window (iOS) + document (Android) — react-native-webview posts to both.
    const listener = onMessage as unknown as EventListener;
    window.addEventListener("message", listener);
    document.addEventListener("message", listener);
    loadCircuit();

    return () => {
      window.removeEventListener("message", listener);
      document.removeEventListener("message", listener);
    };
  }, []);

  return (
    <div style={{ padding: 16, fontFamily: "monospace", fontSize: 12, color: "#94A3B8", background: "#0F1B2D" }}>
      SL Vote prover — {status}
    </div>
  );
}
