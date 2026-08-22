import { createPublicClient, decodeErrorResult, defineChain, encodeFunctionData, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CONFIG } from "../config";

/**
 * On-chain service — registration and voting transactions.
 *
 * Registration is signed by the voter's OWN key (they are on the division's
 * allowlist). Voting is submitted from a FRESH burner wallet so the on-chain
 * `msg.sender` cannot be linked back to the voter — anonymity comes from the ZK
 * proof, not from the sender. In production the burner's gas is sponsored by a
 * relayer / ERC-4337 paymaster; on the local chain it must be funded manually.
 *
 * IMPORTANT (React Native / Hermes): we build, sign and send a LEGACY transaction
 * entirely by hand. viem's higher-level `writeContract` triggers automatic gas +
 * EIP-1559 fee estimation whose RPC requests are malformed under Hermes (hardhat
 * rejects them with "invalid parameters"). Manual signing avoids every one of
 * those estimation calls — only nonce, gasPrice and sendRawTransaction are used.
 */

const chain = defineChain({
  id: CONFIG.chainId,
  name: "Election Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpcUrl] } },
});

const publicClient = createPublicClient({ chain, transport: http(CONFIG.rpcUrl) });

type LocalAccount = ReturnType<typeof privateKeyToAccount>;

/**
 * Manually build → sign → send a legacy transaction. No auto gas/fee estimation.
 *
 * Reports whether the transaction reverted rather than assuming it did not: with
 * a fixed gas limit and no `eth_estimateGas`, a call that a contract refuses is
 * still mined, and its receipt is the only place that shows it.
 */
async function sendLegacyTx(
  account: LocalAccount,
  to: `0x${string}`,
  data: `0x${string}`,
  gas: bigint,
): Promise<{ hash: `0x${string}`; reverted: boolean }> {
  const [nonce, gasPrice] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address }),
    publicClient.getGasPrice().catch(() => 1_000_000_000n),
  ]);

  const serializedTransaction = await account.signTransaction({
    chainId: CONFIG.chainId,
    to,
    data,
    gas,
    gasPrice,
    nonce,
    value: 0n,
    type: "legacy",
  });

  const hash = await publicClient.sendRawTransaction({ serializedTransaction });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, reverted: receipt.status !== "success" };
}

/**
 * The refusals `register()` can produce that a voter can act on.
 *
 * A reverted transaction carries no reason in its receipt, so the reason has to
 * be recovered by replaying the call with `eth_call`. Worth the extra round trip
 * only on the failure path: the difference between "you were never enrolled",
 * "your phone was replaced" and "you have already registered" is the difference
 * between going to the GN office, not going, and doing nothing at all.
 */
const REGISTER_ERROR_ABI = [
  { type: "error", name: "Voting__NotAllowedToVote", inputs: [] },
  { type: "error", name: "Voting__CommitmentAlreadyAdded", inputs: [{ name: "commitment", type: "uint256" }] },
  {
    type: "error",
    name: "Voting__WrongPhase",
    inputs: [
      { name: "expected", type: "uint8" },
      { name: "actual", type: "uint8" },
    ],
  },
  {
    type: "error",
    name: "NicRegistry__DeviceSuperseded",
    inputs: [
      { name: "device", type: "address" },
      { name: "nicHash", type: "bytes32" },
    ],
  },
  { type: "error", name: "NicRegistry__AlreadyRegistered", inputs: [{ name: "nicHash", type: "bytes32" }] },
  {
    type: "error",
    name: "NicRegistry__EpochChanged",
    inputs: [
      { name: "expected", type: "uint256" },
      { name: "actual", type: "uint256" },
    ],
  },
] as const;

const REGISTER_ERROR_MESSAGES: Record<string, string> = {
  NicRegistry__DeviceSuperseded:
    "This phone is no longer your registered device. A replacement was issued for your NIC, so only the newer " +
    "phone can register. If you still have it, use that one; otherwise see your GN officer.",
  NicRegistry__AlreadyRegistered:
    "You have already registered for this election on another device. A registration cannot be moved between " +
    "phones, so there is nothing more to do — but you will not be able to vote from this one.",
  NicRegistry__EpochChanged:
    "Enrolment records were reset while registration was open. Registration is paused for your division until " +
    "the Election Authority restarts it.",
  Voting__NotAllowedToVote:
    "This phone is not on the voter roll for your division, or it has already registered. Ask your GN officer " +
    "to confirm they added this phone's voting address.",
  Voting__WrongPhase: "Registration is not open for your division right now.",
  Voting__CommitmentAlreadyAdded: "This registration was already recorded. Restart the app and check your status.",
};

