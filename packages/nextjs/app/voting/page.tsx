"use client";

import { useMemo } from "react";
import { ShowVotersButton } from "./_components/ShowVotersButton";
import { NextPage } from "next";
import { ClearStorageButton } from "~~/app/voting/_components/ClearStorageButton";
import { CreateCommitment } from "~~/app/voting/_components/CreateCommitment";
import { GenerateProof } from "~~/app/voting/_components/GenerateProof";
import { LogStorageButton } from "~~/app/voting/_components/LogStorageButton";
import { VoteSelector } from "~~/app/voting/_components/VoteChoice";
import { VotingStats } from "~~/app/voting/_components/VotingStats";
import { useScaffoldEventHistory, useScaffoldReadContract } from "~~/hooks/scaffold-eth";

const VotingPage: NextPage = () => {
  const { data: rawLeafEvents } = useScaffoldEventHistory({
    contractName: "Voting",
    eventName: "NewLeaf",
    watch: true,
    enabled: true,
  });

  const { data: votingData } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getVotingData",
  });

  const treeSize = Number(votingData?.[5] ?? 0);

  const leafEvents = useMemo(() => {
    if (!rawLeafEvents) return [];
    // The current election has exactly `treeSize` leaves.
    // rawLeafEvents is newest-first, so the first `treeSize` events belong to the current election.
    return rawLeafEvents.slice(0, treeSize);
  }, [rawLeafEvents, treeSize]);

  const phase = Number(votingData?.[2] ?? 0);
  // Phase: 0 Setup, 1 Registration, 2 Voting, 3 Ended
  const showRegistration = phase === 1;
  const showVoting = phase === 2;
  const showStartupNotice = phase === 0;
  const showEndedNotice = phase === 3;

  return (
    <div className="flex items-center justify-center flex-col grow pt-6 w-full">
      <div className="px-4 sm:px-5 w-full max-w-7xl mx-auto">
        <div className="flex flex-col items-center w-full">
          <div className="text-center mb-8 relative">
            <div className="absolute inset-0 bg-gradient-to-r from-primary/10 via-secondary/10 to-primary/10 blur-3xl -z-10 rounded-full w-3/4 h-full mx-auto" />
            <h1 className="text-4xl md:text-5xl font-extrabold bg-gradient-to-br from-primary to-secondary text-transparent bg-clip-text drop-shadow-sm">
              Anonymous Voting
            </h1>
            <p className="text-base md:text-lg opacity-70 mt-3 font-medium">Cast your vote privately and securely.</p>
          </div>

          <div className="w-full max-w-2xl space-y-5">
            <div className="flex flex-wrap gap-2 justify-end">
              <ShowVotersButton />
            </div>

            <VotingStats />

            {showStartupNotice && (
              <PhaseNotice tone="info" title="Election not started yet">
                The admin is still configuring the election. Registration will open shortly.
              </PhaseNotice>
            )}

            {showRegistration && <CreateCommitment leafEvents={leafEvents || []} />}

            {showVoting && (
              <>
                <VoteSelector />
                <GenerateProof leafEvents={leafEvents || []} />
              </>
            )}

            {showEndedNotice && (
              <PhaseNotice tone="neutral" title="Election ended">
                Voting is closed. Results above are final.
              </PhaseNotice>
            )}

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

const PhaseNotice = ({
  title,
  children,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  tone: "info" | "neutral";
}) => {
  const cls = tone === "info" ? "border-info/20 bg-info/5" : "border-base-300 bg-base-200";
  return (
    <div className={`rounded-2xl border ${cls} p-5 text-center`}>
      <h3 className="font-semibold mb-1">{title}</h3>
      <p className="text-sm opacity-70">{children}</p>
    </div>
  );
};
