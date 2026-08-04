/**
 * App configuration.
 *
 * Every value here is read from `EXPO_PUBLIC_*` at build time, so switching the
 * app between the two chain backends is an env change and nothing else — see
 * `00-MASTER.md` §7/§8. The fallbacks below are only a convenience for a
 * checkout with no env configured.
 *
 *   Hardhat mode (default):  EXPO_PUBLIC_CHAIN_ID=31337
 *                            EXPO_PUBLIC_RPC_URL=http://<LAN-IP>:8545
 *   Custom mode (Go node):   EXPO_PUBLIC_CHAIN_ID=9494
 *                            EXPO_PUBLIC_RPC_URL=http://<LAN-IP>:9545
 *
 * In both modes `EXPO_PUBLIC_API_URL` points at the Next.js app on :3000, which
 * must be running in the matching mode (`NEXT_PUBLIC_CHAIN_BACKEND`).
 *
 * `localhost` does not work from a physical phone or from the Android emulator —
 * both resolve it to the device itself. Use the dev machine's LAN IP (the same
 * one `expo start` prints) so the phone can reach the API and the node.
 */

// Set these to your dev machine's LAN IP when running on a real device.
const DEV_HOST = "http://192.168.43.186:3000";
const DEV_RPC = "http://192.168.43.186:8545";
const DEV_CHAIN_ID = 31337;

/**
 * `||`, not `??`: an env var set to the empty string must fall back. `FOO=` in a
 * `.env` file yields `""`, not `undefined`, and `""` would otherwise win.
 */
function envUrl(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

/**
 * A malformed chain id must fall back rather than become `NaN`. viem accepts a
 * `NaN` chain id without complaint and then fails later, somewhere unrelated —
 * transactions get signed for a chain that does not exist and the node rejects
 * them with an error that says nothing about configuration. The same trap was
 * found and fixed on the Next.js side in M11.
 */
function envChainId(value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const CONFIG = {
  /** Base URL of the Next.js web app (serves /api/election, /api/merkle-path, /api/otp/*). */
  apiBaseUrl: envUrl(process.env.EXPO_PUBLIC_API_URL, DEV_HOST),
  /** JSON-RPC endpoint of the election chain. */
  rpcUrl: envUrl(process.env.EXPO_PUBLIC_RPC_URL, DEV_RPC),
  /** Chain id — Hardhat local = 31337, the custom Go node = 9494. */
  chainId: envChainId(process.env.EXPO_PUBLIC_CHAIN_ID, DEV_CHAIN_ID),
};

/** Exported for tests: the resolution rules above, applied to an explicit env. */
export const __resolvers = { envUrl, envChainId, DEV_HOST, DEV_RPC, DEV_CHAIN_ID };

export const PHASE_LABELS = ["Setup", "Registration", "Voting", "Ended"] as const;
