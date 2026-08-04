import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resolvers } from "./config";

const { envUrl, envChainId, DEV_HOST, DEV_RPC, DEV_CHAIN_ID } = __resolvers;

/**
 * M13's promise is that the mobile app moves between chain backends on env
 * alone. These tests pin the resolution rules that promise rests on — in
 * particular the two ways an env var lies about being absent: the empty string,
 * and a value that does not parse.
 */

describe("envUrl", () => {
  it("prefers the environment value", () => {
    expect(envUrl("http://10.0.0.5:9545", DEV_RPC)).toBe("http://10.0.0.5:9545");
  });

  it("falls back when the variable is absent", () => {
    expect(envUrl(undefined, DEV_RPC)).toBe(DEV_RPC);
  });

  it("falls back on the empty string rather than producing an empty URL", () => {
    // `EXPO_PUBLIC_RPC_URL=` in a .env file yields "", not undefined. With `??`
    // that empty string would win and every RPC call would go nowhere.
    expect(envUrl("", DEV_RPC)).toBe(DEV_RPC);
  });

  it("falls back on whitespace", () => {
    expect(envUrl("   ", DEV_HOST)).toBe(DEV_HOST);
  });

  it("trims a stray trailing space instead of signing it into the URL", () => {
    expect(envUrl(" http://10.0.0.5:9545 ", DEV_RPC)).toBe("http://10.0.0.5:9545");
  });
});

describe("envChainId", () => {
  it("reads the custom chain id", () => {
    expect(envChainId("9494", DEV_CHAIN_ID)).toBe(9494);
  });

  it("reads the hardhat chain id", () => {
    expect(envChainId("31337", DEV_CHAIN_ID)).toBe(31337);
  });

  it("falls back when the variable is absent", () => {
    expect(envChainId(undefined, DEV_CHAIN_ID)).toBe(DEV_CHAIN_ID);
  });

  it("falls back on the empty string", () => {
    // Number("") is 0, not NaN — a distinct trap from the one below, and one
    // that would sign transactions for chain 0.
    expect(envChainId("", DEV_CHAIN_ID)).toBe(DEV_CHAIN_ID);
  });

  it("falls back on a malformed value instead of yielding NaN", () => {
    // The bug this guards: viem accepts a NaN chain id silently, then every
    // signature is for a chain that does not exist and the node's rejection
    // says nothing about configuration.
    expect(envChainId("nine-four-nine-four", DEV_CHAIN_ID)).toBe(DEV_CHAIN_ID);
    expect(Number.isNaN(envChainId("abc", DEV_CHAIN_ID))).toBe(false);
  });

  it("falls back on zero and on negative ids", () => {
    expect(envChainId("0", DEV_CHAIN_ID)).toBe(DEV_CHAIN_ID);
    expect(envChainId("-1", DEV_CHAIN_ID)).toBe(DEV_CHAIN_ID);
  });

  it("falls back on a non-integer id", () => {
    expect(envChainId("94.94", DEV_CHAIN_ID)).toBe(DEV_CHAIN_ID);
  });

  it("trims surrounding whitespace", () => {
    expect(envChainId(" 9494 ", DEV_CHAIN_ID)).toBe(9494);
  });
});

describe("CONFIG", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("defaults to hardhat mode with no environment set", async () => {
    delete process.env.EXPO_PUBLIC_API_URL;
    delete process.env.EXPO_PUBLIC_RPC_URL;
    delete process.env.EXPO_PUBLIC_CHAIN_ID;

    const { CONFIG } = await import("./config");

    expect(CONFIG.chainId).toBe(31337);
    expect(CONFIG.rpcUrl).toBe(DEV_RPC);
    expect(CONFIG.apiBaseUrl).toBe(DEV_HOST);
  });

  it("switches wholesale to the custom chain on env alone", async () => {
    // This is M13's acceptance criterion expressed as a test: the three
    // variables in the milestone's step 1, and nothing else.
    process.env.EXPO_PUBLIC_API_URL = "http://192.168.1.20:3000";
    process.env.EXPO_PUBLIC_RPC_URL = "http://192.168.1.20:9545";
    process.env.EXPO_PUBLIC_CHAIN_ID = "9494";

    const { CONFIG } = await import("./config");

    expect(CONFIG).toEqual({
      apiBaseUrl: "http://192.168.1.20:3000",
      rpcUrl: "http://192.168.1.20:9545",
      chainId: 9494,
    });
  });
});
