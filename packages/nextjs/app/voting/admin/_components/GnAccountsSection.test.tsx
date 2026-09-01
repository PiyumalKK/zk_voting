import { GnAccountsSection } from "./GnAccountsSection";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The GN Accounts panel (M12 build-order item 6).
 *
 * The behaviour worth pinning down is the one-time password: it is shown once
 * and only its bcrypt hash is stored, so if this panel ever failed to display
 * it the admin would have created an account nobody can sign in to. Second is
 * the half-success case — account created but `setGNOfficer` reverted — which
 * otherwise surfaces much later as a confusing revert during voter enrolment.
 */

const DIVISIONS = [
  {
    id: 0,
    name: "Kaduwela",
    votingContract: "0x0000000000000000000000000000000000000aa1",
    gnOfficers: ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8"],
    active: true,
    phase: 0,
    treeSize: 0,
    root: 0n,
  },
  {
    id: 1,
    name: "Colombo",
    votingContract: "0x0000000000000000000000000000000000000aa2",
    gnOfficers: [],
    active: true,
    phase: 0,
    treeSize: 0,
    root: 0n,
  },
];

const EXISTING_ACCOUNT = {
  id: "acc-1",
  username: "gn.kaduwela",
  divisionId: 0,
  address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  createdAt: "2026-08-01T00:00:00.000Z",
  disabled: false,
};

const mocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

vi.mock("~~/hooks/useDivisions", () => ({
  useDivisions: () => ({ divisions: DIVISIONS, isLoading: false, error: null, refetch: mocks.refetch }),
}));
vi.mock("~~/utils/scaffold-eth", () => ({
  notification: { error: mocks.notifyError, success: mocks.notifySuccess },
}));

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * Replaces `navigator.clipboard` for one test.
 *
 * `defineProperty` rather than `vi.stubGlobal("navigator", …)`: the property is
 * read-only, and swapping the whole navigator object leaves userEvent holding
 * the original. Restored in `afterEach`.
 */
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const setClipboard = (value: unknown) =>
  Object.defineProperty(navigator, "clipboard", { value, configurable: true, writable: true });

/** Answers the initial GET, then whatever the test queues for the mutation. */
const listReturns = (accounts: unknown[]) => fetchMock.mockResolvedValue(jsonResponse({ accounts }));

