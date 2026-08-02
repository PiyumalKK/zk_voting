import { describeRevert } from "./relayExecutor";
import { BaseError, encodeErrorResult } from "viem";
import type { Abi } from "viem";
import { describe, expect, it } from "vitest";

/**
 * Revert decoding.
 *
 * The admin and GN pages match on Solidity custom-error *names* as substrings
 * (`NicRegistry__AlreadyUsed`, `WrongPhase`, …). If the relay flattens a revert
 * into a generic message, every one of those branches silently stops firing and
 * operators get "Transaction failed" for problems the UI knows how to explain.
 * These cases pin the shapes our node actually produces.
 */

const ABI = [
  { type: "error", name: "Voting__WrongPhase", inputs: [] },
  { type: "error", name: "NicRegistry__AlreadyUsed", inputs: [{ name: "nicHash", type: "bytes32" }] },
] as const satisfies Abi;

const wrongPhaseData = encodeErrorResult({ abi: ABI, errorName: "Voting__WrongPhase" });

describe("describeRevert", () => {
  it("decodes a custom error from a raw `data` payload on the cause", () => {
    // The shape our node returns: a reverting transaction is rejected at
    // `eth_sendRawTransaction` rather than mined (MASTER §10.2), so viem never
    // gets to build a decoded ContractFunctionRevertedError.
    const error = new BaseError("execution reverted", {
      cause: { data: wrongPhaseData } as unknown as Error,
    });

    expect(describeRevert(error, ABI as unknown as Abi)).toEqual({
      errorName: "Voting__WrongPhase",
      message: "Voting__WrongPhase",
    });
  });

  it("finds the payload further down the cause chain", () => {
    const error = new BaseError("execution reverted", {
      cause: new BaseError("rpc error", {
        cause: { data: { data: wrongPhaseData } } as unknown as Error,
      }),
    });

    expect(describeRevert(error, ABI as unknown as Abi).errorName).toBe("Voting__WrongPhase");
  });

  it("decodes an error carrying arguments", () => {
    const data = encodeErrorResult({
      abi: ABI,
      errorName: "NicRegistry__AlreadyUsed",
      args: [`0x${"11".repeat(32)}`],
    });
    const error = new BaseError("execution reverted", { cause: { data } as unknown as Error });

    expect(describeRevert(error, ABI as unknown as Abi).errorName).toBe("NicRegistry__AlreadyUsed");
  });

  it("falls back to the short message when there is no revert payload", () => {
    const error = new BaseError("Connection refused");
    const result = describeRevert(error, ABI as unknown as Abi);

    expect(result.errorName).toBeUndefined();
    expect(result.message).toContain("Connection refused");
  });

  it("ignores payloads this contract's ABI cannot decode", () => {
    const error = new BaseError("execution reverted", {
      cause: { data: "0xdeadbeef" } as unknown as Error,
    });

    expect(describeRevert(error, ABI as unknown as Abi).errorName).toBeUndefined();
  });

  it("survives a self-referential cause chain", () => {
    const error = new BaseError("looping");
    (error as { cause?: unknown }).cause = error;

    expect(() => describeRevert(error, ABI as unknown as Abi)).not.toThrow();
  });

  it("handles non-Error values without throwing", () => {
    expect(describeRevert("something went wrong", ABI as unknown as Abi).message).toBe("something went wrong");
  });
});
