import * as chains from "viem/chains";

export type BaseConfig = {
  targetNetworks: readonly chains.Chain[];
  pollingInterval: number;
  alchemyApiKey: string;
  rpcOverrides?: Record<number, string>;
  walletConnectProjectId: string;
  burnerWalletMode: "localNetworksOnly" | "allNetworks" | "disabled";
  /**
   * Which blockchain backend the voting UI talks to:
   * - "hardhat": Ethereum via wagmi/viem (Hardhat local node or Sepolia) — the original Scaffold-ETH path
   * - "custom":  the Go blockchain node's REST API (packages/blockchain) — no wallets, no gas
   * Switch with NEXT_PUBLIC_CHAIN_BACKEND=custom; the voting UI adapts through
   * the hooks in services/chain/ with no component changes.
   */
  chainBackend: "hardhat" | "custom";
  /** Base URL of the Go node's public API (custom backend only). */
  chainApiUrl: string;
};

export type ScaffoldConfig = BaseConfig;

export const DEFAULT_ALCHEMY_API_KEY = "cR4WnXePioePZ5fFrnSiR";

const scaffoldConfig = {
  // The networks on which your DApp is live
  // Static type is pinned to the hardhat tuple so scaffold-eth's contract-type
  // inference keeps working (deployedContracts is 31337-only); at runtime the
  // custom backend swaps in mainnet. Both are Chain-shaped, so wagmi still works.
  targetNetworks: (process.env.NEXT_PUBLIC_CHAIN_BACKEND === "custom"
    ? [chains.mainnet]
    : [chains.hardhat]) as readonly [typeof chains.hardhat],
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
  // - "localNetworksOnly": only show when all target networks are local (hardhat/anvil)
  // - "allNetworks": show on any configured target networks
  // - "disabled": completely disable
  burnerWalletMode: "localNetworksOnly",
  // Chain backend selection — the plug-and-play switch (see services/chain/).
  chainBackend: process.env.NEXT_PUBLIC_CHAIN_BACKEND === "custom" ? "custom" : "hardhat",
  chainApiUrl: process.env.NEXT_PUBLIC_CHAIN_API_URL || "http://localhost:3001",
} as const satisfies ScaffoldConfig;

export default scaffoldConfig;
