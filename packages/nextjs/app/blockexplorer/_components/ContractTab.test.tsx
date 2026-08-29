import { ContractSourceTab } from "./ContractSourceTab";
import { ReadContractTab } from "./ReadContractTab";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HydratedContract } from "~~/utils/blockexplorer/contractSources";

/**
 * The block explorer's transparency surface.
 *
 * The point of these two tabs is that a sceptical reader can check the election
 * without trusting the operator: read the deployed source, then read the live
 * state. Both halves are asserted here because both are load-bearing claims —
 * and because neither renders server-side (they sit behind a tab), so a page
 * fetch cannot catch a regression in them.
 */

const readContract = vi.fn();

vi.mock("~~/hooks/scaffold-eth/useTargetNetwork", () => ({
  useTargetNetwork: () => ({ targetNetwork: { id: 9494, rpcUrls: { default: { http: ["http://127.0.0.1:9545"] } } } }),
}));

vi.mock("~~/hooks/scaffold-eth/useFetchBlocks", () => ({
  createBlockExplorerClient: () => ({ readContract: (...args: unknown[]) => readContract(...args) }),
}));

const VOTING_ABI = [
  { type: "function", name: "currentPhase", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "getCandidates",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string[]" }],
  },
  {
    type: "function",
    name: "isNullifierUsed",
    stateMutability: "view",
    inputs: [{ name: "nullifierHash", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "vote",
    stateMutability: "nonpayable",
    inputs: [{ name: "candidate", type: "uint256" }],
    outputs: [],
  },
] as unknown as HydratedContract["abi"];

const CONTRACT: HydratedContract = {
  deploymentName: "Voting_Kaduwela",
  contractName: "Voting",
  sourceName: "contracts/Voting.sol",
  address: "0x24432a08869578aAf4d1eadA12e1e78f171b1a2b",
  creator: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  creationTxHash: "0xea92f28bb326b8dd",
  creationBlock: 375,
  abi: VOTING_ABI,
  bytecode: "0x6080aabb",
  deployedBytecode: "0x6080ccdd",
  libraries: { LeanIMT: "0x103A3b128991781EE2c8db0454cA99d67b257923" },
  verified: true,
  compiler: {
    version: "0.8.30+commit.73712a01",
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    language: "Solidity",
  },
  sources: [
    { path: "contracts/Voting.sol", content: "contract Voting {\n  uint256 x;\n}", license: "MIT", isEntry: true },
    { path: "@openzeppelin/contracts/access/Ownable.sol", content: "abstract contract Ownable {}", isEntry: false },
  ],
};

beforeEach(() => {
  readContract.mockReset();
});

describe("ContractSourceTab", () => {
  it("publishes the compiler settings a reader needs to reproduce the build", () => {
    render(<ContractSourceTab contract={CONTRACT} />);

    expect(screen.getByText("0.8.30+commit.73712a01")).toBeTruthy();
    expect(screen.getByText("Enabled, 200 runs")).toBeTruthy();
    expect(screen.getByText("paris")).toBeTruthy();
  });

  it("shows the entry source and lets the reader open an imported file", async () => {
    const user = userEvent.setup();
    const { container } = render(<ContractSourceTab contract={CONTRACT} />);

    // Prism splits the source across token spans, so the assertion is on the
    // block's combined text rather than on a single text node.
    const codeBlock = () => container.querySelector(".solidity-code")?.textContent ?? "";
    expect(codeBlock()).toContain("contract Voting");

    await user.click(screen.getByRole("button", { name: /Ownable\.sol/ }));

    // Following an import is the whole reason the closure is published, not just
    // the entry file.
    expect(codeBlock()).toContain("abstract contract Ownable");
  });

  it("numbers every source line", () => {
    const { container } = render(<ContractSourceTab contract={CONTRACT} />);
    const gutter = container.querySelector(".solidity-code div[aria-hidden]");
    expect(gutter?.textContent).toBe("123");
  });

  it("warns that library placeholders make the bytecode differ from the chain", () => {
    render(<ContractSourceTab contract={CONTRACT} />);
    expect(screen.getByText(/placeholders/)).toBeTruthy();
    expect(screen.getByText(/0x103A3b128991781EE2c8db0454cA99d67b257923/)).toBeTruthy();
  });

  it("says so plainly when a deployment carried no source", () => {
    render(<ContractSourceTab contract={{ ...CONTRACT, verified: false, sources: [] }} />);
    expect(screen.getByText(/Source code is not available/)).toBeTruthy();
  });
});

describe("ReadContractTab", () => {
  it("auto-queries zero-argument reads so live state is visible on arrival", async () => {
    readContract.mockImplementation(({ functionName }: { functionName: string }) =>
      functionName === "currentPhase" ? 0 : ["Anura", "Sajith"],
    );

    render(<ReadContractTab contract={CONTRACT} />);

    await waitFor(() => {
      expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "currentPhase" }));
      expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "getCandidates" }));
    });
    await waitFor(() => expect(screen.getByText(/Anura/)).toBeTruthy());
  });

  it("does not auto-query functions that take arguments", async () => {
    readContract.mockResolvedValue(0);
    render(<ReadContractTab contract={CONTRACT} />);

    await waitFor(() => expect(readContract).toHaveBeenCalled());
    expect(readContract).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: "isNullifierUsed" }));
  });

  it("excludes state-changing functions — this tab is read-only", () => {
    render(<ReadContractTab contract={CONTRACT} />);
    expect(screen.queryByText(/^vote$/)).toBeNull();
    expect(screen.getByText(/3 read-only functions/)).toBeTruthy();
  });

  it("passes a typed argument through to the RPC call", async () => {
    const user = userEvent.setup();
    readContract.mockResolvedValue(false);
    render(<ReadContractTab contract={CONTRACT} />);

    const hash = `0x${"ab".repeat(32)}`;
    const card = screen.getByText("isNullifierUsed").closest("div.border") as HTMLElement;
    await user.type(within(card).getByRole("textbox"), hash);
    await user.click(within(card).getByRole("button", { name: "Query" }));

    await waitFor(() =>
      expect(readContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: "isNullifierUsed", args: [hash] }),
      ),
    );
  });

  it("rejects a malformed argument in place instead of calling the chain", async () => {
    const user = userEvent.setup();
    readContract.mockResolvedValue(false);
    render(<ReadContractTab contract={CONTRACT} />);

    const card = screen.getByText("isNullifierUsed").closest("div.border") as HTMLElement;
    await user.type(within(card).getByRole("textbox"), "not-hex");
    await user.click(within(card).getByRole("button", { name: "Query" }));

    await waitFor(() => expect(within(card).getByText(/0x-prefixed hex/)).toBeTruthy());
    expect(readContract).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: "isNullifierUsed" }));
  });

  it("surfaces a revert rather than dropping it", async () => {
    readContract.mockRejectedValue(new Error("execution reverted: not registered\nmore detail"));
    render(<ReadContractTab contract={CONTRACT} />);

    await waitFor(() => expect(screen.getAllByText(/execution reverted: not registered/).length).toBeGreaterThan(0));
  });
});
