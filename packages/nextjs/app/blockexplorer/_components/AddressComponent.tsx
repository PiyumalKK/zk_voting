"use client";

import { BackButton } from "./BackButton";
import { ContractTabs } from "./ContractTabs";
import { CopyButton } from "./CopyButton";
import { Address } from "@scaffold-ui/components";
import { Address as AddressType } from "viem";
import { CheckBadgeIcon } from "@heroicons/react/24/solid";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import type { HydratedContract } from "~~/utils/blockexplorer/contractSources";
import { isLocalChainId } from "~~/utils/customChain";

/** One label/value row in the header card. */
const HeaderRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
    <span className="text-xs uppercase tracking-wide text-base-content/50 sm:w-32 shrink-0">{label}</span>
    <div className="flex items-center gap-1 min-w-0">{children}</div>
  </div>
);

export const AddressComponent = ({
  address,
  contract,
}: {
  address: AddressType;
  contract: HydratedContract | null;
}) => {
  const { targetNetwork } = useTargetNetwork();
  const explorerLink = isLocalChainId(targetNetwork.id) ? `/blockexplorer/address/${address}` : undefined;

  return (
    <div className="m-6 lg:m-10 mb-20">
      <div className="flex justify-start mb-5">
        <BackButton />
      </div>

      <div className="bg-base-100 border border-base-300 rounded-2xl shadow-sm px-6 py-5">
        <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold m-0">{contract ? contract.deploymentName : "Address"}</h1>
            {contract && contract.deploymentName !== contract.contractName && (
              <span className="badge badge-ghost">{contract.contractName}.sol</span>
            )}
            {contract?.verified && (
              <span className="badge badge-success gap-1 font-semibold">
                <CheckBadgeIcon className="h-4 w-4" aria-hidden />
                Verified Source Code
              </span>
            )}
          </div>
          {/*
            No balance shown. Every account here is either an election contract
            or an officer/relay key; gas is free on this chain and nothing is
            payable, so a balance is inert — it never moves, and the genesis
            prefund (10,000 ETH to the Hardhat mnemonic accounts) would display
            a holding that means nothing in an election.
          */}
        </div>

        <div className="flex flex-col gap-2">
          <HeaderRow label="Address">
            <span className="font-mono text-sm break-all">{address}</span>
            <CopyButton value={address} label="Copy contract address" />
          </HeaderRow>

          {contract?.creator && (
            <HeaderRow label="Creator">
              <Address
                address={contract.creator as AddressType}
                format="long"
                size="sm"
                onlyEnsOrAddress
                blockExplorerAddressLink={
                  isLocalChainId(targetNetwork.id) ? `/blockexplorer/address/${contract.creator}` : undefined
                }
              />
            </HeaderRow>
          )}

          {contract?.creationTxHash && (
            <HeaderRow label="Creation Tx">
              <a
                href={`/blockexplorer/transaction/${contract.creationTxHash}`}
                className="link link-primary font-mono text-sm break-all"
              >
                {contract.creationTxHash}
              </a>
              <CopyButton value={contract.creationTxHash} label="Copy creation transaction hash" />
            </HeaderRow>
          )}

          {contract?.creationBlock !== null && contract?.creationBlock !== undefined && (
            <HeaderRow label="Created at">
              <span className="text-sm">Block {contract.creationBlock.toLocaleString()}</span>
            </HeaderRow>
          )}

          {!contract && (
            <HeaderRow label="Identicon">
              <Address
                address={address}
                format="long"
                size="sm"
                onlyEnsOrAddress
                blockExplorerAddressLink={explorerLink}
              />
            </HeaderRow>
          )}
        </div>
      </div>

      <ContractTabs address={address} contract={contract} />
    </div>
  );
};
