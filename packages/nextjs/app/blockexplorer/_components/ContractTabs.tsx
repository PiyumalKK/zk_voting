"use client";

import { useEffect, useMemo, useState } from "react";
import { ContractEventsTab } from "./ContractEventsTab";
import { ContractTab } from "./ContractTab";
import { PaginationButton } from "./PaginationButton";
import { TransactionsTable } from "./TransactionsTable";
import { Address } from "viem";
import { BoltIcon, DocumentTextIcon, QueueListIcon } from "@heroicons/react/24/outline";
import { useFetchBlocks } from "~~/hooks/scaffold-eth";
import { createBlockExplorerClient } from "~~/hooks/scaffold-eth/useFetchBlocks";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import type { HydratedContract } from "~~/utils/blockexplorer/contractSources";

type TabId = "transactions" | "contract" | "events";

type PageProps = {
  address: Address;
  /** Null for an EOA, or a contract this deployment did not produce. */
  contract: HydratedContract | null;
};

export const ContractTabs = ({ address, contract }: PageProps) => {
  const { blocks, transactionReceipts, currentPage, totalBlocks, setCurrentPage } = useFetchBlocks();
  const { targetNetwork } = useTargetNetwork();
  const publicClient = useMemo(() => createBlockExplorerClient(targetNetwork), [targetNetwork]);
  const [activeTab, setActiveTab] = useState<TabId>("transactions");
  // A contract we have published source for is known to be a contract without
  // asking the chain. Seeding from that matters: the tab bar is what exposes the
  // source, so probing the RPC first would hide the entire transparency view
  // whenever the node is briefly unreachable — exactly when a sceptical reader
  // is most likely to want to check the code.
  const [isContract, setIsContract] = useState(contract !== null);

  useEffect(() => {
    if (contract !== null) return;

    // Unknown address: fall back to asking the chain, so contracts deployed
    // outside hardhat-deploy still get the transactions/events tabs.
    const checkIsContract = async () => {
      try {
        const contractCode = await publicClient.getBytecode({ address });
        setIsContract(contractCode !== undefined && contractCode !== "0x");
      } catch {
        setIsContract(false);
      }
    };

    checkIsContract();
  }, [address, publicClient, contract]);

  const filteredBlocks = blocks.filter(block =>
    block.transactions.some(tx => {
      if (typeof tx === "string") {
        return false;
      }
      return tx.from.toLowerCase() === address.toLowerCase() || tx.to?.toLowerCase() === address.toLowerCase();
    }),
  );

  const tabs: { id: TabId; label: string; Icon: typeof BoltIcon }[] = [
    { id: "transactions", label: "Transactions", Icon: QueueListIcon },
    { id: "contract", label: "Contract", Icon: DocumentTextIcon },
    { id: "events", label: "Events", Icon: BoltIcon },
  ];

  return (
    <div className="mt-6 bg-base-100 border border-base-300 rounded-2xl shadow-sm overflow-hidden">
      {isContract && (
        <div role="tablist" className="flex border-b border-base-300 bg-base-200/40">
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={activeTab === id}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === id
                  ? "border-primary text-primary bg-base-100"
                  : "border-transparent text-base-content/60 hover:text-base-content"
              }`}
              onClick={() => setActiveTab(id)}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </button>
          ))}
        </div>
      )}

      {activeTab === "transactions" && (
        <div className="pt-4 pb-2">
          <TransactionsTable blocks={filteredBlocks} transactionReceipts={transactionReceipts} />
          <PaginationButton
            currentPage={currentPage}
            totalItems={Number(totalBlocks)}
            setCurrentPage={setCurrentPage}
          />
        </div>
      )}

      {activeTab === "contract" &&
        (contract ? (
          <ContractTab contract={contract} />
        ) : (
          <div className="p-6 text-center text-base-content/60">
            No published source for this address. It is not one of the contracts deployed by this election.
          </div>
        ))}

      {activeTab === "events" &&
        (contract ? (
          <ContractEventsTab contract={contract} />
        ) : (
          <div className="p-6 text-center text-base-content/60">
            Events can only be decoded for contracts with a published ABI.
          </div>
        ))}
    </div>
  );
};
