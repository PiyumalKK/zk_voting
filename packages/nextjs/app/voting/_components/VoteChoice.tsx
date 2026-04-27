import { useChallengeState } from "~~/services/store/challengeStore";

export const VoteSelector = () => {
  const voteChoice = useChallengeState(state => state.voteChoice);
  const setVoteChoice = useChallengeState(state => state.setVoteChoice);

  return (
    <div className="bg-base-100 shadow-lg rounded-2xl p-6 space-y-4 border border-base-300/50 hover-lift">
      <div className="space-y-1 text-center">
        <h2 className="text-2xl font-bold">Choose your vote</h2>
        <p className="text-xs opacity-50">Your selection is private — only you know your choice</p>
      </div>
      <div className="flex gap-4 justify-center">
        <button
          className={`btn btn-lg min-w-[100px] ${voteChoice === true ? "btn-success shadow-lg shadow-success/25" : "btn-outline"}`}
          onClick={() => setVoteChoice(true)}
        >
          Yes
        </button>
        <button
          className={`btn btn-lg min-w-[100px] ${voteChoice === false ? "btn-error shadow-lg shadow-error/25" : "btn-outline"}`}
          onClick={() => setVoteChoice(false)}
        >
          No
        </button>
      </div>
    </div>
  );
};
