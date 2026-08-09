"use client";

import { useEffect, useState } from "react";
import { PaginationButton, SearchBar, TransactionsTable } from "./_components";
import type { NextPage } from "next";
import { useFetchBlocks } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { isLocalChainId } from "~~/utils/customChain";
import { notification } from "~~/utils/scaffold-eth";

const BlockExplorer: NextPage = () => {
  const { blocks, transactionReceipts, currentPage, totalBlocks, setCurrentPage, error } = useFetchBlocks();
  const { targetNetwork } = useTargetNetwork();
  const [isLocalNetwork, setIsLocalNetwork] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    // "Local" covers Hardhat and the custom Go node — both are served by a node
    // this explorer can read directly over JSON-RPC.
    setIsLocalNetwork(isLocalChainId(targetNetwork.id));
  }, [targetNetwork.id]);

  useEffect(() => {
    // Only a genuine connection failure counts: an error while no blocks have
    // loaded. A stray per-block/receipt failure mid-stream (common behind a
    // load balancer) must not raise the "node is down" alarm.
    setHasError(isLocalChainId(targetNetwork.id) && error !== null && blocks.length === 0);
  }, [targetNetwork.id, error, blocks.length]);

  useEffect(() => {
    if (!isLocalNetwork) {
      notification.error(
        <>
          <p className="font-bold mt-0 mb-1">
            <code className="italic bg-base-300 text-base font-bold"> targetNetwork </code> is not localhost
          </p>
          <p className="m-0">
            - You are on <code className="italic bg-base-300 text-base font-bold">{targetNetwork.name}</code> .This
            block explorer is only for <code className="italic bg-base-300 text-base font-bold">localhost</code>.
          </p>
          <p className="mt-1 break-normal">
            - You can use{" "}
            <a className="text-accent" href={targetNetwork.blockExplorers?.default.url}>
              {targetNetwork.blockExplorers?.default.name}
            </a>{" "}
            instead
          </p>
        </>,
      );
    }
  }, [
    isLocalNetwork,
    targetNetwork.blockExplorers?.default.name,
    targetNetwork.blockExplorers?.default.url,
    targetNetwork.name,
  ]);

  useEffect(() => {
    if (hasError) {
      notification.error(
        <>
          <p className="font-bold mt-0 mb-1">Cannot connect to {targetNetwork.name}</p>
          <p className="m-0">
            - Is the node running? <code className="italic bg-base-300 text-base font-bold">yarn chain</code> for
            Hardhat, <code className="italic bg-base-300 text-base font-bold">make run</code> in{" "}
            <code className="italic bg-base-300 text-base font-bold">packages/blockchain</code> for the custom chain.
          </p>
          <p className="mt-1 break-normal">
            - Or check <code className="italic bg-base-300 text-base font-bold">NEXT_PUBLIC_CHAIN_BACKEND</code> /{" "}
            <code className="italic bg-base-300 text-base font-bold">NEXT_PUBLIC_RPC_URL</code> in{" "}
            <code className="italic bg-base-300 text-base font-bold">.env.local</code>
          </p>
        </>,
      );
    }
  }, [hasError, targetNetwork.name]);

  return (
    <div className="container mx-auto p-6 lg:p-8">
      <SearchBar />
      <TransactionsTable blocks={blocks} transactionReceipts={transactionReceipts} />
      <PaginationButton currentPage={currentPage} totalItems={Number(totalBlocks)} setCurrentPage={setCurrentPage} />
    </div>
  );
};

export default BlockExplorer;
