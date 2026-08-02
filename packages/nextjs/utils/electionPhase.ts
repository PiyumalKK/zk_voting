/**
 * The `Voting.Phase` enum, spelled for humans.
 *
 * Index matches the on-chain enum: 0 Setup, 1 Registration, 2 Voting, 3 Ended.
 *
 * Lives in `utils/` rather than in `hooks/useDivisions.ts` so that a page which
 * only needs the labels does not pull in the wagmi/scaffold read stack behind
 * that hook. `useDivisions` re-exports it, so existing importers are unaffected.
 */
export const PHASE_LABELS = ["Setup", "Registration", "Voting", "Ended"] as const;

export type PhaseLabel = (typeof PHASE_LABELS)[number];
