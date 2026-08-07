import type { AuthRole } from "./session";
import type { Abi, AbiFunction, AbiParameter } from "abitype";

/**
 * The relay's authorization policy (`01-AUTH-DESIGN.md` §4, steps 2–3).
 *
 * This module decides, for a given session role, whether a requested contract
 * call may be signed — and it is deliberately **pure**: no network, no
 * filesystem, no environment. Everything it needs is passed in, so the tests
 * can enumerate the attack surface directly (a GN reaching into another
 * division, an unknown function name, a mistyped argument) without standing up
 * a chain.
 *
 * Three properties this enforces, in order of how much damage their absence
 * would do:
 *
 * 1. **The target must be a contract this deployment knows about.** Addresses
 *    are matched against the registry-resolved set, never trusted from the
 *    request body. A relay that signs calls to arbitrary addresses is a
 *    signing oracle for whoever holds a session.
 * 2. **The function must be on the role's whitelist.** The relay never signs
 *    `register`, `vote`, or value transfers — voter transactions must not pass
 *    through the server (anonymity + trust boundary).
 * 3. **A GN may only act on their own division**, resolved server-side from
 *    the session's `divisionId`.
 */

export type ContractKind = "Voting" | "ElectionRegistry" | "NicRegistry";

/**
 * The complete set of functions the relay will ever sign, per role.
 *
 * Anything absent is refused, including view functions — reads go direct to
 * the RPC from the browser and have no business consuming a signing key.
 */
export const RELAY_WHITELIST: Record<AuthRole, Partial<Record<ContractKind, readonly string[]>>> = {
  admin: {
    Voting: [
      "setQuestion",
      "setCandidates",
      "startRegistration",
      "startVoting",
      "endElection",
      "resetElection",
      "setGNOfficer",
    ],
    ElectionRegistry: ["createDivision", "addDivision", "updateDivision", "clearDivisions"],
    NicRegistry: ["setVotingContract", "clearNicHashes"],
  },
  gn: {
    Voting: ["addVoters"],
    NicRegistry: ["reserveNicHash"],
  },
} as const;

/**
 * Arguments that must name the caller's own division, by function.
 *
 * `addVoters` is scoped by the *target* (it is called on the division's own
 * Voting contract), while `reserveNicHash` is called on the shared NicRegistry
 * and carries the division as its second argument — so the scope check has to
 * look in a different place for each. Encoding that here keeps the rule beside
 * the whitelist instead of scattered through the route handler.
 */
const GN_DIVISION_ARG_INDEX: Record<string, number> = {
  reserveNicHash: 1,
};

/** Guards against a session being used to submit an absurdly large, gas-bombing call. */
export const MAX_ARRAY_LENGTH = 500;
export const MAX_STRING_LENGTH = 4096;

export interface KnownContract {
  kind: ContractKind;
  address: string;
  abi: Abi;
}

export interface RelayRequest {
  target: string;
  fn: string;
  args: unknown[];
}

export interface AuthorizeInput {
  role: AuthRole;
  request: RelayRequest;
  /** Every contract the relay may address: the two registries plus each division's Voting. */
  known: readonly KnownContract[];
  /** The GN's own division contract, resolved from the session's `divisionId`. Required for `gn`. */
  gnDivisionContract?: string;
}

export type AuthorizeResult =
  | {
      ok: true;
      contract: KnownContract;
      abiFunction: AbiFunction;
      /** Arguments coerced to the types viem expects (notably `bigint` for uint/int). */
      args: unknown[];
    }
  | { ok: false; status: 400 | 403; error: string };

const isAddress = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

const sameAddress = (a: string | undefined, b: string | undefined): boolean =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/**
 * Coerces one JSON-supplied argument to its ABI type, or explains why it cannot be.
 *
 * JSON has no bigint and no fixed-width integers, so clients send numbers or
 * decimal strings for `uint256`; converting here means the route hands viem
 * values it will accept, and a bad input produces a 400 with a readable
 * message instead of an opaque encoder exception.
 */
