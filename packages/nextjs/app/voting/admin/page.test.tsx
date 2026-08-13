import { AddDivisionSection } from "./_components/AddDivisionSection";
import { AdminElectionProvider } from "./_components/AdminElectionProvider";
import AdminBallotPage from "./ballot/page";
import AdminDivisionsPage from "./divisions/page";
import AdminOperationsPage from "./page";
import { render, screen, waitFor, within } from "@testing-library/react";
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
});

afterEach(() => vi.unstubAllGlobals());

/**
 * Answer the confirmation a destructive action raises.
 *
 * These gates used to be `window.confirm`, stubbed once in `beforeEach` to
 * always agree — which meant no test actually proved the prompt was still
 * there. The gate is now a real dialog, so every test that wants the action to
 * run has to answer it, and an action that stopped asking fails here.
 *
 * Located by elimination rather than by label: the confirm button is named
 * after the action it performs ("Apply to all", "End the election", "Delete
 * everything"), and only Cancel is constant across all of them.
 */
const answerConfirm = async (user: ReturnType<typeof userEvent.setup>, choice: "confirm" | "cancel") => {
  const dialog = await screen.findByRole("dialog");
  const buttons = within(dialog).getAllByRole("button");
  const cancel = buttons.find(button => /^cancel$/i.test(button.textContent ?? ""))!;
  await user.click(choice === "cancel" ? cancel : buttons.find(button => button !== cancel)!);
};

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
    await answerConfirm(user, "confirm");

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.write.mock.calls[0][0]).toMatchObject({
      address: DIVISION.votingContract,
      functionName: "startRegistration",
    });
    expect(mocks.notifySuccess).toHaveBeenCalledWith(expect.stringContaining("Registration started on 1 division"));
  });

  it("skips a division that reverts instead of aborting the whole run", async () => {
    // Voting phase, so "End election on all" is actually offered — the master
    // controls are now gated on the division mix, and a Setup-only fixture
    // would leave this button disabled and the click a no-op.
    mocks.divisions = [{ ...DIVISION, phase: 2 }];
    const user = await renderAsAdmin(<AdminOperationsPage />, /phase controls/i);
    mocks.write.mockRejectedValue(new Error("Voting__WrongPhase"));

    await user.click(screen.getByRole("button", { name: /end election on all/i }));
    await answerConfirm(user, "confirm");

    await waitFor(() => expect(mocks.notifySuccess).toHaveBeenCalledWith(expect.stringContaining("skipped")));
  });

  /**
   * A national phase change is a one-way door — `Voting` cannot go back without
   * a full reset — and it acts on divisions the operator cannot see from here.
   * The reversible ballot broadcasts already asked; these used to fire on the
   * first click.
   */
  it("does not run a national phase change when the operator cancels", async () => {
    mocks.divisions = [{ ...DIVISION, phase: 2 }];
    const user = await renderAsAdmin(<AdminOperationsPage />, /phase controls/i);

    await user.click(screen.getByRole("button", { name: /end election on all/i }));
    await answerConfirm(user, "cancel");

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
    await answerConfirm(user, "confirm");

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
    await answerConfirm(user, "confirm");

    await waitFor(() => expect(mocks.notifySuccess).toHaveBeenCalledWith(expect.stringContaining("skipped")));
  });

  it("does not write anything when the operator cancels the broadcast", async () => {
    const user = await renderBallot();

    await user.click(screen.getByRole("button", { name: /apply candidates to all/i }));
    await answerConfirm(user, "cancel");

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
    await answerConfirm(user, "confirm");

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.write.mock.calls[0][0]).toMatchObject({
      address: DIVISION.votingContract,
      functionName: "setQuestion",
      args: ["Who should represent Kaduwela?"],
    });
    expect(mocks.notifySuccess).toHaveBeenCalledWith(expect.stringContaining("Ballot question applied on 1 division"));
  });

  it("does not write anything when the operator cancels the broadcast", async () => {
    const user = await renderBallot();

    await user.click(screen.getByRole("button", { name: /apply question to all/i }));
    await answerConfirm(user, "cancel");

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
      await answerConfirm(user, "confirm");

      const applied = await screen.findByRole("button", { name: /^applied$/i });
      expect((applied as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByRole("button", { name: idle })).toBeNull();
    });

    it(`broadcast ${what}: drops the verdict once the value is edited again`, async () => {
      const user = await renderBallot();

      await user.click(screen.getByRole("button", { name: idle }));
      await answerConfirm(user, "confirm");
      await screen.findByRole("button", { name: /^applied$/i });

      await user.type(field() as HTMLElement, "x");

      expect(await screen.findByRole("button", { name: idle })).toBeDefined();
      expect(screen.queryByRole("button", { name: /^applied$/i })).toBeNull();
    });

    it(`broadcast ${what}: says nothing when the operator cancels the confirm`, async () => {
      const user = await renderBallot();

      await user.click(screen.getByRole("button", { name: idle }));
      await answerConfirm(user, "cancel");

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
    await answerConfirm(user, "confirm");
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

/**
 * The confirmation gate on every destructive admin action.
 *
 * These were `window.confirm` until the dialog replaced it, and the risk in
 * that swap is not cosmetic. A gate that quietly stopped gating, or a Cancel
 * that no longer aborted, would let a one-way phase change or a full election
 * wipe run on a single click — and nothing else in this file would notice,
 * because the old tests agreed to every prompt via a global stub.
 *
 * So each action is driven both ways, and the prompt is compared against the
 * exact string `window.confirm` used to receive. The wording is the thing the
 * operator is agreeing to; it is as much a part of the gate as the button is.
 */
describe("admin area — the destructive-action confirmations", () => {
  const FANOUT_TAIL = "Divisions in the wrong phase are skipped and left exactly as they are. This cannot be undone.";

  /**
   * The gated actions, with the prompt each must raise for the one-division
   * fixture.
   *
   * `phase` is the fixture division's phase, defaulting to Setup. The master
   * phase controls are now disabled when no division is in a phase their action
   * accepts, so the two that act later in the lifecycle have to be met on a
   * division that has got there — otherwise the button under test is greyed out
   * and the confirmation it guards can never be raised.
   */
  const GATED = [
    {
      what: "question broadcast",
      page: () => <AdminBallotPage />,
      ready: /ballot question/i,
      button: /apply question to all/i,
      writes: "setQuestion",
      message:
        "Apply this question to all 1 division(s)?\n\n" +
        "This replaces the ballot question on every division still in the Setup phase. " +
        "Divisions past Setup are skipped and keep their current question.",
    },
    {
      what: "candidate broadcast",
      page: () => <AdminBallotPage />,
      ready: /^candidates$/i,
      button: /apply candidates to all/i,
      writes: "setCandidates",
      message:
        "Apply these 2 candidate(s) to all 1 division(s)?\n\n" +
        "This replaces the candidate list on every division still in the Setup phase. " +
        "Divisions past Setup are skipped and keep their current list.",
    },
    {
      what: "start registration on all",
      page: () => <AdminOperationsPage />,
      ready: /phase controls/i,
      button: /start registration on all/i,
      writes: "startRegistration",
      message:
        "Start registration on all 1 division(s)?\n\n" +
        "Every division still in Setup opens a 01:00:00 registration window. " +
        "Its ballot question and candidate list are frozen from that moment on.\n\n" +
        FANOUT_TAIL,
    },
    {
      what: "start voting on all",
      page: () => <AdminOperationsPage />,
      ready: /phase controls/i,
      button: /start voting on all/i,
      writes: "startVoting",
      // `startVoting` only takes a division in Registration.
      phase: 1,
      message:
        "Start voting on all 1 division(s)?\n\n" +
        "Every division still in Registration opens a 01:00:00 voting window. " +
        "No further voters can be enrolled there once it does.\n\n" +
        FANOUT_TAIL,
    },
    {
      what: "end election on all",
      page: () => <AdminOperationsPage />,
      ready: /phase controls/i,
      button: /end election on all/i,
      writes: "endElection",
      // `endElection` rejects Setup and Ended; Voting is the ordinary case.
      phase: 2,
      message:
        "End the election on all 1 division(s)?\n\n" +
        "Voting closes everywhere and the results are frozen. " +
        "No further votes are accepted on any division.\n\n" +
        FANOUT_TAIL,
    },
    {
      what: "start new election",
      page: () => <AdminOperationsPage />,
      ready: /phase controls/i,
      button: /start new election/i,
      // The wipe blanks each division's ballot before clearing the registry.
      writes: "resetElection",
      message:
        "Start a NEW election?\n\nThis permanently deletes EVERYTHING from the current election:\n" +
        "  • all 1 division(s) and their ballots, voters and votes\n" +
        "  • every GN officer account and their sign-in credentials\n" +
        "  • every NIC enrolment record\n\n" +
        "You will need to create the divisions and GN officers again from scratch. This cannot be undone.",
    },
  ];

  const open = async (entry: (typeof GATED)[number]) => {
    mocks.auth = { mode: "custom", isAdmin: true, isLoading: false };
    mocks.divisions = [{ ...DIVISION, phase: (entry as { phase?: number }).phase ?? 0 }];
    // Only the reset path calls it, and only to drop the GN accounts — but an
    // unstubbed `fetch` there throws inside the handler's own try/catch and
    // logs, which is noise this file does not need.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    renderAdmin(entry.page());
    await screen.findByRole("heading", { name: entry.ready });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: entry.button }));
    return user;
  };

  /** What the confirm button writes, if it wrote at all. */
  const wrote = (functionName: string) =>
    mocks.write.mock.calls.some((call: any[]) => call[0]?.functionName === functionName);

  for (const entry of GATED) {
    it(`${entry.what}: shows the prompt verbatim`, async () => {
      await open(entry);

      const dialog = await screen.findByRole("dialog");
      expect(dialog.querySelector("#confirm-dialog-message")!.textContent).toBe(entry.message);
      // Nothing has been written merely by opening the gate.
      expect(mocks.write).not.toHaveBeenCalled();
    });

    it(`${entry.what}: performs the action when confirmed`, async () => {
      const user = await open(entry);

      await answerConfirm(user, "confirm");

      await waitFor(() => expect(wrote(entry.writes)).toBe(true));
    });

    it(`${entry.what}: writes nothing when cancelled`, async () => {
      const user = await open(entry);

      await answerConfirm(user, "cancel");

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(mocks.write).not.toHaveBeenCalled();
    });

    /**
     * Escape is a dismissal, and a dismissal is a refusal. If it resolved the
     * other way, the key an operator presses to back out of a dialog would be
     * the key that wipes the election.
     */
    it(`${entry.what}: writes nothing when dismissed with Escape`, async () => {
      const user = await open(entry);
      await screen.findByRole("dialog");

      await user.keyboard("{Escape}");

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(mocks.write).not.toHaveBeenCalled();
    });
  }
});

