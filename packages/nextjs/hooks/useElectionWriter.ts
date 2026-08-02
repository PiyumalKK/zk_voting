"use client";

import { useCallback, useMemo } from "react";
import { createPublicClient, http } from "viem";
import type { Abi } from "viem";
import { getWalletClient } from "wagmi/actions";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { resetElectionAuthCache } from "~~/hooks/useElectionAuth";
import { wagmiConfig } from "~~/services/web3/wagmiConfig";
import { ChainMode, getChainMode } from "~~/utils/chainMode";

/**
 * The single write seam (`01-AUTH-DESIGN.md` §3, M12 build-order item 4).
 *
 * Every admin and GN transaction in the app goes through `write()`, and this is
 * the only place that knows there are two ways to sign one:
 *
 * - **hardhat** — the pre-M12 path, moved here rather than rewritten: fetch the
 *   connected wallet from wagmi, `writeContract`, await the receipt. MetaMask
 *   behaviour is unchanged, which is the locked decision in MASTER §1.
 * - **custom** — `POST /api/relay`. The browser sends only the target address,
 *   the function name and the arguments; the server re-derives the ABI from
 *   `deployedContracts.ts`, checks the call against the role whitelist, signs
 *   with the role's key and waits for the receipt.
 *
 * The `abi` field is required in both modes but is used **only** by the hardhat
 * path. The relay deliberately ignores any client-supplied ABI — accepting one
 * would let a session encode arbitrary calldata for a whitelisted function name.
 */

export interface ElectionWriteRequest {
  /** Contract to call. In custom mode the relay re-checks this against the addresses it knows. */
  address: `0x${string}`;
  /** Used by the hardhat path to encode calldata locally. Ignored in custom mode, by design. */
  abi: Abi;
  functionName: string;
  args?: unknown[];
}

export interface ElectionWriter {
  mode: ChainMode;
  isCustom: boolean;
  /** Resolves once the transaction is mined, with its hash. Throws {@link ElectionWriteError} on failure. */
  write: (request: ElectionWriteRequest) => Promise<`0x${string}`>;
}

/**
 * A failed write, shaped so existing UI error handling keeps working.
 *
 * The admin and GN pages match on `e?.shortMessage || e?.message` and look for
 * Solidity custom-error names as substrings (`NicRegistry__AlreadyUsed`,
 * `WrongPhase`, …). Carrying `shortMessage` as well as `message` means those
 * checks behave identically whether the error came from viem or from the relay.
 */
export class ElectionWriteError extends Error {
  readonly shortMessage: string;
  readonly status?: number;
  readonly errorName?: string;

  constructor(message: string, options: { status?: number; errorName?: string } = {}) {
    super(message);
    this.name = "ElectionWriteError";
    this.shortMessage = message;
    this.status = options.status;
    this.errorName = options.errorName;
  }
}

/**
 * Makes one argument safe to put in a JSON body without losing precision.
 *
 * `JSON.stringify` throws on a `bigint`, and durations, timestamps and
 * `uint256` values reach this code as bigints. Decimal strings are what
 * `relayPolicy.coerceArg` expects and re-coerces to `bigint` server-side, so
 * nothing is lost — whereas `Number(value)` would quietly round anything past
 * 2^53.
 */
export const toJsonSafeArg = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafeArg);
  return value;
};

export interface RelayPayload {
  target: string;
  fn: string;
  args: unknown[];
}

/** Builds the relay request body. Pure — unit tested against `relayPolicy`'s expectations. */
export const toRelayPayload = (request: ElectionWriteRequest): RelayPayload => ({
  target: request.address,
  fn: request.functionName,
  args: (request.args ?? []).map(toJsonSafeArg),
});

/**
 * Turns a relay error response into the error the pages expect.
 *
 * `errorName` wins over `error` as the message because that is the string the
 * pages substring-match; the server sends both so this side does not have to
 * parse prose.
 */
export const relayErrorFrom = (status: number, body: unknown): ElectionWriteError => {
  const payload = (body ?? {}) as { error?: unknown; errorName?: unknown };
  const errorName = typeof payload.errorName === "string" ? payload.errorName : undefined;
  const serverError = typeof payload.error === "string" ? payload.error : undefined;

  if (status === 401) {
    return new ElectionWriteError(serverError ?? "Your session has expired. Sign in again to continue.", {
      status,
      errorName,
    });
  }

  return new ElectionWriteError(errorName ?? serverError ?? `The relay refused the transaction (${status}).`, {
    status,
    errorName,
  });
};

export const useElectionWriter = (): ElectionWriter => {
  const mode = getChainMode();
  const { targetNetwork } = useTargetNetwork();

  // Bound to the configured target network rather than the wallet's connected
  // chain — the same reasoning as `useDivisions`, and the only correct choice in
  // custom mode where there is no wallet to ask.
  const publicClient = useMemo(
    () => createPublicClient({ chain: targetNetwork, transport: http(targetNetwork.rpcUrls.default.http[0]) }),
    [targetNetwork],
  );

  const writeViaWallet = useCallback(
    async ({ address, abi, functionName, args }: ElectionWriteRequest): Promise<`0x${string}`> => {
      const walletClient = await getWalletClient(wagmiConfig);
      if (!walletClient) throw new ElectionWriteError("No wallet connected");
      const hash = await walletClient.writeContract({
        address,
        abi,
        functionName,
        args: args ?? [],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      return hash;
    },
    [publicClient],
  );

  const writeViaRelay = useCallback(async (request: ElectionWriteRequest): Promise<`0x${string}`> => {
    let response: Response;
    try {
      response = await fetch("/api/relay", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toRelayPayload(request)),
      });
    } catch {
      throw new ElectionWriteError("Could not reach the signing service. Is the Next.js server running?");
    }

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      // A 401 means the cookie expired mid-shift. Dropping the cached session
      // makes the header and every page gate re-evaluate immediately, instead
      // of showing an identity that can no longer sign anything.
      if (response.status === 401) resetElectionAuthCache();
      throw relayErrorFrom(response.status, body);
    }

    const txHash = (body as { txHash?: unknown }).txHash;
    if (typeof txHash !== "string") {
      throw new ElectionWriteError("The relay reported success but returned no transaction hash.");
    }
    return txHash as `0x${string}`;
  }, []);

  const write = useCallback(
    (request: ElectionWriteRequest) => (mode === "custom" ? writeViaRelay(request) : writeViaWallet(request)),
    [mode, writeViaRelay, writeViaWallet],
  );

  return { mode, isCustom: mode === "custom", write };
};
