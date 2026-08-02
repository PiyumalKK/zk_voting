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
