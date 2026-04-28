"use client";

import { ShowVotersButton } from "./_components/ShowVotersButton";
import { VoteWithBurnerHardhat } from "./_components/VoteWithBurnerHardhat";
import { NextPage } from "next";
import { hardhat, sepolia } from "viem/chains";
import { AddVotersModal } from "~~/app/voting/_components/AddVotersModal";
import { ClearStorageButton } from "~~/app/voting/_components/ClearStorageButton";
import { CreateCommitment } from "~~/app/voting/_components/CreateCommitment";
import { GenerateProof } from "~~/app/voting/_components/GenerateProof";
import { LogStorageButton } from "~~/app/voting/_components/LogStorageButton";
import { VoteSelector } from "~~/app/voting/_components/VoteChoice";
import { VoteWithBurnerSepolia } from "~~/app/voting/_components/VoteWithBurnerSepolia";
import { VotingStats } from "~~/app/voting/_components/VotingStats";
import { useScaffoldEventHistory } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";

const VotingPage: NextPage = () => {
  const network = useTargetNetwork();

  const { data: leafEvents } = useScaffoldEventHistory({
    contractName: "Voting",
    eventName: "NewLeaf",
    watch: true,
    enabled: true,
  });

  return (
    <div className="flex items-center justify-center flex-col grow pt-6 w-full">
      <div className="px-4 sm:px-5 w-full max-w-7xl mx-auto">
        <div className="flex flex-col items-center w-full">
          {/* Page Header */}
          <div className="text-center mb-6">
            <h1 className="text-3xl font-extrabold gradient-text">Anonymous Voting</h1>
            <p className="text-sm opacity-60 mt-1">Cast your vote privately using zero-knowledge proofs</p>
          </div>

          <div className="w-full max-w-2xl space-y-5">
            <div className="flex flex-wrap gap-2 justify-between">
              <ShowVotersButton />
              <AddVotersModal />
            </div>
            <VotingStats />
            <CreateCommitment leafEvents={leafEvents || []} />
            <VoteSelector />
            <GenerateProof leafEvents={leafEvents || []} />
            {network.targetNetwork.id === hardhat.id && <VoteWithBurnerHardhat />}
            {network.targetNetwork.id === sepolia.id && <VoteWithBurnerSepolia />}

            {/* Storage Management Buttons - placed at the bottom for safety */}
            <div className="mt-8 pt-6 border-t border-base-300/50">
              <div className="flex justify-center gap-4">
                <LogStorageButton />
                <ClearStorageButton />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VotingPage;
