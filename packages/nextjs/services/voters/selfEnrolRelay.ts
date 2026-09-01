import { createWalletClient, http } from "viem";
import type { Abi, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import deployedContracts from "~~/contracts/deployedContracts";
import { appendAuditEntry, serialiseArgs } from "~~/services/auth/auditLog";
import { createServerPublicClient } from "~~/services/auth/relayContracts";
import type { DivisionSummary } from "~~/services/auth/relayContracts";
import { describeRevert, resolveAdminKey } from "~~/services/auth/relayExecutor";
import type { RelayOutcome } from "~~/services/auth/relayExecutor";
import { serverChain, serverChainConfig } from "~~/utils/serverChain";

/**
 * Signs `reserveNicHash` + `addVoters` for a self-enrolment claim
 * (`app/api/self-enrol/route.ts`) — deliberately **not** routed through
 * `executeRelayCall`/`relayPolicy.ts`.
 *
 * Those two are session-shaped: they authorise a *GN officer* to act on
 * *their own* division. A claim-token request has no GN session — the token
 * itself, verified and checked against `EnrolmentInviteStore` before this is
 * ever called, is the entire authorization. Teaching `relayPolicy.ts` about a
 * non-session caller would widen its trusted-caller model for one route;
 * this stays a small, self-contained function instead.
 *
 * Signing with `ADMIN_RELAY_PRIVATE_KEY` is on-chain-valid for both calls:
 * `NicRegistry.onlyOwnerOrGN` and `Voting.onlyOwnerOrGN` both accept the
 * contract owner as well as the division's GN officer, and the admin relay
 * key is that owner (it is the deploying account — see `01-AUTH-DESIGN.md` §4
 * and the comment on `ADMIN_RELAY_PRIVATE_KEY` in `.env.example`).
 */

/**
 * Full deployed ABIs, not minimal hand-rolled ones — `describeRevert` needs
 * every custom-error definition alongside the function to decode a revert
 * into a name (`Voting__SetupOrRegistrationRequired`, `NicRegistry__AlreadyUsed`,
 * …) instead of an opaque 4-byte selector. `relayContracts.ts` makes the same
 * choice for the same reason.
 */
type DeployedEntry = { address: `0x${string}`; abi: Abi };

const deployedEntry = (name: "NicRegistry" | "Voting"): DeployedEntry | undefined =>
  (deployedContracts as unknown as Record<number, Record<string, DeployedEntry>>)[serverChainConfig.chainId]?.[name];

export interface SelfEnrolInput {
  nicHash: `0x${string}`;
  device: `0x${string}`;
  division: DivisionSummary;
}

const audit = async (
  fn: string,
  args: readonly unknown[],
  outcome: { txHash?: `0x${string}`; blockNumber?: bigint; status: string },
) =>
  appendAuditEntry({
    ts: new Date().toISOString(),
    role: "system",
    username: "self-enrol",
    target: fn,
    fn,
    args: serialiseArgs(args),
    txHash: outcome.txHash,
    blockNumber: outcome.blockNumber?.toString(),
    status: outcome.status,
  });

interface PreparedCall {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/** Runs one write and waits for its receipt, translating a revert the same way `executeRelayCall` does. */
const runWrite = async (
  walletClient: WalletClient,
  publicClient: PublicClient,
  call: PreparedCall,
): Promise<RelayOutcome> => {
  try {
    const txHash = await walletClient.writeContract({
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
      chain: walletClient.chain,
      account: walletClient.account!,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      await audit(call.functionName, call.args, {
        txHash,
        blockNumber: receipt.blockNumber,
        status: "reverted",
      });
      return { ok: false, status: 400, error: "The transaction reverted on-chain." };
    }
    await audit(call.functionName, call.args, { txHash, blockNumber: receipt.blockNumber, status: "success" });
    return { ok: true, txHash, blockNumber: receipt.blockNumber.toString(), status: "success" };
  } catch (error) {
    const { errorName, message } = describeRevert(error, call.abi);
    await audit(call.functionName, call.args, { status: `reverted: ${errorName ?? message}` });
    return { ok: false, status: 400, error: message, errorName };
  }
};

/**
 * Reserves the NIC hash for `device` and allowlists it — the same two writes
 * `gn/register/page.tsx`'s `handleSubmit` performs, run back-to-back here
 * because a claim link has no officer standing by to retry a half-completed
 * enrolment.
 */
export const executeSelfEnrol = async ({ nicHash, device, division }: SelfEnrolInput): Promise<RelayOutcome> => {
  const adminKey = resolveAdminKey();
  if (!adminKey.ok) return { ok: false, status: adminKey.status, error: adminKey.error };

  const nicRegistry = deployedEntry("NicRegistry");
  if (!nicRegistry?.address) {
    return { ok: false, status: 503, error: `No NicRegistry deployed on chain ${serverChainConfig.chainId}.` };
  }
  const voting = deployedEntry("Voting");
  if (!voting?.abi) {
    return { ok: false, status: 503, error: `No Voting ABI recorded for chain ${serverChainConfig.chainId}.` };
  }

  const walletClient = createWalletClient({
    account: privateKeyToAccount(adminKey.privateKey),
    chain: serverChain,
    transport: http(serverChain.rpcUrls.default.http[0]),
  });
  const publicClient = createServerPublicClient();

  const reserve = await runWrite(walletClient, publicClient, {
    address: nicRegistry.address,
    abi: nicRegistry.abi,
    functionName: "reserveNicHash",
    args: [nicHash, division.votingContract, device],
  });
  if (!reserve.ok) return reserve;

  return runWrite(walletClient, publicClient, {
    address: division.votingContract,
    abi: voting.abi,
    functionName: "addVoters",
    args: [[device], [true]],
  });
};
