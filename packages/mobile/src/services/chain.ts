import { createPublicClient, defineChain, encodeFunctionData, http } from "viem";
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
 */
async function sendLegacyTx(
  account: LocalAccount,
  to: `0x${string}`,
  data: `0x${string}`,
  gas: bigint,
): Promise<`0x${string}`> {
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
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
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

/** Submit register(commitment) signed by the voter's own key. */
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
  return sendLegacyTx(account, divisionContract, data, 600_000n);
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
  return sendLegacyTx(account, divisionContract, data, 15_000_000n);
}

export function newBurnerAccount() {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

