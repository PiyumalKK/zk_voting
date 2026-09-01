import type { GnAccountRecord } from "~~/services/auth/accounts";
import type { DivisionSummary } from "~~/services/auth/relayContracts";
import type { SessionData } from "~~/services/auth/session";

/**
 * Who may ask the server to hash a NIC, when the caller has no wallet.
 *
 * `POST /api/nic/hash` turns a national identity number into the pepper-keyed
 * hash that `reserveNicHash` stores on chain. It has always been restricted to
 * serving GN officers, because an open endpoint plus a list of candidate NICs
 * is an offline dictionary attack against the registry: anyone could hash every
 * plausible NIC and check the results against the public chain.
 *
 * In hardhat mode that restriction is proved by a wallet signature. In custom
 * mode there is no wallet, so the proof is the session cookie — but a session
 * alone is not enough. The account behind it must still be the officer the
 * chain recognises for that division, so that disabling an account or
 * reassigning a division takes effect immediately rather than at next login.
 *
 * The decision is factored out here, pure, because it is the kind of check
 * whose failure modes (disabled account, reassigned division, division deleted)
 * are easy to describe in a test and awkward to reproduce by hand.
 */

export interface NicHashAuthInput {
  session: Pick<SessionData, "role" | "username" | "divisionId">;
  /** The stored account for `session.username`, or undefined if it has since been deleted. */
  account: Pick<GnAccountRecord, "address" | "divisionId" | "disabled"> | undefined;
  divisions: readonly Pick<DivisionSummary, "id" | "gnOfficers">[];
}

export type NicHashAuthResult =
  | { ok: true; gnAddress: string; divisionId: number }
  | { ok: false; status: 401 | 403; error: string };

const sameAddress = (a: string | undefined, b: string | undefined): boolean =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

export const authoriseNicHashSession = ({ session, account, divisions }: NicHashAuthInput): NicHashAuthResult => {
  if (session.role !== "gn") {
    // Admins are deliberately excluded: enrolment is the GN's job, and every
    // NIC hash the server computes should be attributable to the officer who
    // physically checked the identity document.
    return { ok: false, status: 403, error: "Only GN officers may enrol voters." };
  }

  if (!account) {
    return { ok: false, status: 401, error: "Your account no longer exists. Sign in again." };
  }
  if (account.disabled) {
    return { ok: false, status: 403, error: "This account has been suspended." };
  }

  // The session carries a division id, but the account record is the record of
  // truth — if an admin moved the officer, the old id in an 8-hour-old cookie
  // must not decide anything.
  const divisionId = account.divisionId;
  const division = divisions.find(candidate => candidate.id === divisionId);
  if (!division) {
    return { ok: false, status: 403, error: `Division ${divisionId} is not registered on this chain.` };
  }

  if (!division.gnOfficers.some(gn => sameAddress(gn, account.address))) {
    return {
      ok: false,
      status: 403,
      error: "You are no longer the assigned GN officer for your division. Ask the Election Authority to reassign you.",
    };
  }

  return { ok: true, gnAddress: account.address, divisionId };
};
