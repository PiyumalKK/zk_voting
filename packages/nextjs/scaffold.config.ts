import * as chains from "viem/chains";
import { customChain } from "~~/utils/customChain";

export type BaseConfig = {
  targetNetworks: readonly chains.Chain[];
  pollingInterval: number;
  alchemyApiKey: string;
  rpcOverrides?: Record<number, string>;
  walletConnectProjectId: string;
  burnerWalletMode: "localNetworksOnly" | "allNetworks" | "disabled";
  /**
   * Which chain the app is pointed at:
   * - "hardhat": the local Hardhat node on chain 31337 (the Scaffold-ETH default)
   * - "custom":  the Go blockchain node (packages/blockchain) on chain 9494
   *
   * Both are plain EVM chains reached over JSON-RPC, so nothing downstream
   * branches on this beyond picking the target network — switching is an
   * env-var change with no source edits (MASTER §8).
   */
  chainBackend: "hardhat" | "custom";
};

export type ScaffoldConfig = BaseConfig;

export const DEFAULT_ALCHEMY_API_KEY = "cR4WnXePioePZ5fFrnSiR";

const scaffoldConfig = {
  // The networks on which your DApp is live.
  //
  // The static type stays pinned to the hardhat tuple so scaffold-eth's
  // contract-type inference keeps resolving against a single chain key; at
  // runtime the custom backend swaps in the Go node's chain. Both are
  // Chain-shaped and `deployedContracts.ts` carries entries for 31337 *and*
  // 9494, so contract lookups succeed in either mode.
  targetNetworks: (process.env.NEXT_PUBLIC_CHAIN_BACKEND === "custom" ? [customChain] : [chains.hardhat]) as readonly [
    typeof chains.hardhat,
  ],
  // The interval at which your front-end polls the RPC servers for new data (it has no effect if you only target the local network (default is 4000))
  pollingInterval: 3000,
  // This is ours Alchemy's default API key.
  // You can get your own at https://dashboard.alchemyapi.io
  // It's recommended to store it in an env variable:
  // .env.local for local testing, and in the Vercel/system env config for live apps.
  alchemyApiKey: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || DEFAULT_ALCHEMY_API_KEY,
  // If you want to use a different RPC for a specific network, you can add it here.
  // The key is the chain ID, and the value is the HTTP RPC URL
  rpcOverrides: {
    // Example:
    // [chains.mainnet.id]: "https://mainnet.rpc.buidlguidl.com",
  },
  // This is ours WalletConnect's default project ID.
  // You can get your own at https://cloud.walletconnect.com
  // It's recommended to store it in an env variable:
  // .env.local for local testing, and in the Vercel/system env config for live apps.
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || "3a8170812b534d0ff9d794f19a901d64",
  // Configure Burner Wallet visibility:
  // - "localNetworksOnly": only show when all target networks are local (hardhat/custom)
  // - "allNetworks": show on any configured target networks
  // - "disabled": completely disable
  burnerWalletMode: "localNetworksOnly",
  // Chain backend selection — the swap switch (MASTER §7).
  chainBackend: process.env.NEXT_PUBLIC_CHAIN_BACKEND === "custom" ? "custom" : "hardhat",
} as const satisfies ScaffoldConfig;

export default scaffoldConfig;