/**
 * The master controls, against the division mix they actually act on.
 *
 * The regression test for a real defect: all three were gated on `busy` alone,
 * so once the divisions had advanced past the phase an action accepts, the
 * button stayed live. Clicking it opened a danger dialog, sent one relay
 * transaction per division, had every one revert, and reported "started on 0
 * division(s) · 12 skipped (wrong phase)" — minutes later, on a national
 * control, with the `PhaseSpread` immediately above already displaying the
 * counts that proved it could not work.
 *
 * The gate is per action, because the phase each one accepts is: `Voting` takes
 * `startRegistration` only in Setup, `startVoting` only in Registration, and
 * `endElection` in anything but Setup and Ended. Asserting them one at a time
 * would let a condition copied to the wrong button pass, so every mix below
 * checks all three at once.
 */
describe("admin operations — the master controls know when there is nothing left to do", () => {
  const MASTER = {
    registration: /start registration on all/i,
    voting: /start voting on all/i,
    end: /end election on all/i,
  };
  type Control = keyof typeof MASTER;
  const CONTROLS = ["registration", "voting", "end"] as const;

  /** Mount Operations against a division per entry, each in the given phase. */
  const renderWithPhases = async (phases: number[]) => {
    mocks.divisions = phases.map((phase, id) => ({
      ...DIVISION,
      id,
      phase,
      // A distinct contract each, so the provider keys divisions apart here the
      // way it does in production rather than collapsing them onto one address.
      votingContract: `0x${String(id + 1).padStart(40, "0")}` as `0x${string}`,
    }));
    mocks.auth = { mode: "custom", isAdmin: true, isLoading: false };
    renderAdmin(<AdminOperationsPage />);
    await screen.findByRole("heading", { name: /run election on all divisions/i });
  };

  const button = (which: Control) => screen.getByRole("button", { name: MASTER[which] }) as HTMLButtonElement;

  /**
   * Each division mix, and why each control is blocked in it — `null` meaning
   * it must still be available.
   *
   * Two divisions throughout, so "all N divisions" in a message is a claim that
   * could be wrong rather than a restatement of the only division there is.
   */
  const REGISTRATION_DONE = "Registration has already started on all 2 divisions.";
  const VOTING_DONE = "Voting has already started on all 2 divisions.";

  const STATES: {
    what: string;
    phases: number[];
    registration: string | null;
    voting: string | null;
    end: string | null;
  }[] = [
    {
      what: "no division has started",
      phases: [0, 0],
      registration: null,
      voting: "No division is in the Registration phase yet — start registration first.",
      end: "No division has started registration yet — there is nothing to end.",
    },
    {
      what: "some divisions have started registration",
      phases: [0, 1],
      registration: null,
      voting: null,
      end: null,
    },
    {
      what: "every division has started registration",
      phases: [1, 1],
      registration: REGISTRATION_DONE,
      voting: null,
      end: null,
    },
    {
      what: "some divisions have started voting",
      phases: [1, 2],
      registration: REGISTRATION_DONE,
      voting: null,
      end: null,
    },
    {
      what: "every division has started voting",
      phases: [2, 2],
      registration: REGISTRATION_DONE,
      voting: VOTING_DONE,
      end: null,
    },
    {
      what: "every division has ended",
      phases: [3, 3],
      registration: REGISTRATION_DONE,
      // Voting did start everywhere; it is simply over. The reason a division
      // cannot be moved into Voting from Ended is the same one either way.
      voting: VOTING_DONE,
      end: "The election has already ended on all 2 divisions.",
    },
  ];

  for (const state of STATES) {
    it(`${state.what}: enables exactly the controls that can still act`, async () => {
      await renderWithPhases(state.phases);

      for (const which of CONTROLS) {
        const reason = state[which];
        expect(button(which).disabled).toBe(reason !== null);
      }
    });

    it(`${state.what}: says why, in the tooltip and on the page`, async () => {
      await renderWithPhases(state.phases);

      for (const which of CONTROLS) {
        const reason = state[which];
        // The tooltip has to name the *actual* blocker. Three buttons greyed
        // out for three different reasons is precisely the state an operator
        // cannot work out for themselves.
        expect(button(which).getAttribute("title")).toBe(reason);
        // And it exists somewhere they will see it: a native tooltip on a
        // disabled control is unreliable across browsers.
        if (reason !== null) expect(screen.getByText(reason)).toBeDefined();
      }
    });
  }

  it("says nothing when every control is available", async () => {
    await renderWithPhases([0, 1]);

    for (const which of CONTROLS) {
      expect(button(which).disabled).toBe(false);
      expect(button(which).getAttribute("title")).toBeNull();
    }
    expect(screen.queryByText(/has already started on all/i)).toBeNull();
    expect(screen.queryByText(/nothing to end/i)).toBeNull();
  });

  /**
   * The empty registry keeps its own explanation. A flag that read `every([])`
   * as true would have greyed these out and said "already started on all 0
   * divisions" — but the buttons are not rendered here at all.
   */
  it("leaves the no-divisions path exactly as it was", async () => {
    await renderWithPhases([]);

    for (const which of CONTROLS) {
      expect(screen.queryByRole("button", { name: MASTER[which] })).toBeNull();
    }
    expect(screen.getByText(/no divisions registered yet/i)).toBeDefined();
  });

  /**
   * The gate decides availability and nothing else. An enabled button must
   * still raise the same confirmation and send the same per-division writes it
   * always did.
   */
  it("fans registration out unchanged when the button is still live", async () => {
    await renderWithPhases([0, 1]);
    const user = userEvent.setup();

    await user.click(button("registration"));
    await answerConfirm(user, "confirm");

    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2));
    expect(mocks.write.mock.calls.map((call: any[]) => call[0].functionName)).toEqual([
      "startRegistration",
      "startRegistration",
    ]);
    // Still every division, including the one the contract will reject — the
    // skip-and-report behaviour is the provider's, and is deliberately untouched.
    expect(mocks.write.mock.calls.map((call: any[]) => call[0].address)).toEqual([
      `0x${String(1).padStart(40, "0")}`,
      `0x${String(2).padStart(40, "0")}`,
    ]);
  });

  it("fans voting out unchanged when the button is still live", async () => {
    await renderWithPhases([1, 2]);
    const user = userEvent.setup();

    await user.click(button("voting"));
    await answerConfirm(user, "confirm");

    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2));
    expect(mocks.write.mock.calls.every((call: any[]) => call[0].functionName === "startVoting")).toBe(true);
  });

  it("fans the ending out unchanged when the button is still live", async () => {
    await renderWithPhases([1, 2]);
    const user = userEvent.setup();

    await user.click(button("end"));
    await answerConfirm(user, "confirm");

    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2));
    expect(mocks.write.mock.calls.every((call: any[]) => call[0].functionName === "endElection")).toBe(true);
  });

  /**
   * The two gates are independent, and this is the case that proves it: every
   * division has left Setup — blocking the master control — while the division
   * the operator has *selected* reads Setup from its own contract, so its own
   * button stays live. Sharing one condition between them would break whichever
   * of the two was not being looked at.
   */
  it("does not gate the per-division buttons on the national condition", async () => {
    await renderWithPhases([1, 1]);

    expect(button("registration").disabled).toBe(true);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /start registration on kaduwela/i }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });
});
