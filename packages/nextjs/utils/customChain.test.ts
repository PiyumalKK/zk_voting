import {
  CUSTOM_CHAIN_NAME,
  DEFAULT_CUSTOM_CHAIN_ID,
  DEFAULT_CUSTOM_RPC_URL,
  isLocalChainId,
  parseChainId,
  resolveCustomChain,
} from "./customChain";
import { hardhat, mainnet } from "viem/chains";
import { describe, expect, it } from "vitest";

describe("parseChainId", () => {
  it("accepts a positive integer", () => {
    expect(parseChainId("9494", 1)).toBe(9494);
    expect(parseChainId(" 31337 ", 1)).toBe(31337);
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["non-numeric", "abc"],
    ["fractional", "9494.5"],
    ["zero", "0"],
    ["negative", "-1"],
  ])("falls back on %s rather than producing NaN", (_label, raw) => {
    expect(parseChainId(raw, 4242)).toBe(4242);
  });
});

describe("resolveCustomChain", () => {
  it("defaults to the documented chain id and RPC URL (MASTER §7)", () => {
    const chain = resolveCustomChain();
    expect(chain.id).toBe(DEFAULT_CUSTOM_CHAIN_ID);
    expect(chain.id).toBe(9494);
    expect(chain.rpcUrls.default.http[0]).toBe(DEFAULT_CUSTOM_RPC_URL);
    expect(chain.name).toBe(CUSTOM_CHAIN_NAME);
  });

  it("takes both values from the environment", () => {
    const chain = resolveCustomChain({ chainId: "1234", rpcUrl: "http://node.internal:9545" });
    expect(chain.id).toBe(1234);
    expect(chain.rpcUrls.default.http[0]).toBe("http://node.internal:9545");
  });

  it("ignores a blank RPC URL instead of producing an unusable transport", () => {
    expect(resolveCustomChain({ rpcUrl: "   " }).rpcUrls.default.http[0]).toBe(DEFAULT_CUSTOM_RPC_URL);
  });

  it("exposes 18-decimal ETH so viem formats balances the same as on Hardhat", () => {
    expect(resolveCustomChain().nativeCurrency).toEqual({ name: "Ether", symbol: "ETH", decimals: 18 });
  });
});

describe("isLocalChainId", () => {
  it("treats Hardhat and the custom chain as local", () => {
    expect(isLocalChainId(hardhat.id)).toBe(true);
    expect(isLocalChainId(DEFAULT_CUSTOM_CHAIN_ID)).toBe(true);
  });

  it("rejects public networks", () => {
    expect(isLocalChainId(mainnet.id)).toBe(false);
    expect(isLocalChainId(11155111)).toBe(false);
  });
});
