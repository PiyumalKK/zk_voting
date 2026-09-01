import { BaseError, ContractFunctionRevertedError, createWalletClient, decodeErrorResult, http, isHex } from "viem";
import type { Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getAccountStore } from "~~/services/auth/accounts";
import type { GnAccountRecord } from "~~/services/auth/accounts";
import { appendAuditEntry, serialiseArgs } from "~~/services/auth/auditLog";
import { buildKnownContracts, createServerPublicClient, loadDivisions } from "~~/services/auth/relayContracts";
import { authorizeRelayCall } from "~~/services/auth/relayPolicy";
import type { RelayRequest } from "~~/services/auth/relayPolicy";
import type { SessionData } from "~~/services/auth/session";
import { serverChain } from "~~/utils/serverChain";

/**
 * The signing half of the relay (`01-AUTH-DESIGN.md` §4, steps 3–6).
 *
 * Authorization lives in `relayPolicy.ts` and is pure; this module is the part
 * that touches keys, the chain and the disk. Both `POST /api/relay` and the
 * `setGNOfficer` call that follows GN account creation go through
 * {@link executeRelayCall}, so there is exactly one code path that can turn a
 * session into a signed transaction.
 */

export interface RelaySuccess {
  ok: true;
  txHash: `0x${string}`;
  blockNumber: string;
  status: "success";
}

export interface RelayFailure {
  ok: false;
  status: number;
  error: string;
  /** Custom-error name when the chain reverted, e.g. `Voting__WrongPhase`. */
  errorName?: string;
}

export type RelayOutcome = RelaySuccess | RelayFailure;

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Extracts a Solidity custom-error name from a viem error.
 *
 * The existing UI matches on error *names* as substrings
 * (`NicRegistry__AlreadyUsed`, `WrongPhase`, …), so the relay has to preserve
 * them or every error message in the admin and GN pages silently degrades to
 * "Transaction failed". Two shapes have to be handled: viem's decoded
 * `ContractFunctionRevertedError` (produced when it simulates or estimates),
 * and a bare `data` payload — which is what our node returns from
 * `eth_sendRawTransaction` itself, because a reverting transaction is rejected
 * at submission rather than mined (MASTER §10.2).
 */
export const describeRevert = (error: unknown, abi: Abi): { errorName?: string; message: string } => {
  const fallback = error instanceof Error ? error.message : String(error);

  if (error instanceof BaseError) {
    try {
      const reverted = error.walk(candidate => candidate instanceof ContractFunctionRevertedError);
      if (reverted instanceof ContractFunctionRevertedError) {
        const name = reverted.data?.errorName;
        if (name) return { errorName: name, message: name };
        if (reverted.reason) return { message: reverted.reason };
      }
    } catch {
      // `walk` follows `cause` without cycle detection and overflows the stack
      // on a self-referential chain. This function runs inside a catch block —
      // throwing here would replace a useful revert message with a 500. The
      // manual scan below is cycle-safe, so fall through to it.
    }

    // Walk the cause chain for a raw revert payload and decode it ourselves.
    let cursor: unknown = error;
    const seen = new Set<unknown>();
    while (cursor && typeof cursor === "object" && !seen.has(cursor)) {
      seen.add(cursor);
      const data = (cursor as { data?: unknown }).data;
      const payload = typeof data === "string" ? data : (data as { data?: unknown } | undefined)?.data;
      if (typeof payload === "string" && isHex(payload) && payload.length > 2) {
        try {
          const decoded = decodeErrorResult({ abi, data: payload });
          if (decoded.errorName) return { errorName: decoded.errorName, message: decoded.errorName };
        } catch {
          // Not one of this contract's custom errors — keep walking.
        }
      }
      cursor = (cursor as { cause?: unknown }).cause;
    }

    return { message: error.shortMessage || fallback };
  }

  return { message: fallback };
};

/**
 * Resolves the admin signing key from the environment.
 *
 * GN keys are resolved separately, from the account record already loaded for
 * the on-chain officer check — re-reading the store would mean three file reads
 * per relay call and a window in which the account could change between them.
 */
export const resolveAdminKey = ():
  | { ok: true; privateKey: `0x${string}` }
  | { ok: false; status: number; error: string } => {
  const key = process.env.ADMIN_RELAY_PRIVATE_KEY?.trim();
  if (!key || !PRIVATE_KEY_PATTERN.test(key)) {
    return {
      ok: false,
      status: 503,
      error: "ADMIN_RELAY_PRIVATE_KEY is missing or malformed — the relay cannot sign admin actions.",
    };
  }
  return { ok: true, privateKey: key as `0x${string}` };
};

