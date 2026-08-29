"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CopyButton } from "./CopyButton";
import { AbiFunction, AbiParameter, Address, PublicClient } from "viem";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { createBlockExplorerClient } from "~~/hooks/scaffold-eth/useFetchBlocks";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import type { HydratedContract } from "~~/utils/blockexplorer/contractSources";

/**
 * Functions worth surfacing first — the ones that make the election auditable.
 * Anything not listed still appears, just below these.
 *
 * Names are the ones actually present in the ABIs. In particular the NIC epoch
 * is `NicRegistry.getCurrentEpoch()`; there is no `getNicEpoch` on any deployed
 * contract, so highlighting that name would have matched nothing.
 */
const HIGHLIGHTED_FUNCTIONS = new Set([
  // Voting
  "currentPhase",
  "getCandidates",
  "getVoteCounts",
  "getVoterData",
  "isNullifierUsed",
  "getCurrentElectionId",
  // NicRegistry — double-registration defence
  "getCurrentEpoch",
  "isNicHashUsed",
  // ElectionRegistry — the aggregate anyone auditing a result starts from
  "getNationalResults",
  "getDivisionResults",
  "getAllDivisions",
  "getDivisionCount",
]);

/** Renders a solidity type list as `(uint256, string)` for the return signature. */
const formatTypeList = (params: readonly AbiParameter[]): string =>
  params.map(p => `${p.type}${p.name ? ` ${p.name}` : ""}`).join(", ");

/**
 * Converts a raw text input into the JS value viem expects for `type`.
 * Throws with a readable message so the field can show why a query was rejected.
 */
const parseArgument = (type: string, raw: string): unknown => {
  const value = raw.trim();

  if (type.endsWith("]") || type.startsWith("tuple")) {
    // Arrays and structs are entered as JSON. `bigint` is not JSON-representable,
    // so numeric strings inside integer arrays are converted after parsing.
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`Expected JSON for ${type}, e.g. [1, 2]`);
    }
    if (Array.isArray(parsed) && /^u?int/.test(type)) {
      return parsed.map(item => (typeof item === "string" || typeof item === "number" ? BigInt(item) : item));
    }
    return parsed;
  }

  if (/^u?int/.test(type)) {
    if (value === "") throw new Error("Enter a number");
    try {
      return BigInt(value);
    } catch {
      throw new Error(`"${value}" is not a valid integer`);
    }
  }

  if (type === "bool") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error('Enter "true" or "false"');
  }

  if (type === "address") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("Enter a 20-byte 0x address");
    return value as Address;
  }

  if (type.startsWith("bytes")) {
    if (!/^0x[0-9a-fA-F]*$/.test(value)) throw new Error("Enter a 0x-prefixed hex string");
    const fixedSize = /^bytes(\d+)$/.exec(type);
    if (fixedSize) {
      const expected = Number(fixedSize[1]) * 2 + 2;
      if (value.length !== expected) throw new Error(`${type} must be ${expected - 2} hex characters`);
    }
    return value;
  }

  return value;
};

/**
 * Renders a returned value. Handles the shapes this system's reads actually
 * produce: bigints (vote counts, epochs), structs returned as objects, and
 * arrays (candidates, tallies).
 */
const formatResult = (value: unknown, depth = 0): string => {
  if (value === null || value === undefined) return "—";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (depth > 2) return "[…]";
    return `[\n${value.map(v => `  ${formatResult(v, depth + 1)}`).join(",\n")}\n]`;
  }
  if (typeof value === "object") {
    return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  }
  return String(value);
};

type QueryState = {
  status: "idle" | "loading" | "success" | "error";
  value?: unknown;
  error?: string;
};

