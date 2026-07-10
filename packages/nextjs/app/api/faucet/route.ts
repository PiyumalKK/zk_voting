import { NextRequest, NextResponse } from "next/server";
import { createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * POST /api/faucet   body: { address: "0x..." }
 *
 * DEV-ONLY faucet. Funds a fresh burner wallet with a little ETH so it can pay
 * gas for the anonymous vote() transaction on the LOCAL Hardhat chain.
 *
 * ⚠️ Local chain only. In production, burner gas is sponsored by an ERC-4337
 * paymaster / relayer — never by a server-held key. This route refuses to run on
 * any non-local chain id.
 */

const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337);
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const FUND_AMOUNT_ETH = "0.05";

// Well-known Hardhat account #0 (public test key — NOT a secret, local only).
const HARDHAT_ACCOUNT_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const localChain = {
  id: CHAIN_ID,
  name: "Hardhat",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;

export async function POST(req: NextRequest) {
  if (CHAIN_ID !== 31337) {
    return NextResponse.json({ error: "Faucet is disabled on non-local chains" }, { status: 403 });
  }

  let address: string | undefined;
  try {
    ({ address } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "Valid `address` is required" }, { status: 400 });
  }

  try {
    const account = privateKeyToAccount(HARDHAT_ACCOUNT_0);
    const wallet = createWalletClient({ account, chain: localChain, transport: http(RPC_URL) });
    const hash = await wallet.sendTransaction({
      to: address as `0x${string}`,
      value: parseEther(FUND_AMOUNT_ETH),
    });
    return NextResponse.json({ funded: true, address, amount: FUND_AMOUNT_ETH, txHash: hash });
  } catch (error) {
    console.error("[/api/faucet] error:", error);
    return NextResponse.json({ error: "Failed to fund address" }, { status: 500 });
  }
}
