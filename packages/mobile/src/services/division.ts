import { api, DivisionState, VoterDeviceState } from "./api";
import { getAddress, getSelectedDivision, setSelectedDivision } from "./keystore";

/**
 * Which division a voter belongs to is not a preference — it is a fact already
 * recorded on-chain. A GN officer serves exactly one division and enrols voters
 * onto that division's Voting contract allowlist, so the allowlist *is* the
 * answer. Asking the voter to pick could only ever produce agreement with the
 * chain or a mistake, and a mistake surfaced far away from its cause: the
 * registration transaction reverting with "not allowed to vote".
 *
 * So every screen derives the division from the allowlist instead.
 */

export interface VoterDivision {
  /** The division this device's voter is enrolled in, or null if none is. */
  division: DivisionState | null;
  /** Every division on the registry, for context (counts, diagnostics). */
  divisions: DivisionState[];
  /** True when the voter is not on any division's allowlist yet. */
  notEnrolled: boolean;
  /** This device's standing in the NicRegistry, or null if the chain did not say. */
  device: VoterDeviceState | null;
  /**
   * True when a GN officer has issued this citizen a replacement phone, so this
   * one can never register.
   *
   * Kept separate from `notEnrolled` deliberately: a superseded device usually
   * *is* still on the allowlist — nothing requires the officer to revoke it,
   * because supersession is what actually stops it — so every "are you enrolled"
   * check would otherwise report it as perfectly fine right up until the
   * registration transaction reverts.
   */
  deviceSuperseded: boolean;
  /**
   * True when the chain says this device may register: a GN officer enrolled it
   * and it has not been replaced.
   *
   * Defaults to true when the chain said nothing at all (`device` is null — no
   * NicRegistry, or the read failed). Supplementary data must never present a
   * working phone as a broken one; `register()` enforces the rule regardless, so
   * the cost of being wrong this way is a clear on-chain error instead of a
   * screen that refuses a voter who was in fact enrolled.
   */
  deviceEnrolled: boolean;
}

const sameAddress = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Pick the division whose allowlist contains this voter.
 *
 * The cached selection is consulted only to keep the choice stable when a voter
 * somehow appears on more than one allowlist; it can never override the chain.
 */
export async function resolveVoterDivision(divisions: DivisionState[]): Promise<DivisionState | null> {
  const cached = await getSelectedDivision();

  // A division that could not be read reports no allowlist answer at all. If
  // *none* answered we are offline or the registry is down — fall back to the
  // last known division rather than telling an enrolled voter they are not
  // enrolled.
  const answered = divisions.filter(d => d.voterAllowlisted !== undefined);
  if (answered.length === 0) {
    return divisions.find(d => sameAddress(d.votingContract, cached)) ?? null;
  }

  const enrolled = answered.filter(d => d.voterAllowlisted);
  const division = enrolled.find(d => sameAddress(d.votingContract, cached)) ?? enrolled[0] ?? null;

  if (division && !sameAddress(division.votingContract, cached)) {
    await setSelectedDivision(division.votingContract);
  }
  return division;
}

/** Fetch the election and resolve this device's division in one step. */
export async function loadVoterDivision(): Promise<VoterDivision> {
  const address = await getAddress();
  const election = await api.getElection(address);
  const division = await resolveVoterDivision(election.divisions);
  const device = election.voterDevice ?? null;
  return {
    division,
    divisions: election.divisions,
    notEnrolled: !division && election.divisions.some(d => d.voterAllowlisted !== undefined),
    device,
    deviceSuperseded: device?.status === "superseded",
    deviceEnrolled: device === null || device.status === "live",
  };
}