const FunctionCard = ({
  fn,
  client,
  address,
  abi,
  highlighted,
}: {
  fn: AbiFunction;
  client: PublicClient;
  address: Address;
  abi: HydratedContract["abi"];
  highlighted: boolean;
}) => {
  const [inputs, setInputs] = useState<string[]>(() => fn.inputs.map(() => ""));
  const [state, setState] = useState<QueryState>({ status: "idle" });

  const query = useCallback(async () => {
    setState({ status: "loading" });
    let args: unknown[];
    try {
      args = fn.inputs.map((input, i) => parseArgument(input.type, inputs[i] ?? ""));
    } catch (error) {
      setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
      return;
    }

    try {
      const value = await client.readContract({ address, abi, functionName: fn.name, args });
      setState({ status: "success", value });
    } catch (error) {
      // Contract reverts are normal here (e.g. querying a voter that does not
      // exist), so the message is shown in place rather than thrown away.
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      setState({ status: "error", error: message });
    }
  }, [abi, address, client, fn, inputs]);

  // Zero-argument reads are unambiguous, so they resolve on mount — the current
  // phase or tally is visible without the reader having to press anything.
  useEffect(() => {
    if (fn.inputs.length === 0) query();
    // `query` is stable for a zero-arg function: it closes over an empty input list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`border rounded-lg p-4 bg-base-100 ${highlighted ? "border-primary/50 shadow-sm" : "border-base-300"}`}
    >
      <div className="flex items-start justify-between gap-2 flex-wrap mb-2">
        <div>
          <h4 className="font-mono font-semibold text-sm">
            {fn.name}
            <span className="text-base-content/50 font-normal">({formatTypeList(fn.inputs)})</span>
          </h4>
          {fn.outputs.length > 0 && (
            <p className="text-xs text-base-content/50 font-mono mt-0.5">returns ({formatTypeList(fn.outputs)})</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {highlighted && <span className="badge badge-primary badge-sm">key</span>}
          <span className="badge badge-ghost badge-sm">{fn.stateMutability}</span>
        </div>
      </div>

      {fn.inputs.length > 0 && (
        <div className="flex flex-col gap-2 mb-3">
          {fn.inputs.map((input, i) => (
            <label key={i} className="flex flex-col gap-1">
              <span className="text-xs text-base-content/60 font-mono">
                {input.name || `arg${i}`} <span className="opacity-60">({input.type})</span>
              </span>
              <input
                className="input input-sm input-bordered font-mono text-xs w-full"
                placeholder={input.type}
                value={inputs[i]}
                onChange={e => setInputs(prev => prev.map((v, idx) => (idx === i ? e.target.value : v)))}
                onKeyDown={e => {
                  if (e.key === "Enter") query();
                }}
              />
            </label>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-sm btn-primary" onClick={query} disabled={state.status === "loading"}>
          {state.status === "loading" ? (
            <span className="loading loading-spinner loading-xs" />
          ) : fn.inputs.length === 0 ? (
            <ArrowPathIcon className="h-4 w-4" aria-hidden />
          ) : null}
          {fn.inputs.length === 0 ? "Refresh" : "Query"}
        </button>
      </div>

      {state.status === "error" && (
        <div className="mt-3 text-xs text-error break-words bg-error/10 rounded p-2">{state.error}</div>
      )}

      {state.status === "success" && (
        <div className="mt-3">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-base-content/50">Result</span>
            <CopyButton value={formatResult(state.value)} label="Copy result" />
          </div>
          <pre className="bg-base-200/60 rounded p-2 text-xs font-mono whitespace-pre-wrap break-all max-h-60 overflow-auto">
            {formatResult(state.value)}
          </pre>
        </div>
      )}
    </div>
  );
};

/**
 * The "Read Contract" sub-tab. Every read goes through a plain viem public
 * client pointed at the chain's RPC — there is no wallet in this system, and
 * none is needed to verify state.
 */
export const ReadContractTab = ({ contract }: { contract: HydratedContract }) => {
  const { targetNetwork } = useTargetNetwork();
  const client = useMemo(() => createBlockExplorerClient(targetNetwork), [targetNetwork]);

  const readFunctions = useMemo(() => {
    const functions = contract.abi.filter(
      (item): item is AbiFunction =>
        item.type === "function" && (item.stateMutability === "view" || item.stateMutability === "pure"),
    );
    // Key functions first, then alphabetical, so the audit-relevant reads are
    // at the top regardless of ABI ordering.
    return functions.sort((a, b) => {
      const aKey = HIGHLIGHTED_FUNCTIONS.has(a.name);
      const bKey = HIGHLIGHTED_FUNCTIONS.has(b.name);
      if (aKey !== bKey) return aKey ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [contract.abi]);

  if (readFunctions.length === 0) {
    return <div className="p-6 text-center text-base-content/60">This contract exposes no view or pure functions.</div>;
  }

  return (
    <div className="py-4">
      <p className="text-sm text-base-content/60 mb-4">
        {readFunctions.length} read-only function{readFunctions.length === 1 ? "" : "s"}. Values are read straight from
        the chain over JSON-RPC — no wallet or signature is involved.
      </p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {readFunctions.map(fn => (
          <FunctionCard
            key={`${fn.name}(${fn.inputs.map(i => i.type).join(",")})`}
            fn={fn}
            client={client as PublicClient}
            address={contract.address as Address}
            abi={contract.abi}
            highlighted={HIGHLIGHTED_FUNCTIONS.has(fn.name)}
          />
        ))}
      </div>
    </div>
  );
};
