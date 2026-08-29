"use client";

import { useState } from "react";
import { CopyButton } from "./CopyButton";
import { SolidityCode } from "./SolidityCode";
import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import type { HydratedContract } from "~~/utils/blockexplorer/contractSources";

/** Labelled cell in the compiler summary strip. */
const MetaItem = ({ label, value }: { label: string; value: string }) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-xs uppercase tracking-wide text-base-content/50">{label}</span>
    <span className="text-sm font-medium break-all">{value}</span>
  </div>
);

/** Collapsible panel used for the ABI and the two bytecode blobs. */
const Collapsible = ({
  title,
  subtitle,
  copyValue,
  defaultOpen = false,
  children,
}: {
  title: string;
  subtitle?: string;
  copyValue: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border border-base-300 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between bg-base-200/60 px-3 py-2">
        <button
          type="button"
          className="flex items-center gap-2 text-sm font-semibold grow text-left"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDownIcon className="h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <ChevronRightIcon className="h-4 w-4 shrink-0" aria-hidden />
          )}
          {title}
          {subtitle && <span className="font-normal text-base-content/50 text-xs">{subtitle}</span>}
        </button>
        <CopyButton value={copyValue} label={`Copy ${title}`} />
      </div>
      {open && <div className="bg-base-100">{children}</div>}
    </div>
  );
};

/**
 * The "Source Code" sub-tab — the core transparency view.
 *
 * Shows every file in the contract's import closure, not just the entry file,
 * so a reader can follow an import (`Ownable`, `LeanIMT`, the Honk verifier)
 * rather than having to take it on trust.
 */
export const ContractSourceTab = ({ contract }: { contract: HydratedContract }) => {
  const [activeFile, setActiveFile] = useState(0);

  const { compiler, sources, abi, bytecode, deployedBytecode, libraries } = contract;
  const abiJson = JSON.stringify(abi, null, 2);
  const libraryEntries = Object.entries(libraries);

  if (!contract.verified || sources.length === 0) {
    return (
      <div className="p-6 text-center text-base-content/60">
        <p className="font-medium">Source code is not available for this contract.</p>
        <p className="text-sm mt-1">
          The deployment recorded no compiler metadata. Re-run <code className="text-xs">yarn deploy</code> to
          regenerate it.
        </p>
      </div>
    );
  }

  const current = sources[activeFile] ?? sources[0];

  return (
    <div className="flex flex-col gap-5 py-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 bg-base-200/40 border border-base-300 rounded-lg px-4 py-3">
        <MetaItem label="Contract Name" value={contract.contractName} />
        <MetaItem label="Compiler" value={compiler?.version ?? "unknown"} />
        <MetaItem
          label="Optimization"
          value={
            compiler?.optimizer
              ? compiler.optimizer.enabled
                ? `Enabled, ${compiler.optimizer.runs} runs`
                : "Disabled"
              : "unknown"
          }
        />
        <MetaItem label="EVM Version" value={compiler?.evmVersion ?? "default"} />
      </div>

      {libraryEntries.length > 0 && (
        <div className="text-sm border border-base-300 rounded-lg px-4 py-3 bg-base-200/40">
          <span className="font-semibold">Linked libraries: </span>
          {libraryEntries.map(([name, address], i) => (
            <span key={name}>
              {i > 0 && ", "}
              {name} @ <code className="text-xs">{address}</code>
            </span>
          ))}
          {/*
            Solidity leaves a `__$<hash>$__` placeholder where a library address
            goes, and hardhat-deploy records the *unlinked* bytecode. Saying so
            matters on a page meant for verification: a reader diffing the blob
            below against `eth_getCode` will find it differs at exactly those
            positions, and should not read that as evidence of tampering.
          */}
          <p className="text-xs text-base-content/60 mt-1">
            The bytecode below is as the compiler emitted it, with <code className="text-xs">__$…$__</code> placeholders
            where the linker substitutes the library address above. It therefore differs from the deployed code at those
            positions.
          </p>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
          <h3 className="font-semibold text-sm">Solidity Source{sources.length > 1 && ` (${sources.length} files)`}</h3>
          <CopyButton value={current.content} label="Copy source file" />
        </div>

        {sources.length > 1 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {sources.map((source, i) => (
              <button
                key={source.path}
                type="button"
                onClick={() => setActiveFile(i)}
                className={`btn btn-xs font-mono normal-case ${i === activeFile ? "btn-primary" : "btn-ghost"}`}
                title={source.path}
              >
                {source.path.split("/").pop()}
                {source.isEntry && <span className="ml-1 opacity-70">★</span>}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-base-content/60 mb-1 gap-2 flex-wrap">
          <span className="font-mono break-all">{current.path}</span>
          {current.license && <span>License: {current.license}</span>}
        </div>

        <SolidityCode code={current.content} className="max-h-[600px] overflow-y-auto" />
      </div>

      <Collapsible title="Contract ABI" subtitle={`${abi.length} entries`} copyValue={abiJson}>
        <pre className="p-4 text-xs font-mono overflow-auto max-h-[400px] whitespace-pre">{abiJson}</pre>
      </Collapsible>

      {bytecode && (
        <Collapsible
          title="Creation Bytecode"
          subtitle={`${((bytecode.length - 2) / 2).toLocaleString()} bytes`}
          copyValue={bytecode}
        >
          <p className="px-4 pt-3 text-xs font-mono break-all max-h-[240px] overflow-y-auto pb-4">{bytecode}</p>
        </Collapsible>
      )}

      {deployedBytecode && (
        <Collapsible
          title="Deployed (Runtime) Bytecode"
          subtitle={`${((deployedBytecode.length - 2) / 2).toLocaleString()} bytes`}
          copyValue={deployedBytecode}
        >
          <p className="px-4 pt-3 text-xs font-mono break-all max-h-[240px] overflow-y-auto pb-4">{deployedBytecode}</p>
        </Collapsible>
      )}
    </div>
  );
};
