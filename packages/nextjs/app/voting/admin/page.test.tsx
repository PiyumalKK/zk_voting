import AdminPage from "./page";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The admin panel, rendered for real in both modes.
 *
 * Five separate write sites were moved onto the seam here, so the risks are
 * mechanical: a handler still reaching for a wallet, an action targeting the
 * wrong contract, or the access gate reading the wrong kind of identity. Each
 * of those is checked below by driving the actual buttons.
 */

// Everything a `vi.mock` factory touches has to be hoisted with the mocks —
// the factories run before module-level constants are initialised.
const { DIVISION, OWNER, REGISTRY, VOTING_DATA, mocks } = vi.hoisted(() => {
  const DIVISION = {
    id: 0,
    name: "Kaduwela",
    votingContract: "0x0000000000000000000000000000000000000aa1",
    gnOfficer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    active: true,
    phase: 0,
    treeSize: 0,
    root: 0n,
  };
  const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  return {
    DIVISION,
    OWNER,
    REGISTRY: "0x0000000000000000000000000000000000000cc1",
    /** `getVotingData()` in Setup phase: question, owner, phase, …, candidateCount. */
    VOTING_DATA: ["Who should represent Kaduwela?", OWNER, 0, 0, 0, 0, 0, 0n, 2],
    mocks: {
      auth: { mode: "hardhat" as "hardhat" | "custom", isAdmin: false, isLoading: false },
      account: { address: undefined as string | undefined },
      write: vi.fn(),
      readContract: vi.fn(),
      refetch: vi.fn(),
      notifyError: vi.fn(),
      notifySuccess: vi.fn(),
    },
  };
});

