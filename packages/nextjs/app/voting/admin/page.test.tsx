import { AddDivisionSection } from "./_components/AddDivisionSection";
import { AdminElectionProvider } from "./_components/AdminElectionProvider";
import AdminBallotPage from "./ballot/page";
import AdminDivisionsPage from "./divisions/page";
import AdminOperationsPage from "./page";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The admin area, rendered for real in both modes.
 *
 * Five separate write sites were moved onto the seam here, so the risks are
 * mechanical: a handler still reaching for a wallet, an action targeting the
 * wrong contract, or the access gate reading the wrong kind of identity. Each
 * of those is checked below by driving the actual buttons.
 *
 * The panel is now three routes (Operations, Ballot, Divisions) sharing
 * `AdminElectionProvider`, so each test mounts the provider around the page
 * that owns the control it drives — the same composition the real layout
 * produces.
 */

// Everything a `vi.mock` factory touches has to be hoisted with the mocks —
// the factories run before module-level constants are initialised.
const {
  DIVISION,
  DIVISION_B,
  OWNER,
  REGISTRY,
  VOTING_DATA,
  NIC_REGISTRY,
  NEW_DIVISION_ADDRESS,
  TARGET_NETWORK,
  mocks,
} = vi.hoisted(() => {
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
  /**
   * A second division, for the per-division save-status tests. Every other
   * test runs against `[DIVISION]` alone — `mocks.divisions` is what the
   * `useDivisions` mock reads, and `beforeEach` resets it to one — so adding
   * this changes no existing expectation about division counts.
   */
  const DIVISION_B = {
    ...DIVISION,
    id: 1,
    name: "Gampaha",
    votingContract: "0x0000000000000000000000000000000000000aa2",
  };
  const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  return {
    DIVISION,
    DIVISION_B,
    OWNER,
    REGISTRY: "0x0000000000000000000000000000000000000cc1",
    /** The NicRegistry address the admin panel must authorise divisions against. */
    NIC_REGISTRY: "0x0000000000000000000000000000000000000dd1",
    /** The Voting contract `createDivision` deploys, read back from its receipt. */
    NEW_DIVISION_ADDRESS: "0x0000000000000000000000000000000000000ee1",
    /** `getVotingData()` in Setup phase: question, owner, phase, …, candidateCount. */
    VOTING_DATA: ["Who should represent Kaduwela?", OWNER, 0, 0, 0, 0, 0, 0n, 2],
    /**
     * One object, reused. The real `useTargetNetwork` memoises off a zustand
     * store, so its identity is stable across renders; a mock that rebuilt it
     * each call would invalidate the `publicClient` memo on every render and
     * manufacture churn the app does not have.
     */
    TARGET_NETWORK: {
      id: 9494,
      name: "ZK Election Chain",
      rpcUrls: { default: { http: ["http://127.0.0.1:9545"] } },
    },
    mocks: {
      /** Which divisions `useDivisions` reports. One, unless a test says otherwise. */
      divisions: [DIVISION] as (typeof DIVISION)[],
      auth: { mode: "hardhat" as "hardhat" | "custom", isAdmin: false, isLoading: false },
      account: { address: undefined as string | undefined },
      write: vi.fn(),
      readContract: vi.fn(),
      getLogs: vi.fn(),
      getTransactionReceipt: vi.fn(),
      refetch: vi.fn(),
      notifyError: vi.fn(),
      notifySuccess: vi.fn(),
      notifyWarning: vi.fn(),
    },
  };
});

/** Also stable — `useTargetNetwork` wraps its return in a `useMemo`. */
const TARGET_NETWORK_RESULT = { targetNetwork: TARGET_NETWORK };

vi.mock("~~/hooks/useElectionAuth", () => ({ useElectionAuth: () => mocks.auth }));
vi.mock("~~/hooks/useElectionWriter", () => ({ useElectionWriter: () => ({ write: mocks.write }) }));
// Fresh objects on every call, exactly like the real hook: it re-polls every 4s
// and rebuilds the array, so anything depending on a division's *identity*
// churns constantly. `AdminElectionProvider` must key off the contract address
// instead — see the "does not flicker" test at the bottom.
vi.mock("~~/hooks/useDivisions", () => ({
  useDivisions: () => ({
    divisions: mocks.divisions.map(division => ({ ...division })),
    isLoading: false,
    error: null,
    refetch: mocks.refetch,
  }),
}));
vi.mock("~~/hooks/scaffold-eth/useTargetNetwork", () => ({
  useTargetNetwork: () => TARGET_NETWORK_RESULT,
}));
vi.mock("wagmi", () => ({ useAccount: () => mocks.account }));
vi.mock("viem", () => ({
  http: () => ({}),
  createPublicClient: () => ({
    readContract: mocks.readContract,
    getLogs: mocks.getLogs,
    getTransactionReceipt: mocks.getTransactionReceipt,
  }),
  // Identity stubs: the real parsers need a full ABI/log encoding, and what
  // these tests care about is which calls the page makes, not viem's decoding.
  parseAbiItem: (signature: string) => ({ signature }),
  parseEventLogs: ({ logs }: { logs: unknown[] }) => logs,
}));
vi.mock("~~/contracts/deployedContracts", () => ({
  default: {
    9494: {
      Voting: { address: DIVISION.votingContract, abi: [] },
      ElectionRegistry: { address: REGISTRY, abi: [] },
      NicRegistry: { address: NIC_REGISTRY, abi: [] },
    },
  },
}));
vi.mock("~~/utils/scaffold-eth", () => ({
  notification: { error: mocks.notifyError, success: mocks.notifySuccess, warning: mocks.notifyWarning },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/voting/admin",
}));
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

/**
 * `readContract` is called for getVotingData, getCandidates and owner.
 *
 * Answers per contract address, so the second division has a ballot of its own
 * rather than an echo of the first — otherwise a test could not tell a draft
 * that followed the selection from one that merely looked unchanged.
 */
