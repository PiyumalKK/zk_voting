"use client";

import { ShowVotersButton } from "./_components/ShowVotersButton";
import { NextPage } from "next";
import { ClearStorageButton } from "~~/app/voting/_components/ClearStorageButton";
import { CreateCommitment } from "~~/app/voting/_components/CreateCommitment";
import { GenerateProof } from "~~/app/voting/_components/GenerateProof";
import { LogStorageButton } from "~~/app/voting/_components/LogStorageButton";
import { VoterIdCard } from "~~/app/voting/_components/VoterIdCard";
import { VotingStats } from "~~/app/voting/_components/VotingStats";
import { useDeployedContractInfo } from "~~/hooks/scaffold-eth";
import { useDivisions } from "~~/hooks/useDivisions";
import { isCustomChain, useLeaves, useVotingData } from "~~/services/chain/hooks";
import { PHASE } from "~~/services/chain/types";

const VotingPage: NextPage = () => {
  const { data: votingData } = useVotingData();
  // Normalized Merkle leaves for the CURRENT election, oldest-first —
  // backend-specific event slicing/ordering lives inside useLeaves().
  const leaves = useLeaves();

  const phase = votingData?.phase ?? PHASE.Setup;
  const showRegistration = phase === PHASE.Registration;
  const showVoting = phase === PHASE.Voting;
  const showStartupNotice = phase === PHASE.Setup;
  const showEndedNotice = phase === PHASE.Ended;

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
            <DivisionContextBanner />

            <VotingStats />

            {isCustomChain && (showRegistration || showVoting) && <VoterIdCard />}

            {showStartupNotice && (
              <PhaseNotice tone="info" title="Election not started yet">
                The admin is still configuring the election. Registration will open shortly.
              </PhaseNotice>
            )}

            {showRegistration && <CreateCommitment />}

            {showVoting && <GenerateProof leaves={leaves} />}

            {showEndedNotice && (
              <PhaseNotice tone="neutral" title="Election ended">
                Voting is closed. Results above are final.
              </PhaseNotice>
            )}

            <div className="mt-8 pt-6 border-t border-base-300/50">
              <details className="collapse bg-base-200/50 border border-base-300">
                <summary className="collapse-title text-sm font-medium text-center opacity-70 cursor-pointer">
                  Advanced Tools
                </summary>
                <div className="collapse-content flex flex-wrap justify-center gap-4 pt-4">
                  <ShowVotersButton />
                  <LogStorageButton />
                  <ClearStorageButton />
                </div>
              </details>
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

// Shows which registered division this web voter flow is bound to (the default
// scaffold "Voting" contract). Real multi-division voting happens in the mobile app.
const DivisionContextBanner = () => {
  const { data: deployedVoting } = useDeployedContractInfo({ contractName: "Voting" });
  const { divisions } = useDivisions();

  const votingAddress = deployedVoting?.address?.toLowerCase();
  const matched = divisions.find(d => d.votingContract.toLowerCase() === votingAddress);

  if (!votingAddress) return null;

  return (
    <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <span className="text-lg">🏛️</span>
        <div>
          <div className="text-sm font-semibold">{matched ? `${matched.name} Division` : "Prototype Division"}</div>
          <div className="text-[11px] opacity-50 font-mono">{votingAddress}</div>
        </div>
      </div>
      <div className="text-[11px] opacity-60 max-w-xs text-right">
        This web demo votes on one division contract. In production, voters use the mobile app which targets their own
        division automatically.
      </div>
    </div>
  );
};
