import { Chain, defineChain } from "viem";
import { resolveChainMode } from "~~/utils/chainMode";
import { DEFAULT_CUSTOM_CHAIN_ID, DEFAULT_CUSTOM_RPC_URL, parseChainId } from "~~/utils/customChain";

/**
 * Server-side chain configuration for the API routes.
 *
 * The routes under `app/api/` run on the Next.js server and talk to whichever
 * chain the deployment is pointed at. They must never hardcode a chain id or
 * RPC URL — that is the single rule that keeps MASTER §8's swap procedure an
 * env-only change. This module is the one place those two values are resolved.
 *
 * **The defaults follow `NEXT_PUBLIC_CHAIN_BACKEND`**, and that is the point.
 * They used to be Hardhat's unconditionally, while the browser's
 * (`utils/customChain.ts`) defaulted to the custom chain whenever the backend
 * switch said `custom`. Setting only `NEXT_PUBLIC_CHAIN_BACKEND=custom` — which
 * is what "the swap is an env-var change" implies — therefore left the browser
 * on 9494/:9545 and the server on 31337/:8545, and every relay call failed with
 * "ElectionRegistry is not deployed on chain 31337" while the pages looked
 * perfectly healthy. The two modules now agree by construction.
 *
 * `RPC_URL` (server-only) wins over `NEXT_PUBLIC_RPC_URL` when both are set, so
 * the server can reach the node on an address the browser cannot — e.g. a
 * container hostname, or a replica's port while the browser reads the primary.
 */

export const DEFAULT_HARDHAT_CHAIN_ID = 31337;
export const DEFAULT_HARDHAT_RPC_URL = "http://127.0.0.1:8545";

/**
 * The historical names, kept pointing at the Hardhat column.
 *
 * They are what "no configuration at all" still resolves to, because an unset
 * backend means hardhat.
 */
export const DEFAULT_SERVER_CHAIN_ID = DEFAULT_HARDHAT_CHAIN_ID;
export const DEFAULT_SERVER_RPC_URL = DEFAULT_HARDHAT_RPC_URL;

/** Chain ids the dev faucet is willing to fund on. See MASTER §7. */
export const DEFAULT_FAUCET_CHAIN_IDS = "31337,9494";

export interface ServerChainEnv {
  /** `NEXT_PUBLIC_CHAIN_ID` */
  chainId?: string;
  /** `RPC_URL` — server-only override. */
  rpcUrl?: string;
  /** `NEXT_PUBLIC_RPC_URL` — used when `RPC_URL` is unset. */
  publicRpcUrl?: string;
  /** `NEXT_PUBLIC_CHAIN_BACKEND` — decides which column the defaults come from. */
  backend?: string;
}

export interface ServerChainConfig {
  chainId: number;
  rpcUrl: string;
}

/** Resolves the server's chain id and RPC URL from explicit env values. Pure — unit tested. */
export const resolveServerChainConfig = (env: ServerChainEnv = {}): ServerChainConfig => {
  const isCustom = resolveChainMode(env.backend) === "custom";
  const defaultChainId = isCustom ? DEFAULT_CUSTOM_CHAIN_ID : DEFAULT_HARDHAT_CHAIN_ID;
  const defaultRpcUrl = isCustom ? DEFAULT_CUSTOM_RPC_URL : DEFAULT_HARDHAT_RPC_URL;

  return {
    chainId: parseChainId(env.chainId, defaultChainId),
    rpcUrl: env.rpcUrl?.trim() || env.publicRpcUrl?.trim() || defaultRpcUrl,
  };
};

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
  backend: process.env.NEXT_PUBLIC_CHAIN_BACKEND,
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
