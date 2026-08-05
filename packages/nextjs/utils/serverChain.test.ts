import {
  DEFAULT_SERVER_CHAIN_ID,
  DEFAULT_SERVER_RPC_URL,
  resolveFaucetChainIds,
  resolveServerChainConfig,
} from "./serverChain";
import { describe, expect, it } from "vitest";

describe("resolveServerChainConfig", () => {
  it("defaults to Hardhat, so a checkout with no .env.local is unchanged", () => {
    expect(resolveServerChainConfig()).toEqual({
      chainId: DEFAULT_SERVER_CHAIN_ID,
      rpcUrl: DEFAULT_SERVER_RPC_URL,
    });
    expect(DEFAULT_SERVER_CHAIN_ID).toBe(31337);
    expect(DEFAULT_SERVER_RPC_URL).toBe("http://127.0.0.1:8545");
  });

  it("switches wholesale to the custom column", () => {
    expect(resolveServerChainConfig({ chainId: "9494", publicRpcUrl: "http://127.0.0.1:9545" })).toEqual({
      chainId: 9494,
      rpcUrl: "http://127.0.0.1:9545",
    });
  });

  /**
   * The regression this pair exists for.
   *
   * The browser (`utils/customChain.ts`) defaults to 9494/:9545 as soon as the
   * backend switch says `custom`. The server used to default to Hardhat no
   * matter what, so flipping only `NEXT_PUBLIC_CHAIN_BACKEND` split the two
   * halves of the app across different chains — and because `deployedContracts`
   * need not carry 31337 at all, every relay call died on "ElectionRegistry is
   * not deployed on chain 31337" while the pages rendered fine.
   */
  it("follows the backend switch when the chain id is not set", () => {
    expect(resolveServerChainConfig({ backend: "custom" })).toEqual({
      chainId: 9494,
      rpcUrl: "http://127.0.0.1:9545",
    });
  });

  it("still honours an explicit chain id and RPC over the backend's defaults", () => {
    expect(
      resolveServerChainConfig({ backend: "custom", chainId: "4242", publicRpcUrl: "http://elsewhere:1234" }),
    ).toEqual({
      chainId: 4242,
      rpcUrl: "http://elsewhere:1234",
    });
  });

  it.each(["hardhat", "", "  ", "HARDHAT-ish", undefined])("keeps the Hardhat defaults for backend %p", backend => {
    expect(resolveServerChainConfig({ backend })).toEqual({
      chainId: DEFAULT_SERVER_CHAIN_ID,
      rpcUrl: DEFAULT_SERVER_RPC_URL,
    });
  });

  it("prefers the server-only RPC_URL over the public one", () => {
    expect(
      resolveServerChainConfig({
        chainId: "9494",
        rpcUrl: "http://sequencer:9545",
        publicRpcUrl: "http://127.0.0.1:9545",
      }).rpcUrl,
    ).toBe("http://sequencer:9545");
  });

  it("falls through a blank RPC_URL to the public one", () => {
    expect(resolveServerChainConfig({ rpcUrl: "  ", publicRpcUrl: "http://replica:9555" }).rpcUrl).toBe(
      "http://replica:9555",
    );
  });

  it("falls back rather than yielding a NaN chain id", () => {
    expect(resolveServerChainConfig({ chainId: "not-a-number" }).chainId).toBe(DEFAULT_SERVER_CHAIN_ID);
  });
});

describe("resolveFaucetChainIds", () => {
  it("defaults to both local chains", () => {
    expect([...resolveFaucetChainIds(undefined)].sort((a, b) => a - b)).toEqual([9494, 31337]);
  });

  it("treats a blank value as unset", () => {
    expect([...resolveFaucetChainIds("   ")].sort((a, b) => a - b)).toEqual([9494, 31337]);
  });

  it("parses an explicit list, tolerating whitespace", () => {
    expect([...resolveFaucetChainIds(" 31337 , 9494 ")].sort((a, b) => a - b)).toEqual([9494, 31337]);
  });

  it("can narrow the allowlist to a single chain", () => {
    const ids = resolveFaucetChainIds("9494");
    expect(ids.has(9494)).toBe(true);
    expect(ids.has(31337)).toBe(false);
  });

  it("drops malformed entries instead of admitting NaN", () => {
    const ids = resolveFaucetChainIds("31337,,abc,-5,0,9494");
    expect([...ids].sort((a, b) => a - b)).toEqual([9494, 31337]);
    expect([...ids].some(Number.isNaN)).toBe(false);
  });

  it("yields an empty allowlist for wholly invalid input, disabling the faucet", () => {
    // Fail closed: a typo must not accidentally enable funding on a live chain.
    expect(resolveFaucetChainIds("mainnet").size).toBe(0);
  });
});
