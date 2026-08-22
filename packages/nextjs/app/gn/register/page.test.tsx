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
 *
 * The second half covers device re-issue — the lost-phone path. The contracts
 * are what actually prevent a person registering twice (`NicRegistry.sol`), and
 * `packages/hardhat/test/NicRegistry.ts` proves it; what this file has to prove
 * is that the officer is never walked into a replacement by accident, and is
 * told the right thing when the chain refuses one.
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
const ZERO = "0x0000000000000000000000000000000000000000";
const OLD_DEVICE = "0x00000000000000000000000000000000000000d1";
const VOTER = "0x1234567890123456789012345678901234567890";
const NIC_HASH = "0xaa00000000000000000000000000000000000000000000000000000000000001";

/** A NIC nobody has enrolled: the registry returns a zeroed record. */
const NOT_ENROLLED = [ZERO, ZERO, false, 0] as const;

const mocks = vi.hoisted(() => ({
  readContract: vi.fn(),
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
  useTargetNetwork: () => ({
    targetNetwork: { id: 9494, rpcUrls: { default: { http: ["http://127.0.0.1:9545"] } } },
  }),
}));
vi.mock("viem", async importOriginal => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: () => ({ readContract: mocks.readContract }),
  http: () => ({}),
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

/** Walks the wizard: NIC → address → confirm. */
const enrolVoter = async () => {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText(/200012345678/), "200012345678");
  await user.click(screen.getByRole("button", { name: /verify nic/i }));
  await user.type(screen.getByPlaceholderText("0x..."), VOTER);
  await user.click(screen.getByRole("button", { name: /use address/i }));
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
  // Default: a NIC the registry has never seen, so the wizard takes the
  // ordinary first-enrolment path and no confirmation is raised.
  mocks.readContract.mockReset().mockResolvedValue(NOT_ENROLLED);
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
      // The device address is part of the reservation now — it is what makes a
      // later re-issue able to identify and kill the phone being replaced.
      args: [NIC_HASH, DIVISION.votingContract, VOTER],
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

describe("GN register — replacing a lost device", () => {
  /** Enrolled in this division on another phone, not yet registered in the tree. */
  const enrolledElsewhereOnOldPhone = [DIVISION.votingContract, OLD_DEVICE, false, 0] as const;

  it("asks before replacing, instead of writing anything", async () => {
    mocks.readContract.mockResolvedValue(enrolledElsewhereOnOldPhone);

    render(<GNRegisterVoter />);
    await enrolVoter();

    // The officer is told what the replacement costs, and nothing has been
    // signed yet. Killing a voter's phone must never be a side effect of
    // pressing the ordinary enrol button.
    expect(await screen.findByText(/already enrolled on another phone/i)).toBeDefined();
    expect(screen.getByText(/permanently disable/i)).toBeDefined();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("re-issues and revokes the old address in one voter-roll update once confirmed", async () => {
    mocks.readContract.mockResolvedValue(enrolledElsewhereOnOldPhone);

    render(<GNRegisterVoter />);
    await enrolVoter();
    await userEvent.setup().click(await screen.findByRole("button", { name: /replace device/i }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2));
    expect(mocks.write.mock.calls[0][0]).toMatchObject({
      address: NIC_REGISTRY,
      functionName: "reissueDevice",
      args: [NIC_HASH, DIVISION.votingContract, VOTER],
    });
    // Old address off the roll, new one on, in a single call. Hygiene rather
    // than the safety mechanism — `reissueDevice` already killed the old phone.
    expect(mocks.write.mock.calls[1][0]).toMatchObject({
      functionName: "addVoters",
      args: [
        [OLD_DEVICE, VOTER],
        [false, true],
      ],
    });
    expect(await screen.findByText(/replacement device issued/i)).toBeDefined();
  });

  it("lets the officer back out without writing anything", async () => {
    mocks.readContract.mockResolvedValue(enrolledElsewhereOnOldPhone);

    render(<GNRegisterVoter />);
    await enrolVoter();
    await userEvent.setup().click(await screen.findByRole("button", { name: /cancel/i }));

    expect(await screen.findByRole("button", { name: /add to voter roll/i })).toBeDefined();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("warns when the NIC has been replaced before", async () => {
    mocks.readContract.mockResolvedValue([DIVISION.votingContract, OLD_DEVICE, false, 2]);

    render(<GNRegisterVoter />);
    await enrolVoter();

    expect(await screen.findByText(/already been replaced 2 times/i)).toBeDefined();
  });

  it("refuses outright once the voter has registered in the tree", async () => {
    // The policy in one test: losing the phone after registering loses the vote,
    // because the commitment in the tree is anonymous and cannot be reassigned.
    mocks.readContract.mockResolvedValue([DIVISION.votingContract, OLD_DEVICE, true, 0]);

    render(<GNRegisterVoter />);
    await enrolVoter();

    await waitFor(() =>
      expect(mocks.notifyError).toHaveBeenCalledWith(expect.stringMatching(/already completed registration/i)),
    );
    expect(mocks.write).not.toHaveBeenCalled();
    expect(screen.queryByText(/already enrolled on another phone/i)).toBeNull();
  });

  it("sends the officer away when the NIC belongs to another division", async () => {
    mocks.readContract.mockResolvedValue(["0x00000000000000000000000000000000000000ff", OLD_DEVICE, false, 0]);

    render(<GNRegisterVoter />);
    await enrolVoter();

    await waitFor(() => expect(mocks.notifyError).toHaveBeenCalledWith(expect.stringMatching(/different division/i)));
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("says nothing needs doing when the scanned phone is already the issued one", async () => {
    mocks.readContract.mockResolvedValue([DIVISION.votingContract, VOTER, false, 0]);

    render(<GNRegisterVoter />);
    await enrolVoter();

    await waitFor(() =>
      expect(mocks.notifyError).toHaveBeenCalledWith(expect.stringMatching(/already the one issued/i)),
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("explains a registration that landed between the check and the transaction", async () => {
    // The race the contract closes: the voter registers on the old phone while
    // the officer is mid-flow, so `reissueDevice` reverts.
    mocks.readContract.mockResolvedValue(enrolledElsewhereOnOldPhone);
    mocks.write.mockRejectedValueOnce(new Error("NicRegistry__AlreadyRegistered"));

    render(<GNRegisterVoter />);
    await enrolVoter();
    await userEvent.setup().click(await screen.findByRole("button", { name: /replace device/i }));

    await waitFor(() =>
      expect(mocks.notifyError).toHaveBeenCalledWith(expect.stringMatching(/registered in the app between/i)),
    );
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });

  it("names the replacement limit when the registry enforces it", async () => {
    mocks.readContract.mockResolvedValue([DIVISION.votingContract, OLD_DEVICE, false, 3]);
    mocks.write.mockRejectedValueOnce(new Error("NicRegistry__ReissueLimitReached"));

    render(<GNRegisterVoter />);
    await enrolVoter();
    await userEvent.setup().click(await screen.findByRole("button", { name: /replace device/i }));

    await waitFor(() => expect(mocks.notifyError).toHaveBeenCalledWith(expect.stringMatching(/replacement limit/i)));
  });
});
