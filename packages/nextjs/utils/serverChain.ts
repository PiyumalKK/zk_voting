import { Chain, defineChain } from "viem";
import { parseChainId } from "~~/utils/customChain";

/**
 * Server-side chain configuration for the API routes.
 *
 * The routes under `app/api/` run on the Next.js server and talk to whichever
 * chain the deployment is pointed at. They must never hardcode a chain id or
 * RPC URL — that is the single rule that keeps MASTER §8's swap procedure an
 * env-only change. This module is the one place those two values are resolved.
 *
 * Defaults are the **Hardhat** ones, because `hardhat` is the default backend:
 * a checkout with no `.env.local` behaves exactly as it did before M11.
 *
 * `RPC_URL` (server-only) wins over `NEXT_PUBLIC_RPC_URL` when both are set, so
 * the server can reach the node on an address the browser cannot — e.g. a
 * container hostname, or a replica's port while the browser reads the primary.
 */

export const DEFAULT_SERVER_CHAIN_ID = 31337;
export const DEFAULT_SERVER_RPC_URL = "http://127.0.0.1:8545";

/** Chain ids the dev faucet is willing to fund on. See MASTER §7. */
export const DEFAULT_FAUCET_CHAIN_IDS = "31337,9494";

export interface ServerChainEnv {
  /** `NEXT_PUBLIC_CHAIN_ID` */
  chainId?: string;
  /** `RPC_URL` — server-only override. */
  rpcUrl?: string;
  /** `NEXT_PUBLIC_RPC_URL` — used when `RPC_URL` is unset. */
  publicRpcUrl?: string;
}

export interface ServerChainConfig {
  chainId: number;
  rpcUrl: string;
}

/** Resolves the server's chain id and RPC URL from explicit env values. Pure — unit tested. */
export const resolveServerChainConfig = (env: ServerChainEnv = {}): ServerChainConfig => ({
  chainId: parseChainId(env.chainId, DEFAULT_SERVER_CHAIN_ID),
  rpcUrl: env.rpcUrl?.trim() || env.publicRpcUrl?.trim() || DEFAULT_SERVER_RPC_URL,
});

/**
 * Parses `FAUCET_CHAIN_IDS` into a set of chain ids.
 *
 * Malformed entries are dropped rather than silently widening the allowlist to
 * `NaN` (which compares false against everything and would disable the faucet)
 * or throwing at import time (which would take down the whole route).
 */
export const resolveFaucetChainIds = (raw: string | undefined): Set<number> => {
  const source = raw?.trim() ? raw : DEFAULT_FAUCET_CHAIN_IDS;
  const ids = source
    .split(",")
    .map(part => Number(part.trim()))
    .filter(id => Number.isInteger(id) && id > 0);
  return new Set(ids);
};

/** The configured chain id / RPC URL for this server process. */
export const serverChainConfig: ServerChainConfig = resolveServerChainConfig({
  chainId: process.env.NEXT_PUBLIC_CHAIN_ID,
  rpcUrl: process.env.RPC_URL,
  publicRpcUrl: process.env.NEXT_PUBLIC_RPC_URL,
});

/**
 * A minimal viem `Chain` for the configured server chain.
 *
 * Only the write paths need it (viem requires a chain to sign a transaction);
 * reads go through a chainless `createPublicClient`, exactly as before.
 */
export const serverChain: Chain = defineChain({
  id: serverChainConfig.chainId,
  name: `Chain ${serverChainConfig.chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [serverChainConfig.rpcUrl] } },
  testnet: true,
});
