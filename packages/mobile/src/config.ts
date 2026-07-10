/**
 * App configuration.
 *
 * For local development the API + RPC point at your machine. When testing on a
 * physical phone, replace `localhost` with your computer's LAN IP (e.g. 192.168.x.x)
 * so the phone can reach the Next.js API and the Hardhat node.
 */

// Set this to your dev machine's LAN IP when running on a real device.
const DEV_HOST = "http://localhost:3000";
const DEV_RPC = "http://localhost:8545";

export const CONFIG = {
  /** Base URL of the Next.js web app (serves /api/election, /api/merkle-path, /api/otp/*). */
  apiBaseUrl: process.env.EXPO_PUBLIC_API_URL ?? DEV_HOST,
  /** JSON-RPC endpoint of the election chain. */
  rpcUrl: process.env.EXPO_PUBLIC_RPC_URL ?? DEV_RPC,
  /** Chain id (Hardhat local = 31337). */
  chainId: Number(process.env.EXPO_PUBLIC_CHAIN_ID ?? 31337),
};

export const PHASE_LABELS = ["Setup", "Registration", "Voting", "Ended"] as const;