export interface ExecuteRelayCallOptions {
  session: SessionData;
  request: RelayRequest;
}

/**
 * Authorises, signs and submits one whitelisted contract call.
 *
 * Every exit path writes an audit line — including refusals, which are the
 * interesting ones when reviewing whether an operator tried to overstep.
 */
export const executeRelayCall = async ({ session, request }: ExecuteRelayCallOptions): Promise<RelayOutcome> => {
  const audit = {
    ts: new Date().toISOString(),
    role: session.role,
    username: session.username,
    target: String(request.target),
    fn: String(request.fn),
    args: serialiseArgs(Array.isArray(request.args) ? request.args : []),
  };

  const reject = async (status: number, error: string): Promise<RelayFailure> => {
    await appendAuditEntry({ ...audit, status: `rejected: ${error}` });
    return { ok: false, status, error };
  };

  const publicClient = createServerPublicClient();

  let divisions;
  let known;
  try {
    divisions = await loadDivisions(publicClient);
    // Inside the same guard: both a missing deployment record and an
    // unreachable chain are "the relay cannot see the contracts right now".
    known = buildKnownContracts(divisions);
  } catch (error) {
    return reject(503, error instanceof Error ? error.message : "Cannot reach the election chain.");
  }

  let gnDivisionContract: `0x${string}` | undefined;
  let gnAccount: GnAccountRecord | undefined;

  if (session.role === "gn") {
    const division = divisions.find(candidate => candidate.id === session.divisionId);
    if (!division) return reject(403, "Your division no longer exists on the registry.");
    gnDivisionContract = division.votingContract;

    try {
      gnAccount = await getAccountStore().findByUsername(session.username);
    } catch (error) {
      // A missing or malformed GN_KEY_ENCRYPTION_KEY, or an unreadable store,
      // is a server misconfiguration — report it as one instead of letting the
      // exception escape and become an opaque 500 with a stack trace.
      console.error("[relay] GN account store unavailable", error);
      return reject(503, "The GN account store is unavailable on this server.");
    }
    if (!gnAccount || gnAccount.disabled) {
      return reject(403, "This GN account no longer exists or has been disabled.");
    }

    // The relay holds the GN's key, but authority comes from the chain: if the
    // admin has not run `setGNOfficer` for this account, the transaction would
    // revert anyway. Failing here says so plainly instead.
    if (!division.gnOfficers.some(gn => gn.toLowerCase() === gnAccount!.address.toLowerCase())) {
      return reject(403, `Your account is not the on-chain GN officer for ${division.name}.`);
    }
  }

  const authorised = authorizeRelayCall({ role: session.role, request, known, gnDivisionContract });
  if (!authorised.ok) return reject(authorised.status, authorised.error);

  let privateKey: `0x${string}`;
  if (session.role === "admin") {
    const adminKey = resolveAdminKey();
    if (!adminKey.ok) return reject(adminKey.status, adminKey.error);
    privateKey = adminKey.privateKey;
  } else {
    try {
      privateKey = getAccountStore().decryptPrivateKey(gnAccount!);
    } catch (error) {
      console.error("[relay] could not unseal the GN signing key", error);
      return reject(503, "Your signing key could not be unsealed — check GN_KEY_ENCRYPTION_KEY on the server.");
    }
  }

  const walletClient = createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: serverChain,
    transport: http(serverChain.rpcUrls.default.http[0]),
  });

  try {
    const txHash = await walletClient.writeContract({
      address: authorised.contract.address as `0x${string}`,
      abi: authorised.contract.abi,
      functionName: authorised.abiFunction.name,
      args: authorised.args as never,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status !== "success") {
      await appendAuditEntry({ ...audit, txHash, blockNumber: receipt.blockNumber.toString(), status: "reverted" });
      return { ok: false, status: 400, error: "The transaction reverted on-chain." };
    }

    await appendAuditEntry({ ...audit, txHash, blockNumber: receipt.blockNumber.toString(), status: "success" });
    return { ok: true, txHash, blockNumber: receipt.blockNumber.toString(), status: "success" };
  } catch (error) {
    const { errorName, message } = describeRevert(error, authorised.contract.abi);
    await appendAuditEntry({ ...audit, status: `reverted: ${errorName ?? message}` });
    return { ok: false, status: 400, error: message, errorName };
  }
};
