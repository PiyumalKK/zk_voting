import { getDeployedAddress, lookupDeployedAddress, normalizeAddressOverride } from "./deployedAddress";
import { describe, expect, it } from "vitest";

const RECORD = {
  31337: { NicRegistry: { address: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707" } },
  9494: { NicRegistry: { address: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707" } },
  4242: { ElectionRegistry: { address: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9" } },
};

describe("normalizeAddressOverride", () => {
  it("passes a real address through", () => {
    expect(normalizeAddressOverride("0xabc")).toBe("0xabc");
    expect(normalizeAddressOverride("  0xabc  ")).toBe("0xabc");
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("treats %s as absent, not as a configured value", (_label, raw) => {
    // The regression this file exists for. `NEXT_PUBLIC_FOO=` in a .env file
    // yields "", and `"" ?? fallback` returns "" — so the fallback never ran and
    // the page reported the contract as undeployed.
    expect(normalizeAddressOverride(raw)).toBeUndefined();
  });
});

describe("lookupDeployedAddress", () => {
  it("finds a contract on the requested chain", () => {
    expect(lookupDeployedAddress(RECORD, 31337, "NicRegistry")).toBe("0x5FC8d32690cc91D4c39d9d3abcBD16989F875707");
    expect(lookupDeployedAddress(RECORD, 9494, "NicRegistry")).toBe("0x5FC8d32690cc91D4c39d9d3abcBD16989F875707");
  });

  it("returns undefined for an unknown chain or contract, rather than throwing", () => {
    expect(lookupDeployedAddress(RECORD, 999, "NicRegistry")).toBeUndefined();
    expect(lookupDeployedAddress(RECORD, 31337, "NoSuchContract")).toBeUndefined();
  });

  it("does not leak one chain's address to another", () => {
    // 4242 has no NicRegistry; it must not fall through to 31337's.
    expect(lookupDeployedAddress(RECORD, 4242, "NicRegistry")).toBeUndefined();
    expect(lookupDeployedAddress(RECORD, 31337, "ElectionRegistry")).toBeUndefined();
  });

  it("honours a non-empty override", () => {
    expect(lookupDeployedAddress(RECORD, 31337, "NicRegistry", "0xdeadbeef")).toBe("0xdeadbeef");
  });

  it("falls back to the deployment record when the override is blank", () => {
    expect(lookupDeployedAddress(RECORD, 31337, "NicRegistry", "")).toBe("0x5FC8d32690cc91D4c39d9d3abcBD16989F875707");
    expect(lookupDeployedAddress(RECORD, 31337, "NicRegistry", "   ")).toBe(
      "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
    );
  });
});

describe("the real deployedContracts record", () => {
  it("carries NicRegistry on both chains, so GN registration works in either mode", () => {
    for (const chainId of [31337, 9494]) {
      expect(getDeployedAddress(chainId, "NicRegistry"), `NicRegistry missing for chain ${chainId}`).toMatch(
        /^0x[0-9a-fA-F]{40}$/,
      );
    }
  });

  it("carries ElectionRegistry on both chains", () => {
    for (const chainId of [31337, 9494]) {
      expect(getDeployedAddress(chainId, "ElectionRegistry"), `ElectionRegistry missing for chain ${chainId}`).toMatch(
        /^0x[0-9a-fA-F]{40}$/,
      );
    }
  });
});
