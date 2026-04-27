import { Address } from "@scaffold-ui/components";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-eth";

export const VotingStats = () => {
  const { data: deployedContractData } = useDeployedContractInfo({ contractName: "Voting" });

  const { data: votingData } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getVotingData",
  });

  const question = votingData?.[0];
  const owner = votingData?.[1];
  const yesVotes = votingData?.[2];
  const noVotes = votingData?.[3];

  const q = (question as string | undefined) || undefined;
  const yes = (yesVotes as bigint | undefined) ?? 0n;
  const no = (noVotes as bigint | undefined) ?? 0n;
  const totalVotes = yes + no;
  const yesPercentage = totalVotes > 0n ? Number((yes * 100n) / totalVotes) : 0;
  const noPercentage = totalVotes > 0n ? Number((no * 100n) / totalVotes) : 0;

  return (
    <div className="bg-base-100 shadow-lg rounded-2xl p-6 space-y-4 border border-base-300/50 hover-lift">
      <div className="text-center">
        <h2 className="text-2xl font-bold">{q || "Loading..."}</h2>
        <div className="flex justify-center gap-10 mt-2">
          <div className="text-sm">
            Voting contract: <Address address={deployedContractData?.address} />
          </div>
          <div className="text-sm">
            Owner: <Address address={owner as `0x${string}`} />
          </div>
        </div>
        <span className="text-xs opacity-60 mt-1 inline-block">Total Votes: {totalVotes.toString()}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 text-center">
        <div className="rounded-xl border border-success/20 bg-success/5 p-4">
          <div className="text-xs opacity-60 font-medium uppercase tracking-wider">Yes</div>
          <div className="text-2xl font-bold text-success">{yes.toString()}</div>
          <div className="text-xs opacity-60">{yesPercentage.toFixed(1)}%</div>
        </div>
        <div className="rounded-xl border border-error/20 bg-error/5 p-4">
          <div className="text-xs opacity-60 font-medium uppercase tracking-wider">No</div>
          <div className="text-2xl font-bold text-error">{no.toString()}</div>
          <div className="text-xs opacity-60">{noPercentage.toFixed(1)}%</div>
        </div>
      </div>
      {totalVotes > 0n && (
        <div className="w-full bg-base-200 rounded-full h-3 overflow-hidden flex shadow-inner">
          <div className="bg-success h-3 transition-all duration-500" style={{ width: `${yesPercentage}%` }} />
          <div className="bg-error h-3 transition-all duration-500" style={{ width: `${noPercentage}%` }} />
        </div>
      )}
    </div>
  );
};
