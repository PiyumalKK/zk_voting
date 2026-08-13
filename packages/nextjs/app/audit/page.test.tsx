import AuditPage from "./page";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The audit screen's one button.
 *
 * The audit itself is local — it re-checks nullifiers already fetched from
 * chain — but it is deliberately slowed to 1.5s so the operator sees that work
 * happened. That makes the pending state the entire feedback for the action,
 * and it was the state daisyUI 5 broke: `${auditRunning ? "loading" : ""}`
 * masked the button into the spinner instead of adding one, so for those 1.5
 * seconds the button and its label vanished.
 */

const DIVISION = {
  id: 0,
  name: "Kaduwela",
  votingContract: "0x0000000000000000000000000000000000000aa1",
  gnOfficer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  active: true,
  phase: 3,
  treeSize: 1,
  root: 0n,
};

const mocks = vi.hoisted(() => ({
  getLogs: vi.fn(),
  readContract: vi.fn(),
}));

vi.mock("wagmi", () => ({
  usePublicClient: () => ({ getLogs: mocks.getLogs, readContract: mocks.readContract }),
}));
vi.mock("~~/hooks/useDivisions", () => ({
  useDivisions: () => ({ divisions: [DIVISION], isLoading: false, error: null, refetch: vi.fn() }),
}));
vi.mock("viem", () => ({
  // The page only needs the event object as an opaque handle to pass to getLogs.
  parseAbiItem: (signature: string) => ({ signature }),
}));

beforeEach(() => {
  mocks.getLogs.mockReset().mockResolvedValue([
    {
      args: { nullifierHash: "0xnull1", candidate: 0n, voter: DIVISION.gnOfficer },
      blockNumber: 12n,
    },
  ]);
  mocks.readContract.mockReset().mockImplementation(({ functionName }: { functionName: string }) => {
    if (functionName === "getVoteCounts") return Promise.resolve([1n, 0n]);
    if (functionName === "getCandidates") return Promise.resolve(["Alice", "Bob"]);
    return Promise.resolve(undefined);
  });
});

describe("audit — the run button's pending state", () => {
  it("shows a spinner beside a legible label, in a slot that was already there", async () => {
    render(<AuditPage />);

    const idle = await screen.findByRole("button", { name: /run audit now/i });
    await waitFor(() => expect((idle as HTMLButtonElement).disabled).toBe(false));
    const idleClass = idle.getAttribute("class");
    const idleSlot = idle.querySelector("[aria-hidden='true']");
    expect(idleSlot).not.toBeNull();
    expect(idle.querySelector(".loading-spinner")).toBeNull();

    await userEvent.setup().click(idle);

    const running = await screen.findByRole("button", { name: /auditing/i });
    expect(running.querySelector(".loading-spinner")).not.toBeNull();
    expect(running.querySelector("[aria-hidden='true']")!.getAttribute("class")).toBe(idleSlot!.getAttribute("class"));
    // `loading` on the button itself is what masked it away in daisyUI 5.
    expect(running.className.split(/\s+/)).not.toContain("loading");
    expect(running.getAttribute("class")).toBe(idleClass);
    expect((running as HTMLButtonElement).disabled).toBe(true);
    expect(running.getAttribute("aria-busy")).toBe("true");

    // The deliberate 1.5s delay, then back to a clean idle button.
    const settled = await screen.findByRole("button", { name: /run audit now/i }, { timeout: 5000 });
    expect(settled.querySelector(".loading-spinner")).toBeNull();
    expect(settled.getAttribute("aria-busy")).toBe("false");
    expect(screen.getByText(/audit passed/i)).toBeDefined();
  });

  it("cannot be started twice while an audit is running", async () => {
    render(<AuditPage />);

    const button = await screen.findByRole("button", { name: /run audit now/i });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));

    const user = userEvent.setup();
    await user.click(button);
    await screen.findByRole("button", { name: /auditing/i });
    await user.click(button);

    // Still the one run: the disabled button is what stops a second timer
    // landing on top of the first.
    expect(screen.getByRole("button", { name: /auditing/i })).toBeDefined();
  });
});