const stubReads = () =>
  mocks.readContract.mockImplementation(({ address, functionName }: { address: string; functionName: string }) => {
    const isSecond = address === DIVISION_B.votingContract;
    if (functionName === "getVotingData") {
      return Promise.resolve(isSecond ? ["Who should represent Gampaha?", OWNER, 0, 0, 0, 0, 0, 0n, 2] : VOTING_DATA);
    }
    if (functionName === "getCandidates") return Promise.resolve(isSecond ? ["Chandra", "Dilani"] : ["Alice", "Bob"]);
    if (functionName === "owner") return Promise.resolve(OWNER);
    return Promise.resolve(undefined);
  });

/** Mount a route the way `layout.tsx` does. */
const renderAdmin = (ui: React.ReactNode) => render(<AdminElectionProvider>{ui}</AdminElectionProvider>);

beforeEach(() => {
  mocks.divisions = [DIVISION];
  mocks.auth = { mode: "hardhat", isAdmin: false, isLoading: false };
  mocks.account = { address: OWNER };
  mocks.write.mockReset().mockResolvedValue("0xdeadbeef");
  mocks.readContract.mockReset();
  // Default: the sample division is already authorised, which is true of the
  // three the deploy script creates. Tests that care override this.
  mocks.getLogs
    .mockReset()
    .mockResolvedValue([{ args: { votingContract: DIVISION.votingContract, authorized: true } }]);
  mocks.getTransactionReceipt
    .mockReset()
    .mockResolvedValue({ logs: [{ args: { votingContract: NEW_DIVISION_ADDRESS } }] });
  mocks.notifyError.mockClear();
  mocks.notifySuccess.mockClear();
  mocks.notifyWarning.mockClear();
  stubReads();
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
});

afterEach(() => vi.unstubAllGlobals());

describe("admin area — access gate", () => {
  it("hardhat: asks for a wallet when none is connected", () => {
    mocks.account = { address: undefined };

    renderAdmin(<AdminOperationsPage />);

    expect(screen.getByText(/connect a wallet/i)).toBeDefined();
  });

  it("hardhat: blocks a connected wallet that is not the contract owner", async () => {
    mocks.account = { address: "0x000000000000000000000000000000000000dEaD" };

    renderAdmin(<AdminOperationsPage />);

    expect(await screen.findByText(/not the contract owner/i)).toBeDefined();
  });

  it("hardhat: admits the owner", async () => {
    renderAdmin(<AdminBallotPage />);

    expect(await screen.findByText(/ballot question/i)).toBeDefined();
  });

  it("custom: offers a sign-in link instead of a wallet prompt", () => {
    mocks.auth = { mode: "custom", isAdmin: false, isLoading: false };
    mocks.account = { address: undefined };

    renderAdmin(<AdminOperationsPage />);

    expect(screen.getByRole("link", { name: /sign in/i }).getAttribute("href")).toBe("/login?next=%2Fvoting%2Fadmin");
    expect(screen.queryByText(/connect a wallet/i)).toBeNull();
  });

  it("custom: waits for the session rather than flashing a denial", () => {
    mocks.auth = { mode: "custom", isAdmin: false, isLoading: true };

    renderAdmin(<AdminOperationsPage />);

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

    renderAdmin(<AdminBallotPage />);

    expect(await screen.findByText(/ballot question/i)).toBeDefined();
    expect(screen.queryByText(/not the contract owner/i)).toBeNull();
  });

  it("gates every route, not just the one that used to hold the controls", () => {
    mocks.account = { address: undefined };

    renderAdmin(<AdminDivisionsPage />);

    expect(screen.getByText(/connect a wallet/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: /deploy & register division/i })).toBeNull();
  });
});

describe("admin area — the GN Accounts panel", () => {
  it("appears only in custom mode", async () => {
    mocks.auth = { mode: "custom", isAdmin: true, isLoading: false };
    renderAdmin(<AdminDivisionsPage />);

    expect(await screen.findByTestId("gn-accounts-panel")).toBeDefined();
  });

  it("is absent in hardhat mode, where GN officers hold wallets", async () => {
    renderAdmin(<AdminDivisionsPage />);

    await screen.findByRole("heading", { name: /gn officer management/i });
    expect(screen.queryByTestId("gn-accounts-panel")).toBeNull();
  });
});

