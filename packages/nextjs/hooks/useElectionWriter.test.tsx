import { resetElectionAuthCache } from "./useElectionAuth";
import { ElectionWriteError, toJsonSafeArg, toRelayPayload, useElectionWriter } from "./useElectionWriter";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The write half of the M12 seam — the branch that decides whether a
 * transaction is signed by the operator's MetaMask or by the server relay.
 *
 * Two properties are load-bearing beyond "it works":
 *
 * 1. In hardhat mode nothing may reach `/api/relay`, and the wallet path must
 *    stay exactly what it was before M12.
 * 2. In custom mode the ABI must **not** travel to the server. The relay
 *    re-derives it from `deployedContracts.ts`; accepting a client ABI would
 *    let a session encode arbitrary calldata under a whitelisted function name.
 */

const VOTING_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const TX_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000001" as const;

const VOTING_ABI = [
  {
    name: "startVoting",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "duration", type: "uint256" }],
    outputs: [],
  },
] as const;

const writeContract = vi.fn();
const waitForTransactionReceipt = vi.fn();
const getWalletClientMock = vi.fn();

vi.mock("wagmi/actions", () => ({ getWalletClient: (...args: unknown[]) => getWalletClientMock(...args) }));
vi.mock("~~/services/web3/wagmiConfig", () => ({ wagmiConfig: { mock: true } }));
vi.mock("~~/hooks/scaffold-eth/useTargetNetwork", () => ({
  useTargetNetwork: () => ({
    targetNetwork: { id: 9494, name: "ZK Election Chain", rpcUrls: { default: { http: ["http://127.0.0.1:9545"] } } },
  }),
}));
vi.mock("viem", async importOriginal => {
  const actual = await importOriginal<typeof import("viem")>();
  return { ...actual, createPublicClient: () => ({ waitForTransactionReceipt }), http: () => ({}) };
});

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;

const request = (args: unknown[] = [3600n]) => ({
  address: VOTING_CONTRACT,
  abi: VOTING_ABI as unknown as import("viem").Abi,
  functionName: "startVoting",
  args,
});

beforeEach(() => {
  resetElectionAuthCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  writeContract.mockReset().mockResolvedValue(TX_HASH);
  waitForTransactionReceipt.mockReset().mockResolvedValue({ status: "success" });
  getWalletClientMock.mockReset().mockResolvedValue({ writeContract });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("toJsonSafeArg", () => {
  it("renders bigints as decimal strings so JSON.stringify does not throw", () => {
    expect(toJsonSafeArg(3600n)).toBe("3600");
  });

  it("does not round values past Number.MAX_SAFE_INTEGER", () => {
    const huge = 2n ** 200n;
    expect(toJsonSafeArg(huge)).toBe(huge.toString());
  });

  it("walks nested arrays, which is how addVoters arrives", () => {
    expect(toJsonSafeArg([["0xabc", 1n], [true]])).toEqual([["0xabc", "1"], [true]]);
  });

  it("leaves addresses, booleans and strings untouched", () => {
    expect(toJsonSafeArg(VOTING_CONTRACT)).toBe(VOTING_CONTRACT);
    expect(toJsonSafeArg(false)).toBe(false);
    expect(toJsonSafeArg("Kaduwela")).toBe("Kaduwela");
  });
});

describe("toRelayPayload", () => {
  it("sends only target, function name and arguments", () => {
    expect(toRelayPayload(request())).toEqual({ target: VOTING_CONTRACT, fn: "startVoting", args: ["3600"] });
  });

  it("omits the ABI entirely", () => {
    expect(Object.keys(toRelayPayload(request()))).toEqual(["target", "fn", "args"]);
  });

  it("treats a missing args list as empty rather than undefined", () => {
    expect(toRelayPayload({ address: VOTING_CONTRACT, abi: [], functionName: "endElection" }).args).toEqual([]);
  });
});

describe("useElectionWriter — hardhat mode", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "hardhat"));

  it("signs with the connected wallet and waits for the receipt", async () => {
    const { result } = renderHook(() => useElectionWriter());

    const hash = await result.current.write(request());

    expect(hash).toBe(TX_HASH);
    expect(writeContract).toHaveBeenCalledWith({
      address: VOTING_CONTRACT,
      abi: VOTING_ABI,
      functionName: "startVoting",
      args: [3600n],
    });
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: TX_HASH });
  });

  it("passes bigints through untouched — no relay serialisation on this path", async () => {
    const { result } = renderHook(() => useElectionWriter());

    await result.current.write(request([3600n]));

    expect(writeContract.mock.calls[0][0].args).toEqual([3600n]);
  });

  it("never contacts the relay", async () => {
    const { result } = renderHook(() => useElectionWriter());

    await result.current.write(request());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.isCustom).toBe(false);
  });

  it("explains a missing wallet the way the pages already expect", async () => {
    getWalletClientMock.mockResolvedValue(null);
    const { result } = renderHook(() => useElectionWriter());

    await expect(result.current.write(request())).rejects.toThrow("No wallet connected");
  });

  it("lets a viem revert propagate unchanged, so custom-error matching still works", async () => {
    writeContract.mockRejectedValue(Object.assign(new Error("x"), { shortMessage: "Voting__WrongPhase" }));
    const { result } = renderHook(() => useElectionWriter());

    await expect(result.current.write(request())).rejects.toMatchObject({ shortMessage: "Voting__WrongPhase" });
  });
});