vi.mock("~~/hooks/useElectionAuth", () => ({ useElectionAuth: () => mocks.auth }));
vi.mock("~~/hooks/useElectionWriter", () => ({ useElectionWriter: () => ({ write: mocks.write }) }));
vi.mock("~~/hooks/useDivisions", () => ({
  useDivisions: () => ({ divisions: [DIVISION], isLoading: false, error: null, refetch: mocks.refetch }),
}));
vi.mock("~~/hooks/scaffold-eth/useTargetNetwork", () => ({
  useTargetNetwork: () => ({
    targetNetwork: { id: 9494, name: "ZK Election Chain", rpcUrls: { default: { http: ["http://127.0.0.1:9545"] } } },
  }),
}));
vi.mock("wagmi", () => ({ useAccount: () => mocks.account }));
vi.mock("viem", () => ({
  http: () => ({}),
  createPublicClient: () => ({ readContract: mocks.readContract }),
}));
vi.mock("~~/contracts/deployedContracts", () => ({
  default: {
    9494: {
      Voting: { address: DIVISION.votingContract, abi: [] },
      ElectionRegistry: { address: REGISTRY, abi: [] },
    },
  },
}));
vi.mock("~~/utils/scaffold-eth", () => ({
  notification: { error: mocks.notifyError, success: mocks.notifySuccess },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("@scaffold-ui/components", () => ({
  AddressInput: ({ value, onChange, placeholder }: any) => (
    <input placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} />
  ),
}));
// Custom-mode-only panel; it has its own test file and would otherwise fetch.
vi.mock("~~/app/voting/admin/_components/GnAccountsSection", () => ({
  GnAccountsSection: () => <div data-testid="gn-accounts-panel" />,
}));

/** `readContract` is called for getVotingData, getCandidates and owner. */
const stubReads = () =>
  mocks.readContract.mockImplementation(({ functionName }: { functionName: string }) => {
    if (functionName === "getVotingData") return Promise.resolve(VOTING_DATA);
    if (functionName === "getCandidates") return Promise.resolve(["Alice", "Bob"]);
    if (functionName === "owner") return Promise.resolve(OWNER);
    return Promise.resolve(undefined);
  });

beforeEach(() => {
  mocks.auth = { mode: "hardhat", isAdmin: false, isLoading: false };
  mocks.account = { address: OWNER };
  mocks.write.mockReset().mockResolvedValue("0xdeadbeef");
  mocks.readContract.mockReset();
  mocks.notifyError.mockClear();
  mocks.notifySuccess.mockClear();
  stubReads();
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
});

afterEach(() => vi.unstubAllGlobals());

describe("admin page — access gate", () => {
  it("hardhat: asks for a wallet when none is connected", () => {
    mocks.account = { address: undefined };

    render(<AdminPage />);

    expect(screen.getByText(/connect a wallet/i)).toBeDefined();
  });

  it("hardhat: blocks a connected wallet that is not the contract owner", async () => {
    mocks.account = { address: "0x000000000000000000000000000000000000dEaD" };

    render(<AdminPage />);

    expect(await screen.findByText(/not the contract owner/i)).toBeDefined();
  });

  it("hardhat: admits the owner", async () => {
    render(<AdminPage />);

    expect(await screen.findByText(/ballot question/i)).toBeDefined();
  });

  it("custom: offers a sign-in link instead of a wallet prompt", () => {
    mocks.auth = { mode: "custom", isAdmin: false, isLoading: false };
    mocks.account = { address: undefined };

    render(<AdminPage />);

    expect(screen.getByRole("link", { name: /sign in/i }).getAttribute("href")).toBe("/login?next=%2Fvoting%2Fadmin");
    expect(screen.queryByText(/connect a wallet/i)).toBeNull();
  });

  it("custom: waits for the session rather than flashing a denial", () => {
    mocks.auth = { mode: "custom", isAdmin: false, isLoading: true };

    render(<AdminPage />);

    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
    expect(screen.queryByText(/not the contract owner/i)).toBeNull();
  });

  it("custom: admits an admin session with no wallet, and does not consult owner()", async () => {
    mocks.auth = { mode: "custom", isAdmin: true, isLoading: false };
    mocks.account = { address: undefined };
    mocks.readContract.mockImplementation(({ functionName }: { functionName: string }) => {
      // Ownership resolves to somebody else entirely; the session still decides.
      if (functionName === "owner") return Promise.resolve("0x000000000000000000000000000000000000dEaD");
      if (functionName === "getVotingData") return Promise.resolve(VOTING_DATA);
      return Promise.resolve(["Alice", "Bob"]);
    });

    render(<AdminPage />);

    expect(await screen.findByText(/ballot question/i)).toBeDefined();
    expect(screen.queryByText(/not the contract owner/i)).toBeNull();
  });
});

describe("admin page — the GN Accounts panel", () => {
  it("appears only in custom mode", async () => {
    mocks.auth = { mode: "custom", isAdmin: true, isLoading: false };
    render(<AdminPage />);

    expect(await screen.findByTestId("gn-accounts-panel")).toBeDefined();
  });

  it("is absent in hardhat mode, where GN officers hold wallets", async () => {
    render(<AdminPage />);

    await screen.findByText(/ballot question/i);
    expect(screen.queryByTestId("gn-accounts-panel")).toBeNull();
  });
});

describe("admin page — write sites go through the seam", () => {
  const renderAsAdmin = async () => {
    mocks.auth = { mode: "custom", isAdmin: true, isLoading: false };
    render(<AdminPage />);
    await screen.findByText(/ballot question/i);
    return userEvent.setup();
  };

  it("saves the question against the selected division", async () => {
    const user = await renderAsAdmin();

    await user.click(screen.getByRole("button", { name: /save question/i }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.write.mock.calls[0][0]).toMatchObject({
      address: DIVISION.votingContract,
      functionName: "setQuestion",
      args: ["Who should represent Kaduwela?"],
    });
  });

  it("sends durations as bigint seconds, parsed from hh:mm:ss", async () => {
    const user = await renderAsAdmin();

    await user.click(screen.getByRole("button", { name: /start registration phase/i }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.write.mock.calls[0][0]).toMatchObject({ functionName: "startRegistration", args: [3600n] });
  });

  it("applies an ALL-divisions action to every division contract", async () => {
    const user = await renderAsAdmin();

    await user.click(screen.getByRole("button", { name: /start registration — all/i }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.write.mock.calls[0][0]).toMatchObject({
      address: DIVISION.votingContract,
      functionName: "startRegistration",
    });
    expect(mocks.notifySuccess).toHaveBeenCalledWith(expect.stringContaining("Registration started on 1 division"));
  });

  it("skips a division that reverts instead of aborting the whole run", async () => {
    const user = await renderAsAdmin();
    mocks.write.mockRejectedValue(new Error("Voting__WrongPhase"));

    await user.click(screen.getByRole("button", { name: /end — all/i }));

    await waitFor(() => expect(mocks.notifySuccess).toHaveBeenCalledWith(expect.stringContaining("skipped")));
  });

  it("creates a division on the registry, not on a division contract", async () => {
    const user = await renderAsAdmin();

    await user.type(screen.getByPlaceholderText(/Kandy, Matara/), "Galle");
    await user.click(screen.getByRole("button", { name: /deploy & register division/i }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.write.mock.calls[0][0]).toMatchObject({
      address: REGISTRY,
      functionName: "createDivision",
      args: ["Galle"],
    });
  });

  it("assigns a GN officer on the chosen division contract", async () => {
    const user = await renderAsAdmin();

    // Section 3's voter allowlist uses the same placeholder; the GN field is
    // the later of the two in document order.
    const addressInputs = screen.getAllByPlaceholderText("0x...");
    await user.type(addressInputs[addressInputs.length - 1], DIVISION.gnOfficer);
    await user.click(screen.getByRole("button", { name: /assign GN to Kaduwela/i }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.write.mock.calls[0][0]).toMatchObject({
      address: DIVISION.votingContract,
      functionName: "setGNOfficer",
      args: [DIVISION.gnOfficer],
    });
  });

  it("does not offer the voter allowlist in custom mode — addVoters is GN-only in the relay whitelist", async () => {
    await renderAsAdmin();

    expect(screen.getByText(/voters are enrolled by their Grama Niladhari officer/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: /submit allowlist/i })).toBeNull();
  });

  it("keeps the voter allowlist in hardhat mode, where the owner may call addVoters", async () => {
    render(<AdminPage />);
    await screen.findByText(/ballot question/i);

    expect(screen.getByRole("button", { name: /submit allowlist/i })).toBeDefined();
  });

  it("surfaces a relay refusal through the existing error toast", async () => {
    const user = await renderAsAdmin();
    mocks.write.mockRejectedValue(Object.assign(new Error("x"), { shortMessage: "Voting__WrongPhase" }));

    await user.click(screen.getByRole("button", { name: /save question/i }));

    await waitFor(() => expect(mocks.notifyError).toHaveBeenCalledWith("Voting__WrongPhase"));
  });
});
