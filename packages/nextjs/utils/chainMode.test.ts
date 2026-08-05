import { getChainMode, homePathForRole, isCustomMode, resolveChainMode } from "./chainMode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCustomChainMode } from "~~/services/auth/session";

/**
 * The swap switch. Every no-wallet behaviour in M12 hangs off this one value,
 * so the important cases are the ones where it must *not* say "custom".
 */

afterEach(() => vi.unstubAllEnvs());

describe("resolveChainMode", () => {
  it("recognises the custom backend", () => {
    expect(resolveChainMode("custom")).toBe("custom");
  });

  it("tolerates surrounding whitespace and casing from a hand-edited .env", () => {
    expect(resolveChainMode("  Custom  ")).toBe("custom");
    expect(resolveChainMode("CUSTOM")).toBe("custom");
  });

  it("defaults to hardhat when unset — a fresh checkout must behave as it did before M12", () => {
    expect(resolveChainMode(undefined)).toBe("hardhat");
    expect(resolveChainMode("")).toBe("hardhat");
  });

  it("treats a typo as hardhat rather than half-enabling no-wallet mode", () => {
    expect(resolveChainMode("cutsom")).toBe("hardhat");
    expect(resolveChainMode("zkchain")).toBe("hardhat");
  });
});

describe("getChainMode", () => {
  it("reads the environment at call time, not at import time", () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "hardhat");
    expect(getChainMode()).toBe("hardhat");

    vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "custom");
    expect(getChainMode()).toBe("custom");
    expect(isCustomMode()).toBe(true);
  });
});

describe("server and client agree", () => {
  it("services/auth/session answers the same question as utils/chainMode", () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "custom");
    expect(isCustomChainMode()).toBe(isCustomMode());

    vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "hardhat");
    expect(isCustomChainMode()).toBe(isCustomMode());
  });
});

describe("homePathForRole", () => {
  it("sends each role somewhere its own middleware rule allows", () => {
    expect(homePathForRole("admin")).toBe("/voting/admin");
    expect(homePathForRole("gn")).toBe("/gn");
  });
});
