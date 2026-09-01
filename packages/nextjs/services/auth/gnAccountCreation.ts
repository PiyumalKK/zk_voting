import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AccountStoreError, getAccountStore, isValidUsername, normaliseUsername } from "~~/services/auth/accounts";
import { generatePassword } from "~~/services/auth/crypto";
import type { DivisionSummary } from "~~/services/auth/relayContracts";
import { executeRelayCall } from "~~/services/auth/relayExecutor";
import type { SessionData } from "~~/services/auth/session";

/**
 * The one place a GN officer account (and its on-chain assignment) is
 * created — extracted from `POST /api/gn-accounts` so the bulk route
 * (`POST /api/gn-accounts/bulk`) can create many without duplicating the
 * key-generation / store-write / `setGNOfficer` sequence.
 */

export interface CreateOfficerInput {
  username: string;
  divisionId: number;
  /** Defaults to true, matching the single-account route's behaviour. */
  assign?: boolean;
}

export interface CreateOfficerResult {
  username: string;
  /** Shown once. Not stored anywhere in plaintext — only its bcrypt hash is. */
  password: string;
  address: string;
  divisionId: number;
  divisionName: string;
  assigned: boolean;
  assignError?: string;
}

export class CreateOfficerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreateOfficerError";
  }
}

export const createGnOfficerAccount = async (
  input: CreateOfficerInput,
  session: SessionData,
  divisions: readonly DivisionSummary[],
): Promise<CreateOfficerResult> => {
  const username = normaliseUsername(input.username);
  if (!isValidUsername(username)) {
    throw new CreateOfficerError("Username must be 3–32 characters: letters, digits, dot, underscore or hyphen.");
  }
  if (!Number.isInteger(input.divisionId) || input.divisionId < 0) {
    throw new CreateOfficerError("divisionId must be a non-negative integer.");
  }
  const division = divisions.find(candidate => candidate.id === input.divisionId);
  if (!division) {
    throw new CreateOfficerError(`No division with id ${input.divisionId}.`);
  }

  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  const password = generatePassword();

  try {
    await getAccountStore().create({ username, password, divisionId: input.divisionId, address, privateKey });
  } catch (error) {
    if (error instanceof AccountStoreError) throw new CreateOfficerError(error.message);
    throw error;
  }

  let assigned = false;
  let assignError: string | undefined;
  if (input.assign !== false) {
    const outcome = await executeRelayCall({
      session,
      request: { target: division.votingContract, fn: "setGNOfficer", args: [address] },
    });
    assigned = outcome.ok;
    // The account is kept even if assignment fails: the credentials have
    // already been generated, and the admin can retry `setGNOfficer` from the
    // GN Officer Management panel rather than starting over.
    if (!outcome.ok) assignError = outcome.errorName ?? outcome.error;
  }

  return {
    username,
    password,
    address,
    divisionId: input.divisionId,
    divisionName: division.name,
    assigned,
    assignError,
  };
};