describe("admin area — write sites go through the seam", () => {
  /**
   * `ready` is matched against a heading, not any text: panels cross-reference
   * each other by name ("Uses the durations typed in Phase controls above"), so
   * a bare text query would match two nodes and throw.
   */
  const renderAsAdmin = async (ui: React.ReactNode, ready: RegExp) => {
    mocks.auth = { mode: "custom", isAdmin: true, isLoading: false };
    renderAdmin(ui);
    await screen.findByRole("heading", { name: ready });
    return userEvent.setup();
  };

  it("saves the question against the selected division", async () => {
    const user = await renderAsAdmin(<AdminBallotPage />, /ballot question/i);

    await user.click(screen.getByRole("button", { name: /save question/i }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.write.mock.calls[0][0]).toMatchObject({
      address: DIVISION.votingContract,
      functionName: "setQuestion",
      args: ["Who should represent Kaduwela?"],
    });
  });

  it("sends durations as bigint seconds, parsed from hh:mm:ss", async () => {
    const user = await renderAsAdmin(<AdminOperationsPage />, /phase controls/i);

    // Named after the selected division, which is also what tells this button
    // apart from the "… on all N divisions" one in the same section.
    await user.click(screen.getByRole("button", { name: /start registration on kaduwela/i }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.write.mock.calls[0][0]).toMatchObject({ functionName: "startRegistration", args: [3600n] });
  });

  it("applies an ALL-divisions action to every division contract", async () => {
    const user = await renderAsAdmin(<AdminOperationsPage />, /phase controls/i);

    await user.click(screen.getByRole("button", { name: /start registration on all/i }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.write.mock.calls[0][0]).toMatchObject({
      address: DIVISION.votingContract,
      functionName: "startRegistration",
    });
    expect(mocks.notifySuccess).toHaveBeenCalledWith(expect.stringContaining("Registration started on 1 division"));
  });

  it("skips a division that reverts instead of aborting the whole run", async () => {
    const user = await renderAsAdmin(<AdminOperationsPage />, /phase controls/i);
    mocks.write.mockRejectedValue(new Error("Voting__WrongPhase"));

    await user.click(screen.getByRole("button", { name: /end election on all/i }));

    await waitFor(() => expect(mocks.notifySuccess).toHaveBeenCalledWith(expect.stringContaining("skipped")));
  });

  /**
   * A national phase change is a one-way door — `Voting` cannot go back without
   * a full reset — and it acts on divisions the operator cannot see from here.
   * The reversible ballot broadcasts already asked; these used to fire on the
   * first click.
   */
  it("does not run a national phase change when the operator cancels", async () => {
    const user = await renderAsAdmin(<AdminOperationsPage />, /phase controls/i);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));

    await user.click(screen.getByRole("button", { name: /end election on all/i }));

    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("creates a division on the registry, not on a division contract", async () => {
    const user = await renderAsAdmin(<AdminDivisionsPage />, /add new division/i);

    await user.type(screen.getByPlaceholderText(/Kandy, Matara/), "Galle");
    await user.click(screen.getByRole("button", { name: /deploy & register division/i }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.write.mock.calls[0][0]).toMatchObject({
      address: REGISTRY,
      functionName: "createDivision",
      args: ["Galle"],
    });
  });

  /**
   * The regression tests for a real defect: the Add Division panel used to make
   * only the `createDivision` call and report success, leaving the division
   * unusable for GN enrolment because `NicRegistry.reserveNicHash` refuses any
   * contract that was never passed to `setVotingContract`. The contract
   * behaviour these rely on is pinned in
   * `packages/hardhat/test/DivisionEnrolment.ts`.
   */
  it("also authorises the new division for NIC enrolment", async () => {
    const user = await renderAsAdmin(<AdminDivisionsPage />, /add new division/i);

    await user.type(screen.getByPlaceholderText(/Kandy, Matara/), "Galle");
    await user.click(screen.getByRole("button", { name: /deploy & register division/i }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2));
    expect(mocks.write.mock.calls[1][0]).toMatchObject({
      address: NIC_REGISTRY,
      functionName: "setVotingContract",
      args: [NEW_DIVISION_ADDRESS, true],
    });
    expect(mocks.notifySuccess).toHaveBeenCalledWith(expect.stringContaining("authorised"));
  });

  it("warns rather than claiming success when authorisation fails", async () => {
    const user = await renderAsAdmin(<AdminDivisionsPage />, /add new division/i);
    // The division is created, then the second call fails. Reporting a plain
    // error would imply nothing happened, which is the opposite of the truth.
    mocks.write.mockResolvedValueOnce("0xdeadbeef").mockRejectedValueOnce(new Error("relay refused"));

    await user.type(screen.getByPlaceholderText(/Kandy, Matara/), "Galle");
    await user.click(screen.getByRole("button", { name: /deploy & register division/i }));

    await waitFor(() => expect(mocks.notifyWarning).toHaveBeenCalled());
    const warning = mocks.notifyWarning.mock.calls[0][0] as string;
    expect(warning).toContain("was created");
    expect(warning).toContain("relay refused");
    expect(mocks.notifySuccess).not.toHaveBeenCalledWith(expect.stringContaining("authorised"));
  });

  it("lists divisions that were never authorised, and can repair one", async () => {
    // No VotingContractUpdated events at all: the state of any chain whose
    // divisions were created by hand before this was wired up.
    mocks.getLogs.mockResolvedValue([]);

    const user = await renderAsAdmin(<AdminDivisionsPage />, /add new division/i);

    await waitFor(() => expect(screen.getByText(/cannot be used for GN enrolment yet/i)).toBeDefined());
    await user.click(screen.getByRole("button", { name: /^authorise$/i }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.write.mock.calls[0][0]).toMatchObject({
      address: NIC_REGISTRY,
      functionName: "setVotingContract",
      args: [DIVISION.votingContract, true],
    });
  });

  it("says nothing when every division is already authorised", async () => {
    // The default stub authorises the sample division, so the warning must not
    // appear — an indicator that cries wolf on a correctly deployed chain would
    // be worse than none.
    await renderAsAdmin(<AdminDivisionsPage />, /add new division/i);

    await waitFor(() => expect(mocks.getLogs).toHaveBeenCalled());
    expect(screen.queryByText(/cannot be used for GN enrolment yet/i)).toBeNull();
  });

  it("assigns a GN officer on the chosen division contract", async () => {
    const user = await renderAsAdmin(<AdminDivisionsPage />, /gn officer management/i);

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
    await renderAsAdmin(<AdminBallotPage />, /ballot question/i);

    expect(screen.getByText(/voters are enrolled by their Grama Niladhari officer/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: /submit allowlist/i })).toBeNull();
  });

  it("keeps the voter allowlist in hardhat mode, where the owner may call addVoters", async () => {
    renderAdmin(<AdminBallotPage />);
    await screen.findByText(/ballot question/i);

    expect(screen.getByRole("button", { name: /submit allowlist/i })).toBeDefined();
  });

  it("surfaces a relay refusal through the existing error toast", async () => {
    const user = await renderAsAdmin(<AdminBallotPage />, /ballot question/i);
    mocks.write.mockRejectedValue(Object.assign(new Error("x"), { shortMessage: "Voting__WrongPhase" }));

    await user.click(screen.getByRole("button", { name: /save question/i }));

    await waitFor(() => expect(mocks.notifyError).toHaveBeenCalledWith("Voting__WrongPhase"));
  });

  /**
   * A per-division save used to report nothing at all: the button un-greyed and
   * that was the whole signal, which looks the same as a click that never
   * registered. The failure path always toasted — only success was silent.
   */
  it("confirms a per-division save, naming the division it landed on", async () => {
    const user = await renderAsAdmin(<AdminBallotPage />, /ballot question/i);

    await user.click(screen.getByRole("button", { name: /save question for/i }));

    await waitFor(() => expect(mocks.notifySuccess).toHaveBeenCalledWith(expect.stringContaining("Kaduwela")));
  });
});

describe("admin area — candidates, per division and across all of them", () => {
  const renderBallot = async () => {
    mocks.auth = { mode: "custom", isAdmin: true, isLoading: false };
    renderAdmin(<AdminBallotPage />);
    await screen.findByRole("heading", { name: /^candidates$/i });
    return userEvent.setup();
  };

  it("saves the slate to the selected division only", async () => {
    const user = await renderBallot();

    await user.click(screen.getByRole("button", { name: /save candidates for/i }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.write.mock.calls[0][0]).toMatchObject({
      address: DIVISION.votingContract,
      functionName: "setCandidates",
      args: [["Alice", "Bob"]],
    });
  });

  it("confirms the save, without claiming the broadcast's division count", async () => {
    const user = await renderBallot();

    await user.click(screen.getByRole("button", { name: /save candidates for/i }));

    await waitFor(() => expect(mocks.notifySuccess).toHaveBeenCalledWith("2 candidates saved for Kaduwela"));
  });

  it("broadcasts the same slate to every division", async () => {
    const user = await renderBallot();

    await user.click(screen.getByRole("button", { name: /apply candidates to all/i }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.write.mock.calls[0][0]).toMatchObject({
      address: DIVISION.votingContract,
      functionName: "setCandidates",
      args: [["Alice", "Bob"]],
    });
    expect(mocks.notifySuccess).toHaveBeenCalledWith(expect.stringContaining("Candidate list applied on 1 division"));
  });

  it("skips divisions past Setup rather than aborting the broadcast", async () => {
    const user = await renderBallot();
    mocks.write.mockRejectedValue(new Error("Voting__WrongPhase"));

    await user.click(screen.getByRole("button", { name: /apply candidates to all/i }));

    await waitFor(() => expect(mocks.notifySuccess).toHaveBeenCalledWith(expect.stringContaining("skipped")));
  });

  it("does not write anything when the operator cancels the broadcast", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    const user = await renderBallot();

    await user.click(screen.getByRole("button", { name: /apply candidates to all/i }));

    expect(mocks.write).not.toHaveBeenCalled();
  });

  /**
   * Both paths run the same validation. A broadcast that accepted a list the
   * per-division save rejects would put a ballot on every contract that the UI
   * refuses to set on one.
   */
  it("refuses an empty slate from either path, without writing", async () => {
    // Nothing on chain to seed the drafts from, so they stay blank.
    mocks.readContract.mockImplementation(({ functionName }: { functionName: string }) => {
      if (functionName === "getVotingData") return Promise.resolve(VOTING_DATA);
      if (functionName === "getCandidates") return Promise.resolve([]);
      if (functionName === "owner") return Promise.resolve(OWNER);
      return Promise.resolve(undefined);
    });
    const user = await renderBallot();

    await user.click(screen.getByRole("button", { name: /save candidates for/i }));
    await user.click(screen.getByRole("button", { name: /apply candidates to all/i }));

    await waitFor(() => expect(mocks.notifyError).toHaveBeenCalledWith("Add at least one candidate."));
    expect(mocks.notifyError).toHaveBeenCalledTimes(2);
    expect(mocks.write).not.toHaveBeenCalled();
  });
});

describe("admin area — the ballot question, per division and across all of them", () => {
  const renderBallot = async () => {
    mocks.auth = { mode: "custom", isAdmin: true, isLoading: false };
    renderAdmin(<AdminBallotPage />);
    await screen.findByRole("heading", { name: /ballot question/i });
    return userEvent.setup();
  };

  it("broadcasts the same question to every division", async () => {
    const user = await renderBallot();

    await user.click(screen.getByRole("button", { name: /apply question to all/i }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.write.mock.calls[0][0]).toMatchObject({
      address: DIVISION.votingContract,
      functionName: "setQuestion",
      args: ["Who should represent Kaduwela?"],
    });
    expect(mocks.notifySuccess).toHaveBeenCalledWith(expect.stringContaining("Ballot question applied on 1 division"));
  });

  it("does not write anything when the operator cancels the broadcast", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    const user = await renderBallot();

    await user.click(screen.getByRole("button", { name: /apply question to all/i }));

    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("offers the division picker on this tab, so the ballot can be retargeted here", async () => {
    await renderBallot();

    expect(screen.getByRole("combobox", { name: /active division/i })).toBeDefined();
  });

  /**
   * Both save buttons name their target. Two controls a few pixels apart, one
   * writing to one division and one to all of them, is precisely where an
   * unlabelled "Save" gets clicked by mistake.
   */
  it("names the target division on the per-division save buttons", async () => {
    await renderBallot();

    expect(screen.getByRole("button", { name: /save question for Kaduwela/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /save candidates for Kaduwela/i })).toBeDefined();
  });
});

/**
 * What the save buttons say about themselves.
 *
 * These used to report nothing: a click ran "Save question" → "Saving…" →
 * "Save question", so the button looked identical whether the transaction
 * landed or the click never registered. The only evidence was a toast, which
 * an operator who looked away never sees — and an operator who is unsure
 * whether a save worked clicks again, which on a chain is a second
 * transaction.
 *
 * Both buttons are driven from one component and one piece of provider state,
 * so each case is asserted on both: a settled state that behaved differently
 * between two controls a few pixels apart would be worse than none.
 */
describe("admin area — save buttons report their outcome", () => {
  const renderBallot = async () => {
    mocks.auth = { mode: "custom", isAdmin: true, isLoading: false };
    renderAdmin(<AdminBallotPage />);
    await screen.findByRole("heading", { name: /ballot question/i });
    return userEvent.setup();
  };

  /** The per-division save for each of the two panels. */
  const SAVE_BUTTONS = [
    { what: "question", idle: /save question for Kaduwela/i },
    { what: "candidates", idle: /save candidates for Kaduwela/i },
  ];

  for (const { what, idle } of SAVE_BUTTONS) {
    it(`${what}: settles on "Saved" once the write lands, and stays there`, async () => {
      const user = await renderBallot();

      await user.click(screen.getByRole("button", { name: idle }));

      // The button itself carries the verdict — not only the toast.
      const saved = await screen.findByRole("button", { name: /^saved$/i });
      expect(screen.queryByRole("button", { name: idle })).toBeNull();

      // Settled, so there is nothing left to do until the data changes. An
      // enabled button here invites a second identical transaction from an
      // operator unsure whether the first landed.
      expect((saved as HTMLButtonElement).disabled).toBe(true);

      // And it does not expire. "Saved" describes the data on screen, which
      // has not changed — a timer used to retire the verdict while it was
      // still true.
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(screen.getByRole("button", { name: /^saved$/i })).toBeDefined();
      expect(screen.queryByRole("button", { name: idle })).toBeNull();
    });

    it(`${what}: shows a spinner and "Saving…" while the write is in flight`, async () => {
      // Hold the write open so the in-flight state can be observed rather than
      // raced past.
      let land: (value: string) => void = () => {};
      mocks.write.mockReturnValueOnce(
        new Promise<string>(resolve => {
          land = resolve;
        }),
      );
      const user = await renderBallot();

      await user.click(screen.getByRole("button", { name: idle }));

      const saving = await screen.findByRole("button", { name: /saving/i });
      expect((saving as HTMLButtonElement).disabled).toBe(true);
      expect(saving.querySelector(".loading-spinner")).not.toBeNull();

      land("0xdeadbeef");
      await screen.findByRole("button", { name: /^saved$/i });
    });

    it(`${what}: says the save failed, and keeps saying it`, async () => {
      mocks.write.mockRejectedValueOnce(new Error("relay refused"));
      const user = await renderBallot();

      await user.click(screen.getByRole("button", { name: idle }));

      const failed = await screen.findByRole("button", { name: /save failed — retry/i });
      // Still clickable: after a failure the operator's next move is to retry.
      expect((failed as HTMLButtonElement).disabled).toBe(false);

      // A failure must never quietly fade back to the original label — that
      // would leave the operator believing it worked.
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(screen.getByRole("button", { name: /save failed — retry/i })).toBeDefined();
      expect(screen.queryByRole("button", { name: idle })).toBeNull();
    });

    it(`${what}: drops a stale verdict as soon as the value is edited again`, async () => {
      const user = await renderBallot();

      await user.click(screen.getByRole("button", { name: idle }));
      await screen.findByRole("button", { name: /^saved$/i });

      // Edit the thing that was just saved. "Saved" now describes a value that
      // is no longer on screen, which is the most misleading state the button
      // can be in — it asserts the opposite of the truth.
      //
      // The question is the page's only <textarea>; the candidate rows are
      // <input>s. Querying by role would match both (they are all `textbox`),
      // and an earlier version of this test silently typed into a candidate
      // row while asserting on the question's button.
      const field =
        what === "question"
          ? (document.querySelector("textarea") as HTMLTextAreaElement)
          : screen.getByPlaceholderText("Candidate #1");
      await user.type(field, "x");

      const back = await screen.findByRole("button", { name: idle });
      expect(screen.queryByRole("button", { name: /^saved$/i })).toBeNull();
      // Re-enabled: there is something new to save again.
      expect((back as HTMLButtonElement).disabled).toBe(false);
    });

    it(`${what}: clears a failure when the operator retries`, async () => {
      mocks.write.mockRejectedValueOnce(new Error("relay refused"));
      const user = await renderBallot();

      await user.click(screen.getByRole("button", { name: idle }));
      const failed = await screen.findByRole("button", { name: /save failed — retry/i });

      // The retry must not render the error state and the spinner at once.
      await user.click(failed);

      await screen.findByRole("button", { name: /^saved$/i });
      expect(screen.queryByRole("button", { name: /save failed — retry/i })).toBeNull();
    });
  }

  /**
   * One failing save must not make the other button look broken. They share a
   * component and a state container, so this is exactly the sort of thing that
   * breaks when the state is keyed too coarsely.
   */
  it("keeps the two buttons' verdicts separate", async () => {
    mocks.write.mockRejectedValueOnce(new Error("relay refused"));
    const user = await renderBallot();

    await user.click(screen.getByRole("button", { name: /save question for Kaduwela/i }));
    await screen.findByRole("button", { name: /save failed — retry/i });

    // The candidates button is untouched by the question's failure.
    expect(screen.getByRole("button", { name: /save candidates for Kaduwela/i })).toBeDefined();

    await user.click(screen.getByRole("button", { name: /save candidates for Kaduwela/i }));
    await screen.findByRole("button", { name: /^saved$/i });

    // …and the question's failure is still on display.
    expect(screen.getByRole("button", { name: /save failed — retry/i })).toBeDefined();
  });

  /**
   * The two broadcast buttons, which reported nothing for the same reason the
   * per-division ones used to: `busy` swapped the label to "Applying…" and put
   * the original back, so a fan-out across every division looked identical
   * whether it ran or the click missed. They sit a few pixels from the save
   * buttons, so the one that stayed silent was the one writing to *more*
   * contracts.
   *
   * The provider already tracked these verdicts (`all-question`,
   * `all-candidates`) and already cleared them on an edit — only the rendering
   * was missing.
   */
  const BROADCAST_BUTTONS = [
    { what: "question", idle: /apply question to all/i, field: () => document.querySelector("textarea")! },
    { what: "candidates", idle: /apply candidates to all/i, field: () => screen.getByPlaceholderText("Candidate #1") },
  ];

  for (const { what, idle, field } of BROADCAST_BUTTONS) {
    it(`broadcast ${what}: settles on "Applied" once the fan-out finishes`, async () => {
      const user = await renderBallot();

      await user.click(screen.getByRole("button", { name: idle }));

      const applied = await screen.findByRole("button", { name: /^applied$/i });
      expect((applied as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByRole("button", { name: idle })).toBeNull();
    });

    it(`broadcast ${what}: drops the verdict once the value is edited again`, async () => {
      const user = await renderBallot();

      await user.click(screen.getByRole("button", { name: idle }));
      await screen.findByRole("button", { name: /^applied$/i });

      await user.type(field() as HTMLElement, "x");

      expect(await screen.findByRole("button", { name: idle })).toBeDefined();
      expect(screen.queryByRole("button", { name: /^applied$/i })).toBeNull();
    });

    it(`broadcast ${what}: says nothing when the operator cancels the confirm`, async () => {
      vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
      const user = await renderBallot();

      await user.click(screen.getByRole("button", { name: idle }));

      // A cancelled broadcast wrote nothing, so claiming "Applied" would be the
      // worst thing this button could say.
      expect(screen.queryByRole("button", { name: /^applied$/i })).toBeNull();
      expect(screen.getByRole("button", { name: idle })).toBeDefined();
    });
  }

  /**
   * A broadcast and the per-division save next to it are separate verdicts.
   * Both write the same draft, which is exactly why one could be mistaken for
   * the other if they shared a label.
   */
  it("keeps a broadcast's verdict separate from the per-division save beside it", async () => {
    const user = await renderBallot();

    await user.click(screen.getByRole("button", { name: /apply question to all/i }));
    await screen.findByRole("button", { name: /^applied$/i });

    // The per-division save is untouched, and still says what it saves.
    expect(screen.getByRole("button", { name: /save question for Kaduwela/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^saved$/i })).toBeNull();
  });
});

/**
 * Save status belongs to a division, not to the screen.
 *
 * The first version of this feature cleared every verdict on a division
 * change, which made the common operator flow lie: configure Kaduwela, move to
 * Gampaha, come back, and Kaduwela reported itself unsaved when it was not.
 *
 * The drafts had to become per-division alongside the verdicts, and that is
 * not incidental. They used to be one shared pair, so switching divisions left
 * the previous division's text on screen — restoring "✓ Saved" over it would
 * have been a button asserting that what you are looking at is saved when it
 * is not. These tests check both halves: the verdict comes back, and it comes
 * back attached to the right data.
 */
describe("admin area — save status is tracked per division", () => {
  /** Each division's on-chain question, per `stubReads`. */
  const QUESTION = {
    Kaduwela: "Who should represent Kaduwela?",
    Gampaha: "Who should represent Gampaha?",
  };
  type DivisionName = keyof typeof QUESTION;

  const questionField = () => document.querySelector("textarea") as HTMLTextAreaElement;

  /** How many buttons currently report a completed save. */
  const savedCount = () => screen.queryAllByRole("button", { name: /^saved$/i }).length;

  /**
   * Waits for the ballot on screen to be the named division's.
   *
   * The picker's own label updates from the divisions array immediately, but
   * the drafts seed only once that division's contract reads resolve — so the
   * text is the signal that a switch has actually landed.
   */
  const awaitBallot = async (name: DivisionName) => waitFor(() => expect(questionField().value).toBe(QUESTION[name]));

  const renderTwoDivisions = async () => {
    mocks.divisions = [DIVISION, DIVISION_B];
    mocks.auth = { mode: "custom", isAdmin: true, isLoading: false };
    renderAdmin(<AdminBallotPage />);
    await screen.findByRole("heading", { name: /ballot question/i });
    await awaitBallot("Kaduwela");
    return userEvent.setup();
  };

  /** Point the whole admin area at another division, as the picker does. */
  const switchTo = async (user: ReturnType<typeof userEvent.setup>, index: number, name: DivisionName) => {
    await user.selectOptions(screen.getByRole("combobox", { name: /active division/i }), String(index));
    await awaitBallot(name);
  };

  const saveBoth = async (user: ReturnType<typeof userEvent.setup>, name: DivisionName) => {
    await user.click(screen.getByRole("button", { name: new RegExp(`save question for ${name}`, "i") }));
    await waitFor(() => expect(savedCount()).toBe(1));
    await user.click(screen.getByRole("button", { name: new RegExp(`save candidates for ${name}`, "i") }));
    await waitFor(() => expect(savedCount()).toBe(2));
  };

  it("keeps each division's verdicts when the operator moves between them", async () => {
    const user = await renderTwoDivisions();

    await saveBoth(user, "Kaduwela");

    // Gampaha starts clean — a fresh division has nothing saved.
    await switchTo(user, 1, "Gampaha");
    expect(savedCount()).toBe(0);
    expect(screen.getByRole("button", { name: /save question for Gampaha/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /save candidates for Gampaha/i })).toBeDefined();

    await saveBoth(user, "Gampaha");

    // Back to Kaduwela: its verdicts are still there. This is the bug — the
    // previous version cleared every verdict on a division change, so Kaduwela
    // reported itself unsaved when it was not.
    await switchTo(user, 0, "Kaduwela");
    expect(savedCount()).toBe(2);

    // And Gampaha's survived the round trip too.
    await switchTo(user, 1, "Gampaha");
    expect(savedCount()).toBe(2);
  });

  it("carries each division's ballot with it, so a restored verdict describes what is on screen", async () => {
    const user = await renderTwoDivisions();

    expect((screen.getByPlaceholderText("Candidate #1") as HTMLInputElement).value).toBe("Alice");

    await switchTo(user, 1, "Gampaha");

    // Each division shows its own ballot. Without this, a restored "✓ Saved"
    // would sit above another division's text — a button claiming that what
    // you are looking at is saved, when it is not.
    await waitFor(() =>
      expect((screen.getByPlaceholderText("Candidate #1") as HTMLInputElement).value).toBe("Chandra"),
    );

    await switchTo(user, 0, "Kaduwela");
    await waitFor(() => expect((screen.getByPlaceholderText("Candidate #1") as HTMLInputElement).value).toBe("Alice"));
  });

  it("retires only the edited question's verdict, on only that division", async () => {
    const user = await renderTwoDivisions();

    await saveBoth(user, "Kaduwela");
    await switchTo(user, 1, "Gampaha");
    await saveBoth(user, "Gampaha");

    // Edit Gampaha's question only.
    await user.type(questionField(), "?");

    // Gampaha: question back to idle and enabled, candidates still saved.
    const back = screen.getByRole("button", { name: /save question for Gampaha/i });
    expect((back as HTMLButtonElement).disabled).toBe(false);
    expect(savedCount()).toBe(1);

    // Kaduwela is untouched by an edit made on Gampaha.
    await switchTo(user, 0, "Kaduwela");
    expect(savedCount()).toBe(2);
  });

  it("retires only the candidate verdict when the slate is edited", async () => {
    const user = await renderTwoDivisions();

    await saveBoth(user, "Kaduwela");

    await user.type(screen.getByPlaceholderText("Candidate #1"), "x");

    // Candidates back to idle; the question's verdict is unaffected.
    expect(screen.getByRole("button", { name: /save candidates for Kaduwela/i })).toBeDefined();
    expect(savedCount()).toBe(1);

    // And it did not leak onto the other division.
    await switchTo(user, 1, "Gampaha");
    expect(savedCount()).toBe(0);
  });

  it("keeps a failure on the division it happened to, and lets that division retry", async () => {
    const user = await renderTwoDivisions();

    await saveBoth(user, "Kaduwela");

    // Gampaha's question save fails.
    await switchTo(user, 1, "Gampaha");
    mocks.write.mockRejectedValueOnce(new Error("relay refused"));
    await user.click(screen.getByRole("button", { name: /save question for Gampaha/i }));
    await screen.findByRole("button", { name: /save failed — retry/i });

    // Kaduwela does not inherit Gampaha's failure.
    await switchTo(user, 0, "Kaduwela");
    expect(screen.queryByRole("button", { name: /save failed — retry/i })).toBeNull();
    expect(savedCount()).toBe(2);

    // The failure is still waiting on Gampaha, and retrying there works.
    await switchTo(user, 1, "Gampaha");
    await screen.findByRole("button", { name: /save failed — retry/i });
    await user.click(screen.getByRole("button", { name: /save failed — retry/i }));

    await waitFor(() => expect(screen.queryByRole("button", { name: /save failed — retry/i })).toBeNull());
    expect(savedCount()).toBe(1);
  });

  it("lands a mid-save division switch on the division that was saved", async () => {
    const user = await renderTwoDivisions();

    // Hold the write open, switch division while it is in flight, then let it
    // land. The verdict must attach to the division the operator clicked on,
    // not to whatever is on screen when it resolves.
    let land: (value: string) => void = () => {};
    mocks.write.mockReturnValueOnce(
      new Promise<string>(resolve => {
        land = resolve;
      }),
    );

    await user.click(screen.getByRole("button", { name: /save question for Kaduwela/i }));
    await screen.findByRole("button", { name: /saving/i });

    await switchTo(user, 1, "Gampaha");
    // Gampaha shows no spinner: the in-flight save is not its own.
    expect(screen.queryByRole("button", { name: /saving/i })).toBeNull();

    land("0xdeadbeef");

    await switchTo(user, 0, "Kaduwela");
    await waitFor(() => expect(savedCount()).toBe(1));
  });
});

describe("admin area — an officer who cannot sign is not shown as staffed", () => {
  /**
   * On the custom chain an officer signs with a server-held key tied to a
   * credential account, so a non-zero `s_gnOfficer` proves nothing on its own.
   * A chain deployed with wallet-mode defaults carries Hardhat addresses no
   * account holds — and reporting those as "Assigned" is exactly how a chain
   * that cannot enrol a single voter reads as fully configured.
   */
  const stubAccounts = (accounts: { address: string }[]) =>
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ accounts }) } as unknown as Response),
    );

  const renderDivisions = async () => {
    mocks.auth = { mode: "custom", isAdmin: true, isLoading: false };
    renderAdmin(<AdminDivisionsPage />);
    await screen.findByRole("heading", { name: /gn officer management/i });
  };

  it("flags a division whose on-chain officer has no credential account", async () => {
    stubAccounts([]);

    await renderDivisions();

    await waitFor(() => expect(screen.getByText(/cannot enrol voters/i)).toBeDefined());
    expect(screen.getByText("No account")).toBeDefined();
    expect(screen.queryByText("Assigned")).toBeNull();
  });

  it("reports it as assigned once an account holds that address", async () => {
    stubAccounts([{ address: DIVISION.gnOfficer }]);

    await renderDivisions();

    await waitFor(() => expect(screen.getByText("Assigned")).toBeDefined());
    expect(screen.queryByText(/cannot enrol voters/i)).toBeNull();
    expect(screen.queryByText("No account")).toBeNull();
  });

  it("says nothing in hardhat mode, where an officer is simply a wallet", async () => {
    // No account store exists here at all; a wallet address is its own credential.
    renderAdmin(<AdminDivisionsPage />);
    await screen.findByRole("heading", { name: /gn officer management/i });

    await waitFor(() => expect(screen.getByText("Assigned")).toBeDefined());
    expect(screen.queryByText(/cannot enrol voters/i)).toBeNull();
  });
});

describe("admin area — live state does not flicker", () => {
  /**
   * The regression test for a real defect.
   *
   * `useDivisions` re-polls every 4s and returns a fresh object per division, so
   * `selectedDiv` changes identity constantly. The provider used to depend on
   * that object, and its effect blanked `votingData` before each re-read —
   * which dropped `phase` to its `?? 0` fallback, i.e. Setup. Mid-election that
   * briefly re-enabled the Setup-only controls, so an operator could click
   * "Save question" during Voting and get a revert.
   *
   * The page re-renders once a second on its own (the countdown ticker), which
   * is enough to reproduce the churn without touching timers.
   */
  it("re-reads the division on a timer, not on every render", async () => {
    mocks.auth = { mode: "custom", isAdmin: true, isLoading: false };
    mocks.readContract.mockImplementation(({ functionName }: { functionName: string }) => {
      // Phase 2 = Voting: the ballot is frozen.
      if (functionName === "getVotingData")
        return Promise.resolve(["Who should represent Kaduwela?", OWNER, 2, 0, 0, 0, 0, 0n, 2]);
      if (functionName === "getCandidates") return Promise.resolve(["Alice", "Bob"]);
      if (functionName === "owner") return Promise.resolve(OWNER);
      return Promise.resolve(undefined);
    });

    renderAdmin(<AdminBallotPage />);
    await screen.findByRole("heading", { name: /ballot question/i });

    // Settle the initial load, then measure only what happens afterwards.
    await waitFor(() => expect(mocks.readContract).toHaveBeenCalled());
    const afterFirstLoad = mocks.readContract.mock.calls.length;

    // Long enough for the 1s countdown ticker to re-render several times, and
    // short enough that the deliberate 4s poll fires at most once.
    await new Promise(resolve => setTimeout(resolve, 1500));

    const added = mocks.readContract.mock.calls.length - afterFirstLoad;

    // Keyed on the object, each of those re-renders re-created `refetchDivision`,
    // which re-ran the effect, which set state, which re-rendered… a read storm
    // that also blanked `votingData` — dropping `phase` to its `?? 0` fallback
    // and briefly re-enabling the Setup-only controls mid-election.
    expect(added).toBeLessThanOrEqual(3);

    // And the frozen ballot stayed frozen throughout.
    expect((screen.getByRole("button", { name: /save question/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

/**
 * The allowlist button while `addVoters` is in flight.
 *
 * The Hardhat-only twin of the GN portal's enrol button, and it used to have
 * the opposite defect: no spinner at all, just a label swap that shrank the
 * button mid-transaction. Both now render the same reserved spinner slot, so
 * an operator who has learned one recognises the other.
 */
describe("admin ballot — the allowlist button's pending state", () => {
  it("shows a spinner beside a legible label, in a slot that was already there", async () => {
    // Held open so the in-flight state can be observed rather than raced past.
    let land: (value: string) => void = () => {};
    mocks.write.mockReturnValueOnce(
      new Promise<string>(resolve => {
        land = resolve;
      }),
    );

    renderAdmin(<AdminBallotPage />);
    await screen.findByRole("heading", { name: /allowlist voters/i });
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("0x..."), DIVISION.gnOfficer);

    const idle = screen.getByRole("button", { name: /submit allowlist/i });
    const idleClass = idle.getAttribute("class");
    const idleSlot = idle.querySelector("[aria-hidden='true']");
    expect(idleSlot).not.toBeNull();
    expect(idle.querySelector(".loading-spinner")).toBeNull();

    await user.click(idle);

    const saving = await screen.findByRole("button", { name: /^saving\.\.\.$/i });
    expect(saving.querySelector(".loading-spinner")).not.toBeNull();
    expect(saving.querySelector("[aria-hidden='true']")!.getAttribute("class")).toBe(idleSlot!.getAttribute("class"));
    // `loading` on the button itself is what masked it away in daisyUI 5.
    expect(saving.className.split(/\s+/)).not.toContain("loading");
    expect(saving.getAttribute("class")).toBe(idleClass);
    expect((saving as HTMLButtonElement).disabled).toBe(true);
    expect(saving.getAttribute("aria-busy")).toBe("true");

    land("0xdeadbeef");

    const settled = await screen.findByRole("button", { name: /submit allowlist/i });
    expect(settled.querySelector(".loading-spinner")).toBeNull();
    expect(settled.getAttribute("aria-busy")).toBe("false");
    expect(mocks.write.mock.calls[0][0]).toMatchObject({ functionName: "addVoters" });
  });
});

/**
 * The two provisioning buttons on the Divisions tab.
 *
 * `Authorise` is the interesting one: there is a button per unauthorised
 * division and they all disable together, so the spinner is the only thing
 * that says *which* one is being written. A pending flag keyed to the section
 * rather than the row would spin every button at once and lose exactly that.
 */
describe("admin divisions — the provisioning buttons' pending state", () => {
  it("spins only the division being authorised, not every waiting row", async () => {
    mocks.divisions = [DIVISION, DIVISION_B];
    // No authorisation events: both divisions show up as needing repair.
    mocks.getLogs.mockResolvedValue([]);
    let land: (value: string) => void = () => {};
    mocks.write.mockReturnValueOnce(
      new Promise<string>(resolve => {
        land = resolve;
      }),
    );

    render(<AddDivisionSection />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /authorise/i })).toHaveLength(2));
    const user = userEvent.setup();

    const [first, second] = screen.getAllByRole("button", { name: /authorise/i });
    const idleClass = first.getAttribute("class");
    expect(first.querySelector("[aria-hidden='true']")).not.toBeNull();

    await user.click(first);

    await waitFor(() => expect(first.querySelector(".loading-spinner")).not.toBeNull());
    // Both are disabled — one write at a time — but only the clicked row says
    // it is the one in flight.
    expect(second.querySelector(".loading-spinner")).toBeNull();
    expect(first.getAttribute("aria-busy")).toBe("true");
    expect(second.getAttribute("aria-busy")).toBe("false");
    expect((second as HTMLButtonElement).disabled).toBe(true);
    expect(first.className.split(/\s+/)).not.toContain("loading");
    expect(first.getAttribute("class")).toBe(idleClass);

    land("0xdeadbeef");
    await waitFor(() => expect(first.querySelector(".loading-spinner")).toBeNull());
  });

  it("spins the deploy button while the division is being created", async () => {
    let land: (value: string) => void = () => {};
    mocks.write.mockReturnValueOnce(
      new Promise<string>(resolve => {
        land = resolve;
      }),
    );

    render(<AddDivisionSection />);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/Kandy, Matara/i), "Galle");

    const idle = screen.getByRole("button", { name: /deploy & register division/i });
    const idleSlot = idle.querySelector("[aria-hidden='true']");
    expect(idleSlot).not.toBeNull();
    expect(idle.querySelector(".loading-spinner")).toBeNull();

    await user.click(idle);

    const deploying = await screen.findByRole("button", { name: /deploying/i });
    expect(deploying.querySelector(".loading-spinner")).not.toBeNull();
    expect(deploying.querySelector("[aria-hidden='true']")!.getAttribute("class")).toBe(
      idleSlot!.getAttribute("class"),
    );
    expect(deploying.className.split(/\s+/)).not.toContain("loading");
    expect((deploying as HTMLButtonElement).disabled).toBe(true);
    expect(deploying.getAttribute("aria-busy")).toBe("true");

    land("0xdeadbeef");
    await screen.findByRole("button", { name: /deploy & register division/i });
  });
});
