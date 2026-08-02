import { Chain, defineChain } from "viem";
import { hardhat } from "viem/chains";

/**
 * The custom Go blockchain node (`packages/blockchain`) as a viem `Chain`.
 *
 * The node speaks the Ethereum JSON-RPC subset this app uses, so from the
 * frontend's point of view it is simply another EVM chain — the *only*
 * difference from Hardhat is its id and RPC URL, both of which come from the
 * environment. That is what makes MASTER §8's "swap is an env-var change only"
 * promise hold without any source edits.
 *
 * Defaults match `00-MASTER.md` §7: chain id 9494, RPC on port 9545.
 */

export const CUSTOM_CHAIN_NAME = "ZK Election Chain";
export const DEFAULT_CUSTOM_CHAIN_ID = 9494;
export const DEFAULT_CUSTOM_RPC_URL = "http://127.0.0.1:9545";

export interface CustomChainEnv {
  /** `NEXT_PUBLIC_CHAIN_ID` */
  chainId?: string;
  /** `NEXT_PUBLIC_RPC_URL` */
  rpcUrl?: string;
}

/**
 * Parses a chain id from an environment string.
 *
 * Anything that is not a positive integer (missing, blank, `"abc"`, `"0"`,
 * `"9494.5"`) falls back rather than producing a `NaN` chain id, which viem
 * would happily accept and every subsequent RPC call would then fail on in a
 * way that points nowhere near the actual mistake.
 */
export const parseChainId = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** Builds the custom chain from explicit env values. Pure — unit tested. */
export const resolveCustomChain = (env: CustomChainEnv = {}): Chain =>
  defineChain({
    id: parseChainId(env.chainId, DEFAULT_CUSTOM_CHAIN_ID),
    name: CUSTOM_CHAIN_NAME,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [env.rpcUrl?.trim() || DEFAULT_CUSTOM_RPC_URL] } },
    // Not a real testnet, but this is what tells wallets and scaffold-eth
    // helpers to treat it as a development chain rather than mainnet.
    testnet: true,
  });

/**
 * The configured custom chain.
 *
 * `process.env.NEXT_PUBLIC_*` is read with literal member access because Next.js
 * inlines these at build time only in that form — destructuring or dynamic
 * lookup would leave `undefined` in the browser bundle.
 */
export const customChain: Chain = resolveCustomChain({
  chainId: process.env.NEXT_PUBLIC_CHAIN_ID,
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL,
});

/**
 * True for chains served from a local development node — Hardhat and our own.
 *
 * Scaffold-eth used to test `chainId === hardhat.id` in four places to decide
 * whether to show the burner wallet, skip polling, and link to the built-in
 * block explorer. All four are equally true of the custom chain, so they all
 * ask this instead.
 */
export const isLocalChainId = (chainId: number): boolean => chainId === hardhat.id || chainId === customChain.id;
