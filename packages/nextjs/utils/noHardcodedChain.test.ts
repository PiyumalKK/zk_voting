import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * The regression net for MASTER §8: "swapping Hardhat ⇄ custom chain is an
 * env-var change only".
 *
 * That promise is broken one literal at a time — a `chain: hardhat`, a
 * `http://127.0.0.1:8545`, a `deployedContracts[31337]`. Each is invisible in
 * Hardhat mode (where it happens to be correct) and silently wrong in custom
 * mode. This test scans the source tree for them so a future change fails here
 * rather than during a demo.
 *
 * Adding a file to an allowlist below is a deliberate act: state the reason.
 */

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const SCANNED_DIRS = ["app", "components", "hooks", "utils", "services"];

/** Files permitted to mention chain 31337 or port 8545, with the reason. */
const CHAIN_LITERAL_ALLOWLIST: Record<string, string> = {
  "utils/serverChain.ts": "defines the Hardhat defaults every other module reads",
  "utils/serverChain.test.ts": "asserts those defaults",
  "utils/customChain.test.ts": "asserts Hardhat is recognised as local",
  "utils/deployedAddress.test.ts": "asserts both chains' deployment records by id",
  "utils/noHardcodedChain.test.ts": "this file",
};

/** Files permitted to branch on `hardhat.id`, with the reason. */
const HARDHAT_ID_ALLOWLIST: Record<string, string> = {
  "utils/customChain.ts": "isLocalChainId is the one place the comparison belongs",
  "utils/customChain.test.ts": "asserts isLocalChainId's behaviour",
  "utils/noHardcodedChain.test.ts": "this file",
  "utils/scaffold-eth/networks.ts": "keys the per-chain display metadata map; not a branch",
  "components/scaffold-eth/Faucet.tsx":
    "deliberately Hardhat-only: funds via eth_sendTransaction with a node-held key, which the custom node does not implement",
  "components/scaffold-eth/FaucetButton.tsx": "same as Faucet.tsx",
};

/**
 * Files permitted to use `??` against `process.env`, with the reason.
 *
 * These are **known defects of the same class**, left alone because they sit
 * outside M11's scope — not because they are correct. Fixing one means deleting
 * its line here, not adding another.
 */
const ENV_FALLBACK_ALLOWLIST: Record<string, string> = {
  "services/otp/otpService.ts":
    "pre-existing, outside M11: OTP_SIGNING_SECRET= (empty) would be used verbatim as the HMAC key instead of falling back. Security-relevant; raise separately.",
};

/**
 * Strips comments before matching.
 *
 * The point of this test is to catch chain literals in *code*. Flagging them in
 * prose would make the codebase harder to explain, which is the opposite of what
 * the guard is for — several of the comments below exist precisely to record why
 * a value used to be hardcoded.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const listSourceFiles = (dir: string): string[] => {
  const absolute = path.join(PACKAGE_ROOT, dir);
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry)) {
        out.push(path.relative(PACKAGE_ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  walk(absolute);
  return out;
};

const sourceFiles = SCANNED_DIRS.flatMap(listSourceFiles);

const offenders = (pattern: RegExp, allowlist: Record<string, string>) =>
  sourceFiles
    .filter(file => !(file in allowlist))
    .filter(file => pattern.test(stripComments(readFileSync(path.join(PACKAGE_ROOT, file), "utf8"))));

describe("no hardcoded chain configuration", () => {
  it("finds source files to scan at all", () => {
    // Guards against the scan silently passing because the walk found nothing.
    expect(sourceFiles.length).toBeGreaterThan(20);
  });

  it("has no hardcoded chain id 31337", () => {
    expect(offenders(/\b31337\b/, CHAIN_LITERAL_ALLOWLIST)).toEqual([]);
  });

  it("has no hardcoded Hardhat RPC endpoint", () => {
    expect(offenders(/(?:https?|ws):\/\/(?:127\.0\.0\.1|localhost):8545/, CHAIN_LITERAL_ALLOWLIST)).toEqual([]);
  });

  it("has no WebSocket RPC transport", () => {
    // The custom node implements no eth_subscribe (MASTER §9); every consumer polls.
    expect(offenders(/\bwebSocket\s*\(/, {})).toEqual([]);
  });

  it("branches on hardhat.id only where documented", () => {
    expect(offenders(/\bhardhat\.id\b/, HARDHAT_ID_ALLOWLIST)).toEqual([]);
  });

  it("has no imports left from the deleted v1 REST layer", () => {
    expect(offenders(/~~\/services\/chain\b/, {})).toEqual([]);
  });

  it("never falls back from an environment variable with ??", () => {
    // `FOO=` in a .env file yields the empty string, not undefined, so
    // `process.env.FOO ?? fallback` evaluates to "" and the fallback never runs.
    // This shipped once — `NEXT_PUBLIC_NIC_REGISTRY_ADDRESS=` made GN
    // registration report the contract as undeployed. Use `?.trim() || …`.
    expect(offenders(/process\.env\.[A-Z0-9_]+\s*\?\?/, ENV_FALLBACK_ALLOWLIST)).toEqual([]);
  });

  it("resolves contract addresses per chain, not from a bare env var", () => {
    // A single env var cannot hold an address that is correct on both chains.
    expect(offenders(/process\.env\.[A-Z0-9_]*ADDRESS[A-Z0-9_]*\s*as\s*`0x/, {})).toEqual([]);
  });
});