describe("useElectionWriter — custom mode", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "custom"));

  it("posts the call to the relay and returns the transaction hash", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ txHash: TX_HASH, blockNumber: "12", status: "success" }));
    const { result } = renderHook(() => useElectionWriter());

    const hash = await result.current.write(request());

    expect(hash).toBe(TX_HASH);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/relay");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(init.body)).toEqual({ target: VOTING_CONTRACT, fn: "startVoting", args: ["3600"] });
  });

  it("never asks the wallet for a signature", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ txHash: TX_HASH }));
    const { result } = renderHook(() => useElectionWriter());

    await result.current.write(request());

    expect(getWalletClientMock).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("keeps the custom-error name as the message so page matching survives", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Voting__WrongPhase", errorName: "Voting__WrongPhase" }, 400));
    const { result } = renderHook(() => useElectionWriter());

    await expect(result.current.write(request())).rejects.toMatchObject({
      message: "Voting__WrongPhase",
      shortMessage: "Voting__WrongPhase",
      errorName: "Voting__WrongPhase",
    });
  });

  it("shows the relay's own refusal when there is no revert to decode", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "You may only act on your own division." }, 403));
    const { result } = renderHook(() => useElectionWriter());

    await expect(result.current.write(request())).rejects.toThrow("You may only act on your own division.");
  });

  it("drops the cached session on 401 so the UI stops showing a signed-in operator", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Sign in to continue." }, 401));
    const { result } = renderHook(() => useElectionWriter());

    await expect(result.current.write(request())).rejects.toMatchObject({ status: 401 });
  });

  it("explains an unreachable server instead of surfacing 'Failed to fetch'", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useElectionWriter());

    await expect(result.current.write(request())).rejects.toThrow(/signing service/i);
  });

  it("refuses a success response with no transaction hash", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "success" }));
    const { result } = renderHook(() => useElectionWriter());

    await expect(result.current.write(request())).rejects.toThrow(/no transaction hash/i);
  });

  it("reports a rate-limit refusal verbatim", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Too many transactions in the last minute." }, 429));
    const { result } = renderHook(() => useElectionWriter());

    await expect(result.current.write(request())).rejects.toMatchObject({
      status: 429,
      message: "Too many transactions in the last minute.",
    });
  });

  it("still throws something readable when the body is not JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);
    const { result } = renderHook(() => useElectionWriter());

    await expect(result.current.write(request())).rejects.toBeInstanceOf(ElectionWriteError);
  });
});