export const coerceArg = (
  parameter: AbiParameter,
  value: unknown,
  path: string,
): { ok: true; value: unknown } | { ok: false; error: string } => {
  const type = parameter.type;

  const arrayMatch = /^(.*)\[(\d*)\]$/.exec(type);
  if (arrayMatch) {
    const [, elementType, fixedLength] = arrayMatch;
    if (!Array.isArray(value)) return { ok: false, error: `${path} must be an array of ${elementType}.` };
    if (value.length > MAX_ARRAY_LENGTH) {
      return { ok: false, error: `${path} has ${value.length} items; the relay accepts at most ${MAX_ARRAY_LENGTH}.` };
    }
    if (fixedLength && value.length !== Number(fixedLength)) {
      return { ok: false, error: `${path} must have exactly ${fixedLength} items.` };
    }
    const coerced: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const element = coerceArg({ ...parameter, type: elementType }, value[i], `${path}[${i}]`);
      if (!element.ok) return element;
      coerced.push(element.value);
    }
    return { ok: true, value: coerced };
  }

  if (type === "address") {
    return isAddress(value) ? { ok: true, value } : { ok: false, error: `${path} must be a 20-byte hex address.` };
  }

  if (type === "bool") {
    return typeof value === "boolean" ? { ok: true, value } : { ok: false, error: `${path} must be a boolean.` };
  }

  if (type === "string") {
    if (typeof value !== "string") return { ok: false, error: `${path} must be a string.` };
    if (value.length > MAX_STRING_LENGTH) {
      return { ok: false, error: `${path} exceeds the ${MAX_STRING_LENGTH}-character limit.` };
    }
    return { ok: true, value };
  }

  const fixedBytes = /^bytes(\d+)$/.exec(type);
  if (fixedBytes) {
    const size = Number(fixedBytes[1]);
    const valid = typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{${size * 2}}$`).test(value);
    return valid ? { ok: true, value } : { ok: false, error: `${path} must be ${size}-byte hex (0x…).` };
  }

  if (type === "bytes") {
    const valid = typeof value === "string" && /^0x([0-9a-fA-F]{2})*$/.test(value);
    return valid ? { ok: true, value } : { ok: false, error: `${path} must be hex bytes (0x…).` };
  }

  const integer = /^(u?)int(\d*)$/.exec(type);
  if (integer) {
    const unsigned = integer[1] === "u";
    let parsed: bigint;
    if (typeof value === "bigint") {
      parsed = value;
    } else if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        return { ok: false, error: `${path} must be a safe integer; send larger values as a decimal string.` };
      }
      parsed = BigInt(value);
    } else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      parsed = BigInt(value.trim());
    } else {
      return { ok: false, error: `${path} must be an integer (number or decimal string).` };
    }
    if (unsigned && parsed < 0n) return { ok: false, error: `${path} must not be negative.` };
    const bits = BigInt(integer[2] || "256");
    const limit = unsigned ? 2n ** bits : 2n ** (bits - 1n);
    if (parsed >= limit || (!unsigned && parsed < -limit)) {
      return { ok: false, error: `${path} does not fit in ${type}.` };
    }
    return { ok: true, value: parsed };
  }

  // Tuples and everything exotic: no whitelisted function takes one, and
  // guessing at a coercion is how a validation bypass gets introduced.
  return { ok: false, error: `${path} has unsupported type ${type}.` };
};

/**
 * Decides whether a relay request may be signed.
 *
 * Returns the resolved contract, its ABI entry, and coerced arguments on
 * success; a status and a message safe to show the operator on failure.
 * Distinguishes 400 (the request is malformed) from 403 (the request is
 * well-formed but this role may not make it).
 */
export const authorizeRelayCall = ({ role, request, known, gnDivisionContract }: AuthorizeInput): AuthorizeResult => {
  const { target, fn, args } = request;

  if (!isAddress(target)) return { ok: false, status: 400, error: "`target` must be a contract address." };
  if (typeof fn !== "string" || fn.length === 0) return { ok: false, status: 400, error: "`fn` is required." };
  if (!Array.isArray(args)) return { ok: false, status: 400, error: "`args` must be an array." };

  const contract = known.find(candidate => sameAddress(candidate.address, target));
  if (!contract) {
    // Deliberately vague about *why*: the caller learns nothing about which
    // addresses this deployment knows.
    return { ok: false, status: 403, error: "The relay does not sign calls to that address." };
  }

  const allowed = RELAY_WHITELIST[role][contract.kind] ?? [];
  if (!allowed.includes(fn)) {
    return { ok: false, status: 403, error: `Role "${role}" may not call ${fn} on ${contract.kind}.` };
  }

  if (role === "gn") {
    if (!isAddress(gnDivisionContract)) {
      return { ok: false, status: 403, error: "Your account is not assigned to a division yet." };
    }
    const argIndex = GN_DIVISION_ARG_INDEX[fn];
    if (argIndex === undefined) {
      // Scoped by target: the call must be on the GN's own Voting contract.
      if (!sameAddress(contract.address, gnDivisionContract)) {
        return { ok: false, status: 403, error: "You may only act on your own division." };
      }
    } else if (!sameAddress(args[argIndex] as string, gnDivisionContract)) {
      return { ok: false, status: 403, error: "You may only act on your own division." };
    }
  }

  const abiFunction = contract.abi.find(
    (entry): entry is AbiFunction => entry.type === "function" && entry.name === fn,
  );
  if (!abiFunction) {
    return { ok: false, status: 400, error: `${fn} is not present in the deployed ${contract.kind} ABI.` };
  }
  if (abiFunction.stateMutability === "view" || abiFunction.stateMutability === "pure") {
    return { ok: false, status: 400, error: `${fn} is a read-only function; call it directly over RPC.` };
  }
  if (abiFunction.stateMutability === "payable") {
    // The relay holds real balances in hardhat-mode deployments; it must never
    // be usable to move value.
    return { ok: false, status: 403, error: "The relay does not sign payable calls." };
  }
  if (args.length !== abiFunction.inputs.length) {
    return {
      ok: false,
      status: 400,
      error: `${fn} expects ${abiFunction.inputs.length} argument(s); got ${args.length}.`,
    };
  }

  const coerced: unknown[] = [];
  for (let i = 0; i < abiFunction.inputs.length; i++) {
    const parameter = abiFunction.inputs[i];
    const result = coerceArg(parameter, args[i], `${fn}.${parameter.name || `arg${i}`}`);
    if (!result.ok) return { ok: false, status: 400, error: result.error };
    coerced.push(result.value);
  }

  return { ok: true, contract, abiFunction, args: coerced };
};
