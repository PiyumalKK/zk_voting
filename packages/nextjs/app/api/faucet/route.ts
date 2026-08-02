import { NextRequest, NextResponse } from "next/server";
import { createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveFaucetChainIds, serverChain, serverChainConfig } from "~~/utils/serverChain";

/**
 * POST /api/faucet   body: { address: "0x..." }
 *
 * DEV-ONLY faucet. Funds a fresh burner wallet with a little ETH so it can pay
 * gas for the anonymous vote() transaction.
 *
 * ⚠️ Local chains only. In production, burner gas is sponsored by an ERC-4337
 * paymaster / relayer — never by a server-held key. This route refuses to run on
 * any chain outside `FAUCET_CHAIN_IDS`.
 *
 * On the custom chain (9494) gas is free, so a burner does not strictly need
 * funding to vote — but the route still works there, because the genesis
 * prefunds the same 20 Hardhat mnemonic accounts this signs with (MASTER §3).
 * Keeping it enabled means the mobile app's funding step needs no mode branch.
 */

const { chainId: CHAIN_ID, rpcUrl: RPC_URL } = serverChainConfig;
const FAUCET_CHAIN_IDS = resolveFaucetChainIds(process.env.FAUCET_CHAIN_IDS);
const FUND_AMOUNT_ETH = "0.05";

// Well-known Hardhat account #0 (public test key — NOT a secret, local only).
const HARDHAT_ACCOUNT_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export async function POST(req: NextRequest) {
  if (!FAUCET_CHAIN_IDS.has(CHAIN_ID)) {
    return NextResponse.json(
      {
        error: `Faucet is disabled on chain ${CHAIN_ID}`,
        allowedChainIds: [...FAUCET_CHAIN_IDS],
      },
      { status: 403 },
    );
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
    const wallet = createWalletClient({ account, chain: serverChain, transport: http(RPC_URL) });
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
