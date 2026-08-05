import { useCallback, useEffect, useMemo, useState } from "react";
import { useTargetNetwork } from "./useTargetNetwork";
import { Block, Chain, Hash, Transaction, TransactionReceipt, createPublicClient, http } from "viem";
import { decodeTransactionData } from "~~/utils/scaffold-eth";

const BLOCKS_PER_PAGE = 20;
/** How often to check for a new block, in ms. Local chains seal on demand. */
const BLOCK_POLLING_INTERVAL = 1_000;

/**
 * Builds the block explorer's RPC client for a given chain.
 *
 * **HTTP, not WebSocket.** This used to be a `createTestClient` over
 * `ws://127.0.0.1:8545`, which hardcoded both the transport and the chain. The
 * custom Go node deliberately implements no `eth_subscribe` (MASTER §9 — every
 * consumer in this app polls), so a WebSocket client cannot reach it at all.
 * Polling over HTTP works identically against Hardhat and against our node, and
 * `watchBlocks({ poll: true })` gives the same live-tail behaviour the
 * subscription did.
 */
export const createBlockExplorerClient = (chain: Chain) =>
  createPublicClient({
    chain,
    transport: http(chain.rpcUrls.default.http[0]),
  });

export const useFetchBlocks = () => {
  const { targetNetwork } = useTargetNetwork();
  const client = useMemo(() => createBlockExplorerClient(targetNetwork), [targetNetwork]);

  const [blocks, setBlocks] = useState<Block[]>([]);
  const [transactionReceipts, setTransactionReceipts] = useState<{
    [key: string]: TransactionReceipt;
  }>({});
  const [currentPage, setCurrentPage] = useState(0);
  const [totalBlocks, setTotalBlocks] = useState(0n);
  const [error, setError] = useState<Error | null>(null);

  const fetchBlocks = useCallback(async () => {
    setError(null);

    try {
      const blockNumber = await client.getBlockNumber();
      setTotalBlocks(blockNumber);

      const startingBlock = blockNumber - BigInt(currentPage * BLOCKS_PER_PAGE);
      const blockNumbersToFetch = Array.from(
        { length: Number(BLOCKS_PER_PAGE < startingBlock + 1n ? BLOCKS_PER_PAGE : startingBlock + 1n) },
        (_, i) => startingBlock - BigInt(i),
      );

      const blocksWithTransactions = blockNumbersToFetch.map(async blockNumber => {
        try {
          return client.getBlock({ blockNumber, includeTransactions: true });
        } catch (err) {
          setError(err instanceof Error ? err : new Error("An error occurred."));
          throw err;
        }
      });
      const fetchedBlocks = await Promise.all(blocksWithTransactions);

      fetchedBlocks.forEach(block => {
        block.transactions.forEach(tx => decodeTransactionData(tx as Transaction));
      });

      const txReceipts = await Promise.all(
        fetchedBlocks.flatMap(block =>
          block.transactions.map(async tx => {
            try {
              const receipt = await client.getTransactionReceipt({ hash: (tx as Transaction).hash });
              return { [(tx as Transaction).hash]: receipt };
            } catch (err) {
              setError(err instanceof Error ? err : new Error("An error occurred."));
              throw err;
            }
          }),
        ),
      );

      setBlocks(fetchedBlocks);
      setTransactionReceipts(prevReceipts => ({ ...prevReceipts, ...Object.assign({}, ...txReceipts) }));
    } catch (err) {
      setError(err instanceof Error ? err : new Error("An error occurred."));
    }
  }, [client, currentPage]);

  useEffect(() => {
    fetchBlocks();
  }, [fetchBlocks]);

  useEffect(() => {
    const handleNewBlock = async (newBlock: any) => {
      try {
        if (currentPage === 0) {
          if (newBlock.transactions.length > 0) {
            const transactionsDetails = await Promise.all(
              newBlock.transactions.map((txHash: string) => client.getTransaction({ hash: txHash as Hash })),
            );
            newBlock.transactions = transactionsDetails;
          }

          newBlock.transactions.forEach((tx: Transaction) => decodeTransactionData(tx as Transaction));

          const receipts = await Promise.all(
            newBlock.transactions.map(async (tx: Transaction) => {
              try {
                const receipt = await client.getTransactionReceipt({ hash: (tx as Transaction).hash });
                return { [(tx as Transaction).hash]: receipt };
              } catch (err) {
                setError(err instanceof Error ? err : new Error("An error occurred fetching receipt."));
                throw err;
              }
            }),
          );

          setBlocks(prevBlocks => [newBlock, ...prevBlocks.slice(0, BLOCKS_PER_PAGE - 1)]);
          setTransactionReceipts(prevReceipts => ({ ...prevReceipts, ...Object.assign({}, ...receipts) }));
        }
        if (newBlock.number) {
          setTotalBlocks(newBlock.number);
        }
      } catch (err) {
        setError(err instanceof Error ? err : new Error("An error occurred."));
      }
    };

    return client.watchBlocks({
      onBlock: handleNewBlock,
      includeTransactions: true,
      poll: true,
      pollingInterval: BLOCK_POLLING_INTERVAL,
    });
  }, [client, currentPage]);

  return {
    blocks,
    transactionReceipts,
    currentPage,
    totalBlocks,
    setCurrentPage,
    error,
  };
};
