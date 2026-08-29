"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Address as AddressDisplay } from "@scaffold-ui/components";
import { Address, Log, parseEventLogs } from "viem";
import { createBlockExplorerClient } from "~~/hooks/scaffold-eth/useFetchBlocks";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import type { HydratedContract } from "~~/utils/blockexplorer/contractSources";
import { isLocalChainId } from "~~/utils/customChain";

/** Human labels for `Voting`'s phase enum, used when decoding PhaseChanged. */
const PHASE_NAMES = ["Registration", "Voting", "Ended"];

type DecodedLog = {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint | null;
  transactionHash: string | null;
  logIndex: number | null;
};

/** Formats one decoded argument for display, resolving bigints and enums. */
const formatArg = (eventName: string, name: string, value: unknown): string => {
  if (eventName === "PhaseChanged" && name === "phase") {
    const index = Number(value);
    return `${PHASE_NAMES[index] ?? "Unknown"} (${index})`;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(v => String(v)).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  }
  return String(value);
};

const EVENTS_PER_PAGE = 25;

/**
 * Decoded event log viewer.
 *
 * Logs are pulled from block 0 in one `getLogs` call and decoded against the
 * contract's own ABI, so indexed topics are resolved to named parameters
 * (`VoteCast.nullifierHash`, `PhaseChanged.phase`) rather than shown as raw
 * 32-byte topics.
 */
export const ContractEventsTab = ({ contract }: { contract: HydratedContract }) => {
  const { targetNetwork } = useTargetNetwork();
  const client = useMemo(() => createBlockExplorerClient(targetNetwork), [targetNetwork]);

  const [logs, setLogs] = useState<DecodedLog[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>("");
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [page, setPage] = useState(0);

  const fetchLogs = useCallback(async () => {
    setStatus("loading");
    try {
      const raw = await client.getLogs({ address: contract.address as Address, fromBlock: 0n, toBlock: "latest" });
      const decoded = parseEventLogs({ abi: contract.abi, logs: raw as Log[] });

      setLogs(
        decoded
          .map(entry => ({
            eventName: entry.eventName as string,
            args: (entry.args ?? {}) as Record<string, unknown>,
            blockNumber: entry.blockNumber ?? null,
            transactionHash: entry.transactionHash ?? null,
            logIndex: entry.logIndex ?? null,
          }))
          // Newest first, matching the transactions table.
          .reverse(),
      );
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [client, contract.abi, contract.address]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const eventNames = useMemo(() => Array.from(new Set(logs.map(l => l.eventName))).sort(), [logs]);

  const filtered = useMemo(
    () => (eventFilter === "all" ? logs : logs.filter(l => l.eventName === eventFilter)),
    [logs, eventFilter],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / EVENTS_PER_PAGE));
  const visible = filtered.slice(page * EVENTS_PER_PAGE, (page + 1) * EVENTS_PER_PAGE);

  if (status === "loading") {
    return (
      <div className="p-8 flex justify-center">
        <span className="loading loading-spinner" />
      </div>
    );
  }

  if (status === "error") {
    return <div className="p-6 text-center text-error text-sm break-words">Failed to load events: {error}</div>;
  }

  if (logs.length === 0) {
    return <div className="p-6 text-center text-base-content/60">This contract has not emitted any events yet.</div>;
  }

  return (
    <div className="py-4 flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-base-content/60">
          {filtered.length} event{filtered.length === 1 ? "" : "s"}
        </span>
        <select
          className="select select-sm select-bordered"
          value={eventFilter}
          onChange={e => {
            setEventFilter(e.target.value);
            setPage(0);
          }}
          aria-label="Filter by event"
        >
          <option value="all">All events</option>
          {eventNames.map(name => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-2">
        {visible.map(log => (
          <div
            key={`${log.transactionHash}-${log.logIndex}`}
            className="border border-base-300 rounded-lg p-3 bg-base-100"
          >
            <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
              <span className="badge badge-primary font-semibold">{log.eventName}</span>
              <div className="flex items-center gap-3 text-xs text-base-content/60">
                {log.blockNumber !== null && <span>Block {log.blockNumber.toString()}</span>}
                {log.transactionHash && (
                  <a className="link link-primary font-mono" href={`/blockexplorer/transaction/${log.transactionHash}`}>
                    {log.transactionHash.slice(0, 10)}…
                  </a>
                )}
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
              {Object.entries(log.args).map(([name, value]) => {
                const isAddress = typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
                return (
                  <div key={name} className="flex gap-2 text-xs items-center">
                    <span className="font-mono text-base-content/60 shrink-0">{name}:</span>
                    {isAddress ? (
                      <AddressDisplay
                        address={value as Address}
                        size="xs"
                        onlyEnsOrAddress
                        blockExplorerAddressLink={
                          isLocalChainId(targetNetwork.id) ? `/blockexplorer/address/${value}` : undefined
                        }
                      />
                    ) : (
                      <span className="font-mono break-all">{formatArg(log.eventName, name, value)}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {pageCount > 1 && (
        <div className="flex justify-end items-center gap-3">
          <button className="btn btn-sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
            Previous
          </button>
          <span className="text-sm">
            Page {page + 1} of {pageCount}
          </span>
          <button className="btn btn-sm" disabled={page + 1 >= pageCount} onClick={() => setPage(p => p + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
};