beforeEach(() => {
  mocks.refetch.mockClear();
  mocks.notifyError.mockClear();
  mocks.notifySuccess.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("GnAccountsSection", () => {
  it("lists existing officers with their division and on-chain state", async () => {
    listReturns([EXISTING_ACCOUNT]);

    render(<GnAccountsSection />);

    expect(await screen.findByText("gn.kaduwela")).toBeDefined();
    const row = screen.getByText("gn.kaduwela").closest("tr")!;
    expect(within(row).getByText("Kaduwela")).toBeDefined();
    expect(within(row).getByText("Assigned")).toBeDefined();
    expect(within(row).getByText("Active")).toBeDefined();
  });

  it("flags an account whose address is not the division's on-chain officer", async () => {
    listReturns([{ ...EXISTING_ACCOUNT, id: "acc-2", username: "gn.colombo", divisionId: 1 }]);

    render(<GnAccountsSection />);

    const row = (await screen.findByText("gn.colombo")).closest("tr")!;
    expect(within(row).getByText("Not assigned")).toBeDefined();
  });

  it("creates an officer and shows the one-time password exactly once", async () => {
    const user = userEvent.setup();
    listReturns([]);
    render(<GnAccountsSection />);
    await screen.findByText(/no gn accounts yet/i);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        username: "gn.colombo",
        password: "hunter2-generated",
        address: "0xabc0000000000000000000000000000000000001",
        divisionId: 1,
        divisionName: "Colombo",
        assigned: true,
      }),
    );
    fetchMock.mockResolvedValue(jsonResponse({ accounts: [] }));

    await user.type(screen.getByLabelText(/username/i), "gn.colombo");
    await user.selectOptions(screen.getByLabelText(/division/i), "1");
    await user.click(screen.getByRole("button", { name: /create officer/i }));

    const banner = await screen.findByRole("status");
    expect(banner.textContent).toContain("hunter2-generated");
    expect(banner.textContent).toMatch(/not stored/i);

    await user.click(screen.getByRole("button", { name: /i have saved it/i }));
    expect(screen.queryByText(/hunter2-generated/)).toBeNull();
  });

  it("copies the one-time password to the clipboard", async () => {
    // The password is unrecoverable once this banner is dismissed, so the copy
    // path is the difference between an account that works and one nobody can
    // sign in to.
    const user = userEvent.setup();
    // Installed *after* `setup()`, which fits userEvent with its own clipboard
    // stub and would otherwise shadow this one.
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    listReturns([]);
    render(<GnAccountsSection />);
    await screen.findByText(/no gn accounts yet/i);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ username: "gn.colombo", password: "hunter2-generated", divisionId: 1, assigned: true }),
    );
    fetchMock.mockResolvedValue(jsonResponse({ accounts: [] }));

    await user.type(screen.getByLabelText(/username/i), "gn.colombo");
    await user.click(screen.getByRole("button", { name: /create officer/i }));
    await screen.findByRole("status");

    await user.click(screen.getByRole("button", { name: /copy password/i }));

    expect(writeText).toHaveBeenCalledWith("hunter2-generated");
    expect(await screen.findByText("Copied")).toBeDefined();
  });

  it("says so when the clipboard is unavailable rather than looking broken", async () => {
    const user = userEvent.setup();
    // `navigator.clipboard` is undefined on insecure origins — reaching a dev
    // server over plain HTTP from another machine, for one.
    setClipboard(undefined);

    listReturns([]);
    render(<GnAccountsSection />);
    await screen.findByText(/no gn accounts yet/i);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ username: "gn.colombo", password: "hunter2-generated", divisionId: 1, assigned: true }),
    );
    fetchMock.mockResolvedValue(jsonResponse({ accounts: [] }));

    await user.type(screen.getByLabelText(/username/i), "gn.colombo");
    await user.click(screen.getByRole("button", { name: /create officer/i }));
    await screen.findByRole("status");

    await user.click(screen.getByRole("button", { name: /copy password/i }));

    await waitFor(() => expect(mocks.notifyError).toHaveBeenCalledWith(expect.stringMatching(/by hand/i)));
  });

  it("marks an officer who has not yet taken custody of their password", async () => {
    listReturns([{ ...EXISTING_ACCOUNT, mustChangePassword: true }]);

    render(<GnAccountsSection />);

    const row = (await screen.findByText("gn.kaduwela")).closest("tr")!;
    // They cannot enrol anyone yet, and the credential is still one the admin
    // has seen — worth showing rather than presenting them as fully active.
    expect(within(row).getByText(/awaiting first sign-in/i)).toBeDefined();
    expect(within(row).queryByText("Active")).toBeNull();
  });

  it("posts the chosen username and division", async () => {
    const user = userEvent.setup();
    listReturns([]);
    render(<GnAccountsSection />);
    await screen.findByText(/no gn accounts yet/i);

    fetchMock.mockResolvedValueOnce(jsonResponse({ username: "gn.colombo", password: "p", assigned: true }));
    fetchMock.mockResolvedValue(jsonResponse({ accounts: [] }));

    await user.type(screen.getByLabelText(/username/i), "  GN.Colombo  ");
    await user.selectOptions(screen.getByLabelText(/division/i), "1");
    await user.click(screen.getByRole("button", { name: /create officer/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(post![1].body)).toEqual({ username: "gn.colombo", divisionId: 1 });
    });
  });

  it("warns loudly when the account exists but setGNOfficer reverted", async () => {
    const user = userEvent.setup();
    listReturns([]);
    render(<GnAccountsSection />);
    await screen.findByText(/no gn accounts yet/i);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        username: "gn.colombo",
        password: "p",
        address: "0xabc",
        divisionId: 1,
        divisionName: "Colombo",
        assigned: false,
        assignError: "OwnableUnauthorizedAccount",
      }),
    );
    fetchMock.mockResolvedValue(jsonResponse({ accounts: [] }));

    await user.type(screen.getByLabelText(/username/i), "gn.colombo");
    await user.click(screen.getByRole("button", { name: /create officer/i }));

    await waitFor(() => expect(mocks.notifyError).toHaveBeenCalled());
    expect((await screen.findByRole("status")).textContent).toContain("OwnableUnauthorizedAccount");
  });

  it("suspends an officer without deleting their key", async () => {
    const user = userEvent.setup();
    listReturns([EXISTING_ACCOUNT]);
    render(<GnAccountsSection />);
    await screen.findByText("gn.kaduwela");

    await user.click(screen.getByRole("button", { name: /suspend/i }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(JSON.parse(patch![1].body)).toEqual({ username: "gn.kaduwela", disabled: true });
    });
  });

  it("confirms before deleting, and names the account in the prompt", async () => {
    const user = userEvent.setup();
    listReturns([EXISTING_ACCOUNT]);
    render(<GnAccountsSection />);
    await screen.findByText("gn.kaduwela");

    await user.click(screen.getByRole("button", { name: /delete/i }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("gn.kaduwela"));
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
      expect(del![0]).toBe("/api/gn-accounts?username=gn.kaduwela");
    });
  });

  it("does not delete when the admin cancels the confirmation", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    listReturns([EXISTING_ACCOUNT]);
    render(<GnAccountsSection />);
    await screen.findByText("gn.kaduwela");

    await user.click(screen.getByRole("button", { name: /delete/i }));

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("shows why the list could not be loaded instead of an empty table", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Account store is unavailable." }, 503));

    render(<GnAccountsSection />);

    expect((await screen.findByRole("alert")).textContent).toContain("Account store is unavailable.");
  });
});