/** Replay a reverted call to recover the contract's own reason for refusing. */
async function explainRevert(
  from: `0x${string}`,
  to: `0x${string}`,
  data: `0x${string}`,
  fallback: string,
): Promise<string> {
  try {
    await publicClient.call({ account: from, to, data });
    // The replay succeeded, so the cause was transient (a re-org, or another
    // transaction landing first) rather than a rule. Say the generic thing.
    return fallback;
  } catch (error) {
    const raw = findRevertData(error);
    if (!raw) return fallback;
    try {
      const decoded = decodeErrorResult({ abi: REGISTER_ERROR_ABI, data: raw });
      return REGISTER_ERROR_MESSAGES[decoded.errorName] ?? fallback;
    } catch {
      // A revert this build does not know about — a plain require string, or an
      // error added to a contract since. Generic advice beats a hex blob.
      return fallback;
    }
  }
}

/**
 * Dig the raw revert bytes out of whatever viem threw.
 *
 * viem wraps an RPC error in several layers whose exact shape depends on the
 * transport and the node, and the payload sits at `.data` on one of them —
 * sometimes as a hex string, sometimes as `{ data: "0x…" }`. Walking the cause
 * chain and taking the first thing that looks like revert bytes is stable across
 * all of those, which matching one fixed path is not.
 */
function findRevertData(error: unknown): `0x${string}` | null {
  let node: any = error;
  for (let depth = 0; node && depth < 8; depth++) {
    const candidate = typeof node.data === "string" ? node.data : node.data?.data;
    if (typeof candidate === "string" && candidate.startsWith("0x") && candidate.length >= 10) {
      return candidate as `0x${string}`;
    }
    node = node.cause;
  }
  return null;
}

const REGISTER_ABI = [
  { name: "register", type: "function", stateMutability: "nonpayable", inputs: [{ name: "_commitment", type: "uint256" }], outputs: [] },
] as const;

const VOTE_ABI = [
  {
    name: "vote",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_proof", type: "bytes" },
      { name: "_nullifierHash", type: "bytes32" },
      { name: "_root", type: "bytes32" },
      { name: "_vote", type: "bytes32" },
      { name: "_depth", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/**
 * Submit register(commitment) signed by the voter's own key.
 *
 * Throws on an on-chain revert. The receipt used to be awaited and discarded,
 * which meant a refused registration looked exactly like a successful one and
 * the caller went on to mark the device registered. That mattered little while
 * the only refusal was "not allowlisted"; it matters a great deal now that a
 * phone replaced under `NicRegistry.reissueDevice` reaches this point and is
 * turned away.
 */
export async function submitRegister(
  divisionContract: `0x${string}`,
  commitment: string,
  privateKey: `0x${string}`,
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(privateKey);
  const data = encodeFunctionData({
    abi: REGISTER_ABI,
    functionName: "register",
    args: [BigInt(commitment)],
  });
  const { hash, reverted } = await sendLegacyTx(account, divisionContract, data, 600_000n);
  if (reverted) {
    throw new Error(
      await explainRevert(
        account.address,
        divisionContract,
        data,
        "The network rejected your registration. Please try again, or see your GN officer.",
      ),
    );
  }
  return hash;
}

export interface VotePayload {
  proof: `0x${string}`;
  nullifierHash: `0x${string}`;
  root: `0x${string}`;
  vote: `0x${string}`;
  depth: `0x${string}`;
}

/**
 * Submit vote() from a fresh burner wallet.
 * `burnerPrivateKey` defaults to a new random key; it must hold gas.
 */
export async function submitVote(
  divisionContract: `0x${string}`,
  payload: VotePayload,
  burnerPrivateKey: `0x${string}` = generatePrivateKey(),
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(burnerPrivateKey);
  const data = encodeFunctionData({
    abi: VOTE_ABI,
    functionName: "vote",
    args: [payload.proof, payload.nullifierHash, payload.root, payload.vote, payload.depth],
  });
  // Honk proof verification is gas-heavy; use a generous fixed limit.
  const { hash, reverted } = await sendLegacyTx(account, divisionContract, data, 15_000_000n);
  if (reverted) throw new Error("The network rejected your vote. It was not counted.");
  return hash;
}

export function newBurnerAccount() {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

