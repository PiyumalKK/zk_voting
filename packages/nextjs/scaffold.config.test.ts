import { hardhat } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The swap switch itself (MASTER §8): flipping `NEXT_PUBLIC_CHAIN_BACKEND` must
 * repoint the whole app, and flipping it back must restore Hardhat exactly.
 *
 * The config and the chain object are both evaluated at import time, so each
 * case resets the module registry and re-imports.
 */
const loadConfig = async () => {
  vi.resetModules();
  return (await import("./scaffold.config")).default;
};

describe("scaffold.config target network", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to Hardhat when the backend is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "");
    const config = await loadConfig();
    expect(config.chainBackend).toBe("hardhat");
    expect(config.targetNetworks).toHaveLength(1);
    expect(config.targetNetworks[0].id).toBe(hardhat.id);
  });

  it("stays on Hardhat for any value other than 'custom'", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "Custom");
    const config = await loadConfig();
    expect(config.chainBackend).toBe("hardhat");
    expect(config.targetNetworks[0].id).toBe(hardhat.id);
  });

  it("points at the custom chain, with its env-supplied id and RPC URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "custom");
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "9494");
    vi.stubEnv("NEXT_PUBLIC_RPC_URL", "http://127.0.0.1:9545");

    const config = await loadConfig();
    expect(config.chainBackend).toBe("custom");
    expect(config.targetNetworks).toHaveLength(1);
    expect(config.targetNetworks[0].id).toBe(9494);
    expect(config.targetNetworks[0].rpcUrls.default.http[0]).toBe("http://127.0.0.1:9545");
    // The mainnet placeholder this replaced would have made every read hit a
    // public RPC while reporting success. Guard against it coming back.
    expect(config.targetNetworks[0].id).not.toBe(1);
  });

  it("honours a non-default chain id and RPC URL in custom mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "custom");
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "4242");
    vi.stubEnv("NEXT_PUBLIC_RPC_URL", "http://node.internal:9545");

    const config = await loadConfig();
    expect(config.targetNetworks[0].id).toBe(4242);
    expect(config.targetNetworks[0].rpcUrls.default.http[0]).toBe("http://node.internal:9545");
  });

  it("no longer carries the v1 REST base URL", async () => {
    const config = await loadConfig();
    expect(config).not.toHaveProperty("chainApiUrl");
  });
});
