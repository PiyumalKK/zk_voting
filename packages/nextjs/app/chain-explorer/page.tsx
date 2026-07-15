"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { NextPage } from "next";
import scaffoldConfig from "~~/scaffold.config";
import { isCustomChain } from "~~/services/chain/hooks";

/**
 * Minimal block explorer for the CUSTOM Go blockchain (GET /blocks).
 * The existing /blockexplorer route is EVM-RPC based and keeps serving the
 * Hardhat backend; this page is its custom-chain counterpart.
 */

interface ChainTx {
  id: string;
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
  hash: string;
}

interface ChainBlock {
  index: number;
  timestamp: number;
  transactions: ChainTx[];
  prev_hash: string;
  hash: string;
}

const PAGE_SIZE = 10;

async function fetchBlocksPage(page: number): Promise<{ total: number; blocks: ChainBlock[] }> {
  const base = scaffoldConfig.chainApiUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/blocks?page=${page}&limit=${PAGE_SIZE}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

const short = (h: string, n = 14) => (h.length > n ? `${h.slice(0, n)}…` : h);

const TX_BADGES: Record<string, string> = {
  ADD_VOTER: "badge-info",
  REGISTER: "badge-primary",
  VOTE: "badge-success",
  SET_QUESTION: "badge-ghost",
  SET_CANDIDATES: "badge-ghost",
  START_REGISTRATION: "badge-warning",
  START_VOTING: "badge-warning",
  END_ELECTION: "badge-neutral",
  RESET_ELECTION: "badge-error",
};

const ChainExplorer: NextPage = () => {
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useQuery({
    queryKey: ["chain", "blocks", page],
    queryFn: () => fetchBlocksPage(page),
    refetchInterval: 5000,
    enabled: isCustomChain,
  });

  if (!isCustomChain) {
    return (
      <div className="flex flex-col items-center pt-16 gap-3">
        <h1 className="text-2xl font-bold">Chain Explorer</h1>
        <p className="opacity-70 text-sm">
          This page explores the custom Go blockchain. You are on the Hardhat backend — use{" "}
          <a href="/blockexplorer" className="link link-primary">
            the EVM block explorer
          </a>{" "}
          instead.
        </p>
      </div>
    );
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  // Show newest blocks first within the fetched window.
  const blocks = (data?.blocks ?? []).slice().reverse();

  return (
    <div className="flex flex-col items-center pt-8 px-4 w-full">
      <div className="w-full max-w-4xl space-y-4">
        <div className="text-center">
          <h1 className="text-3xl font-extrabold bg-gradient-to-br from-primary to-secondary text-transparent bg-clip-text">
            Chain Explorer
          </h1>
          <p className="text-sm opacity-60 mt-1">
            {data ? `${data.total} blocks on the custom voting blockchain` : "Loading chain…"}
          </p>
        </div>

        {error && <div className="alert alert-error text-sm">Could not load blocks: {(error as Error).message}</div>}
        {isLoading && (
          <div className="flex justify-center py-10">
            <span className="loading loading-spinner loading-md" />
          </div>
        )}

        {blocks.map(block => (
          <details
            key={block.hash}
            className="collapse collapse-arrow bg-base-100/60 border border-base-300/50 rounded-2xl"
          >
            <summary className="collapse-title">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-bold">#{block.index}</span>
                {block.index === 0 && <span className="badge badge-ghost badge-sm">genesis</span>}
                {block.transactions.map(tx => (
                  <span key={tx.id} className={`badge badge-sm ${TX_BADGES[tx.type] ?? "badge-ghost"}`}>
                    {tx.type}
                  </span>
                ))}
                <span className="text-xs font-mono opacity-60 ml-auto">
                  {new Date(block.timestamp).toLocaleString()}
                </span>
              </div>
            </summary>
            <div className="collapse-content text-xs font-mono space-y-2 overflow-x-auto">
              <div>
                <span className="opacity-60">hash&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> {short(block.hash, 66)}
              </div>
              <div>
                <span className="opacity-60">prev_hash</span> {short(block.prev_hash, 66)}
              </div>
              {block.transactions.map(tx => (
                <div key={tx.id} className="border border-base-300 rounded-lg p-3 space-y-1">
                  <div>
                    <span className="opacity-60">tx</span> {tx.id} <span className="opacity-60">type</span> {tx.type}
                  </div>
                  <pre className="whitespace-pre-wrap break-all bg-base-200/50 rounded p-2">
                    {JSON.stringify(tx.payload, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          </details>
        ))}

        {data && totalPages > 1 && (
          <div className="flex justify-center gap-2 py-4">
            <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
              ← Older
            </button>
            <span className="btn btn-sm btn-ghost no-animation">
              page {page} / {totalPages}
            </span>
            <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
              Newer →
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ChainExplorer;
