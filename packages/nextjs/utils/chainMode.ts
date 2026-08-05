/**
 * The swap switch, resolved in one place (MASTER §8, `01-AUTH-DESIGN.md` §1).
 *
 * `NEXT_PUBLIC_CHAIN_BACKEND` decides far more than which RPC URL to dial: in
 * `custom` mode the admin and GN officers have no wallet at all, so the pages
 * gate on a session cookie, writes go through the server relay, and the
 * RainbowKit button is not rendered. In `hardhat` mode every one of those paths
 * must behave exactly as it did before M12 — the locked decision in MASTER §1.
 *
 * Two rules this module exists to enforce:
 *
 * 1. **One spelling of the check.** `mode === "custom"` scattered through
 *    components drifts; `getChainMode()` does not.
 * 2. **Read at call time, never at module load.** Tests flip
 *    `process.env.NEXT_PUBLIC_CHAIN_BACKEND` between cases, and a
 *    module-level constant would freeze whichever value happened to be set
 *    when the first import ran.
 *
 * The literal `process.env.NEXT_PUBLIC_CHAIN_BACKEND` member access has to stay
 * here rather than being passed in from callers: Next.js only inlines
 * `NEXT_PUBLIC_*` into the client and Edge bundles when it can see the literal
 * expression, so a computed lookup would read `undefined` in the browser.
 */

export type ChainMode = "hardhat" | "custom";

/** Anything that is not exactly `custom` means hardhat — an unset or typo'd value must not silently disable MetaMask. */
export const resolveChainMode = (raw: string | undefined): ChainMode =>
  raw?.trim().toLowerCase() === "custom" ? "custom" : "hardhat";

export const getChainMode = (): ChainMode => resolveChainMode(process.env.NEXT_PUBLIC_CHAIN_BACKEND);

export const isCustomMode = (): boolean => getChainMode() === "custom";

/** Where each role belongs after signing in. Shared by the login page and the middleware's role bounce. */
export const homePathForRole = (role: "admin" | "gn"): string => (role === "admin" ? "/voting/admin" : "/gn");
