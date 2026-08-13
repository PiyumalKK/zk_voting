import GNRegisterVoter from "./page";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Voter enrolment, driven end to end through the real page in both modes.
 *
 * This is the flow that would have silently broken in custom mode: before pass
 * 2, `/api/nic/hash` demanded a wallet signature, so a wallet-less GN could not
 * enrol anyone. The two "how does it authenticate the NIC hash" cases below are
 * the regression guard for that.
 */

const DIVISION = {
  id: 0,
  name: "Kaduwela",
  votingContract: "0x0000000000000000000000000000000000000aa1",
  gnOfficer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  active: true,
  phase: 1,
  treeSize: 0,
  root: 0n,
};

const NIC_REGISTRY = "0x0000000000000000000000000000000000000bb1";
const VOTER = "0x1234567890123456789012345678901234567890";
const NIC_HASH = "0xaa00000000000000000000000000000000000000000000000000000000000001";

const mocks = vi.hoisted(() => ({
  gn: {
    mode: "hardhat" as "hardhat" | "custom",
    division: null as unknown,
    divisions: [] as unknown[],
    isLoading: false,
    error: null as string | null,
    identity: null as string | null,
    needsSignIn: false,
    refetch: vi.fn(),
  },
  write: vi.fn(),
  account: { address: undefined as string | undefined },
  signMessage: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

vi.mock("~~/hooks/useGnDivision", () => ({ useGnDivision: () => mocks.gn }));
vi.mock("~~/hooks/useElectionWriter", () => ({ useElectionWriter: () => ({ write: mocks.write }) }));
vi.mock("~~/hooks/scaffold-eth/useTargetNetwork", () => ({
  useTargetNetwork: () => ({ targetNetwork: { id: 9494 } }),
}));
vi.mock("wagmi", () => ({ useAccount: () => mocks.account }));
vi.mock("wagmi/actions", () => ({ getWalletClient: async () => ({ signMessage: mocks.signMessage }) }));
vi.mock("~~/services/web3/wagmiConfig", () => ({ wagmiConfig: {} }));
vi.mock("~~/utils/deployedAddress", () => ({ getDeployedAddress: () => NIC_REGISTRY }));
vi.mock("~~/utils/scaffold-eth", () => ({
  notification: { error: mocks.notifyError, success: mocks.notifySuccess },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;

/** Walks the wizard: NIC → address → phone → submit. */
const enrolVoter = async () => {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText(/200012345678/), "200012345678");
  await user.click(screen.getByRole("button", { name: /verify nic/i }));
  await user.type(screen.getByPlaceholderText("0x..."), VOTER);
  await user.click(screen.getByRole("button", { name: /use address/i }));
  await user.type(screen.getByPlaceholderText(/phone/i), "+94771234567");
  await user.click(screen.getByRole("button", { name: /add to voter roll/i }));
};

beforeEach(() => {
  mocks.gn = {
    mode: "hardhat",
    division: DIVISION,
    divisions: [DIVISION],
    isLoading: false,
    error: null,
    identity: DIVISION.gnOfficer,
    needsSignIn: false,
    refetch: vi.fn(),
  };
  mocks.account = { address: DIVISION.gnOfficer };
  mocks.write.mockReset().mockResolvedValue("0xdeadbeef");
  mocks.signMessage.mockReset().mockResolvedValue("0xsignature");
  mocks.notifyError.mockClear();
  mocks.notifySuccess.mockClear();
  fetchMock = vi.fn().mockResolvedValue(jsonResponse({ nicHash: NIC_HASH }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("GN register — hardhat mode", () => {
  it("signs the NIC hash request with the wallet, as before M12", async () => {
    render(<GNRegisterVoter />);
    await enrolVoter();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/nic/hash");
    expect(init.headers["x-gn-address"]).toBe(DIVISION.gnOfficer);
    expect(init.headers["x-gn-signature"]).toBe("0xsignature");
    expect(init.headers["x-gn-timestamp"]).toMatch(/^\d+$/);
    expect(mocks.signMessage).toHaveBeenCalled();
  });

  it("reserves the NIC hash and then allowlists the voter", async () => {
    render(<GNRegisterVoter />);
    await enrolVoter();

    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2));
    expect(mocks.write.mock.calls[0][0]).toMatchObject({
      address: NIC_REGISTRY,
      functionName: "reserveNicHash",
      args: [NIC_HASH, DIVISION.votingContract],
    });
    expect(mocks.write.mock.calls[1][0]).toMatchObject({
      address: DIVISION.votingContract,
      functionName: "addVoters",
      args: [[VOTER], [true]],
    });
    expect(await screen.findByText(/voter enrolled/i)).toBeDefined();
  });
});

describe("GN register — custom mode", () => {
  beforeEach(() => {
    mocks.gn = { ...mocks.gn, mode: "custom", identity: "gn.kaduwela" };
    mocks.account = { address: undefined };
  });

  it("authenticates the NIC hash with the session cookie and no signature", async () => {
    render(<GNRegisterVoter />);
    await enrolVoter();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0];
    expect(init.credentials).toBe("same-origin");
    expect(init.headers["x-gn-signature"]).toBeUndefined();
    expect(mocks.signMessage).not.toHaveBeenCalled();
  });

  it("still performs both writes with no wallet present", async () => {
    render(<GNRegisterVoter />);
    await enrolVoter();

    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/voter enrolled/i)).toBeDefined();
  });

  it("does not allowlist the voter when the NIC hash is refused", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "This account has been suspended." }, 403));

    render(<GNRegisterVoter />);
    await enrolVoter();

    await waitFor(() => expect(mocks.notifyError).toHaveBeenCalledWith("This account has been suspended."));
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("does not allowlist the voter when the NIC is already reserved", async () => {
    mocks.write.mockRejectedValueOnce(
      Object.assign(new Error("NicRegistry__AlreadyUsed"), { shortMessage: undefined }),
    );

    render(<GNRegisterVoter />);
    await enrolVoter();

    await waitFor(() =>
      expect(mocks.notifyError).toHaveBeenCalledWith("This NIC is already registered to another voter"),
    );
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });

  it("maps a wrong-phase revert to the phase explanation", async () => {
    mocks.write.mockRejectedValue(Object.assign(new Error("x"), { shortMessage: "Voting__WrongPhase" }));

    render(<GNRegisterVoter />);
    await enrolVoter();

    await waitFor(() =>
      expect(mocks.notifyError).toHaveBeenCalledWith(
        "Voters can only be added during the Setup or Registration phases.",
      ),
    );
  });

  it("offers a sign-in link instead of a wallet prompt when signed out", () => {
    mocks.gn = { ...mocks.gn, needsSignIn: true };

    render(<GNRegisterVoter />);

    expect(screen.getByRole("link", { name: /sign in/i }).getAttribute("href")).toBe("/login?next=%2Fgn%2Fregister");
  });
});

/**
 * The confirm button while the two writes are in flight.
 *
 * This is the longest wait in the product — two sequential on-chain
 * transactions, in front of a voter standing at the desk — so it is the one
 * pending state an officer actually watches. It used to carry daisyUI's
 * `loading` class, which in v5 masks the button into the spinner rather than
 * adding one: background and label both vanished for the duration.
 *
 * Walks to the confirm step directly rather than through `enrolVoter`, which
 * types into a phone field this page does not have.
 */
describe("GN register — the confirm button's pending state", () => {
  const reachConfirmStep = async () => {
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/200012345678/), "200012345678");
    await user.click(screen.getByRole("button", { name: /verify nic/i }));
    await user.type(screen.getByPlaceholderText("0x..."), VOTER);
    await user.click(screen.getByRole("button", { name: /use address/i }));
    return user;
  };

  /**
   * A write that stays in flight until the test lets it finish.
   *
   * Only the *first* call is held. `handleSubmit` makes two writes, and the
   * point of these cases is the window the operator sees — which opens on the
   * first one. Releasing it lets the rest of the flow run at normal speed.
   */
  const pendingWrite = () => {
    let settle: (outcome: "resolve" | "reject") => void = () => {};
    let released = false;
    mocks.write.mockImplementation(() => {
      if (released) return Promise.resolve("0xdeadbeef");
      return new Promise((resolve, reject) => {
        settle = outcome => {
          released = outcome === "resolve";
          if (released) resolve("0xdeadbeef");
          else reject(new Error("User rejected the request"));
        };
      });
    });
    return {
      finish: () => settle("resolve"),
      reject: () => settle("reject"),
    };
  };

  it("swaps the label for a spinner without moving it, and never masks the button", async () => {
    const tx = pendingWrite();
    render(<GNRegisterVoter />);
    const user = await reachConfirmStep();

    const idle = screen.getByRole("button", { name: /add to voter roll/i });
    const idleClass = idle.getAttribute("class");
    const idleSlot = idle.querySelector("[aria-hidden='true']");
    // The slot is already there before the click — that is what stops the
    // label sliding sideways when the spinner appears.
    expect(idleSlot).not.toBeNull();
    expect(idle.querySelector(".loading-spinner")).toBeNull();

    await user.click(idle);

    const pending = await screen.findByRole("button", { name: /adding to blockchain/i });
    expect(pending.querySelector(".loading-spinner")).not.toBeNull();
    // Identical class list and an identical slot: nothing about the button's
    // box changes, so there is nothing to shift.
    expect(pending.getAttribute("class")).toBe(idleClass);
    expect(pending.querySelector("[aria-hidden='true']")!.getAttribute("class")).toBe(idleSlot!.getAttribute("class"));
    // `loading` on the button itself is the bug this test exists for.
    expect(pending.className.split(/\s+/)).not.toContain("loading");
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect(pending.getAttribute("aria-busy")).toBe("true");

    tx.finish();
    expect(await screen.findByText(/voter enrolled/i)).toBeDefined();
  });

  it("will not send a second transaction while the first is in flight", async () => {
    const tx = pendingWrite();
    render(<GNRegisterVoter />);
    const user = await reachConfirmStep();

    const button = screen.getByRole("button", { name: /add to voter roll/i });
    await user.click(button);
    await screen.findByRole("button", { name: /adding to blockchain/i });
    await user.click(button);
    await user.click(button);

    // One click, one `reserveNicHash`. The disabled button is the only thing
    // between an impatient officer and a duplicate enrolment.
    expect(mocks.write).toHaveBeenCalledTimes(1);
    tx.finish();
  });

  it("returns to an enabled, labelled button when the officer rejects in the wallet", async () => {
    const tx = pendingWrite();
    render(<GNRegisterVoter />);
    const user = await reachConfirmStep();

    const idleClass = screen.getByRole("button", { name: /add to voter roll/i }).getAttribute("class");
    await user.click(screen.getByRole("button", { name: /add to voter roll/i }));
    await screen.findByRole("button", { name: /adding to blockchain/i });

    tx.reject();

    // Back to square one, on the same step, ready to retry — not stuck
    // spinning, and not advanced to the success screen.
    const recovered = await screen.findByRole("button", { name: /add to voter roll/i });
    expect((recovered as HTMLButtonElement).disabled).toBe(false);
    expect(recovered.getAttribute("aria-busy")).toBe("false");
    expect(recovered.getAttribute("class")).toBe(idleClass);
    expect(recovered.querySelector(".loading-spinner")).toBeNull();
    expect(screen.queryByText(/voter enrolled/i)).toBeNull();
    expect(mocks.notifyError).toHaveBeenCalled();
  });
});
