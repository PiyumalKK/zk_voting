"use client";

import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { useChallengeState } from "~~/services/store/challengeStore";

export const VoteSelector = () => {
  const voteChoice = useChallengeState(state => state.voteChoice);
  const setVoteChoice = useChallengeState(state => state.setVoteChoice);

  const { data: candidates } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getCandidates",
  });

  const list = (candidates as readonly string[] | undefined) ?? [];

  // Color palette cycled across candidates for visual differentiation.
  const palettes = [
    "btn-success shadow-lg shadow-success/25",
    "btn-error shadow-lg shadow-error/25",
    "btn-primary shadow-lg shadow-primary/25",
    "btn-secondary shadow-lg shadow-secondary/25",
    "btn-accent shadow-lg shadow-accent/25",
    "btn-warning shadow-lg shadow-warning/25",
    "btn-info shadow-lg shadow-info/25",
  ];

  return (
    <div className="bg-base-100 shadow-lg rounded-2xl p-6 space-y-4 border border-base-300/50 hover-lift">
      <div className="space-y-1 text-center">
        <h2 className="text-2xl font-bold">Choose your vote</h2>
        <p className="text-xs opacity-50">Your selection is private — only you know your choice</p>
      </div>
      {list.length === 0 ? (
        <p className="text-center text-sm opacity-60">Candidates not yet configured.</p>
      ) : (
        <div className="flex flex-wrap gap-3 justify-center">
          {list.map((name, idx) => {
            const selected = voteChoice === idx;
            const palette = palettes[idx % palettes.length];
            return (
              <button
                key={`${idx}-${name}`}
                className={`btn btn-lg min-w-[100px] ${selected ? palette : "btn-outline"}`}
                onClick={() => setVoteChoice(idx)}
              >
                {name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
