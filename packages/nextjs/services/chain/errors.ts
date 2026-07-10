/**
 * Maps raw chain errors to user-facing messages. Works for BOTH backends
 * because they surface the same Solidity custom-error names: viem puts them in
 * revert messages, and the Go node ABI-decodes reverts into its HTTP error
 * bodies (see packages/blockchain/internal/evm/bridge.go wrapErr).
 */
export function mapChainError(raw: string, fallback = "Transaction failed"): string {
  if (raw.includes("NullifierHashAlreadyUsed")) return "You have already voted with this identity.";
  if (raw.includes("InvalidRoot")) return "Your voting key is outdated. Upload your latest Voter Pass and try again.";
  if (raw.includes("InvalidProof"))
    return "The proof is invalid for the current election. Regenerate it from your Voter Pass.";
  if (raw.includes("WrongPhase")) return "This action is not allowed in the current election phase.";
  if (raw.includes("InvalidCandidate")) return "The selected candidate is invalid.";
  if (raw.includes("EmptyTree")) return "No one has registered yet, so there is nothing to vote against.";
  if (raw.includes("AddressNotAllowlisted") || raw.includes("not allowlisted"))
    return "You are not on the voters list for this election.";
  if (raw.includes("CommitmentAlreadyAdded")) return "This commitment is already registered.";
  if (raw.includes("AddressAlreadyRegistered") || raw.includes("already registered"))
    return "You have already registered for this election.";
  if (raw.includes("Too many requests")) return "Too many requests — please wait a moment and try again.";
  return fallback;
}

/** Error subclass that keeps the raw chain error for matching while carrying a friendly message. */
export class ChainError extends Error {
  readonly raw: string;
  constructor(raw: string, fallback?: string) {
    super(mapChainError(raw, fallback ?? raw));
    this.name = "ChainError";
    this.raw = raw;
  }
}
