"use client";

import { useState } from "react";
import { ContractSourceTab } from "./ContractSourceTab";
import { ReadContractTab } from "./ReadContractTab";
import { CodeBracketIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import type { HydratedContract } from "~~/utils/blockexplorer/contractSources";

type SubTab = "source" | "read";

/**
 * The "Contract" tab — the transparency surface, split into the published source
 * (what the code says) and live reads (what the chain currently holds).
 */
export const ContractTab = ({ contract }: { contract: HydratedContract }) => {
  const [subTab, setSubTab] = useState<SubTab>("source");

  const tabs: { id: SubTab; label: string; Icon: typeof CodeBracketIcon }[] = [
    { id: "source", label: "Source Code", Icon: CodeBracketIcon },
    { id: "read", label: "Read Contract", Icon: MagnifyingGlassIcon },
  ];

  return (
    <div className="px-4 pb-4">
      <div className="flex gap-1 border-b border-base-300 mt-2">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setSubTab(id)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              subTab === id
                ? "border-primary text-primary"
                : "border-transparent text-base-content/60 hover:text-base-content"
            }`}
            aria-selected={subTab === id}
            role="tab"
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </button>
        ))}
      </div>

      {subTab === "source" ? <ContractSourceTab contract={contract} /> : <ReadContractTab contract={contract} />}
    </div>
  );
};
