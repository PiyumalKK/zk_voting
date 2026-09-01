import GNDashboard from "./page";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The GN portal, rendered for real in both modes.
 *
 * `useGnDivision` is unit-tested separately; what this file checks is that the
 * page *uses* it correctly — that the wallet prompt and the sign-in prompt each
 * appear in the right mode, that the "not a GN" screen names the right kind of
 * identity, and that nothing in the refactor left a dangling reference to the
 * wallet address the page used to read from `useAccount`.
 */

const DIVISION = {
  id: 0,
  name: "Kaduwela",
  votingContract: "0x0000000000000000000000000000000000000aa1",
  gnOfficers: ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8"],
  active: true,
  phase: 1,
  treeSize: 3,
  root: 0n,
};

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
  getLogs: vi.fn(),
  readContract: vi.fn(),
}));

vi.mock("~~/hooks/useGnDivision", () => ({ useGnDivision: () => mocks.gn }));
vi.mock("~~/hooks/scaffold-eth/useTargetNetwork", () => ({
  useTargetNetwork: () => ({
    targetNetwork: { id: 9494, name: "ZK Election Chain", rpcUrls: { default: { http: ["http://127.0.0.1:9545"] } } },
  }),
}));
// Mocked wholesale rather than with `importOriginal`: loading the real viem
// here costs seconds and this page only uses these three entry points.
vi.mock("viem", () => ({
  http: () => ({}),
  parseAbiItem: (signature: string) => ({ signature }),
  createPublicClient: () => ({ getLogs: mocks.getLogs, readContract: mocks.readContract }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  mocks.gn = {
    mode: "hardhat",
    division: null,
    divisions: [],
    isLoading: false,
    error: null,
    identity: null,
    needsSignIn: false,
    refetch: vi.fn(),
  };
  mocks.getLogs.mockReset().mockResolvedValue([]);
  mocks.readContract.mockReset().mockResolvedValue([true, false]);
});

afterEach(() => vi.unstubAllEnvs());

describe("GN portal — identity prompts", () => {
  it("asks for a wallet in hardhat mode", () => {
    mocks.gn = { ...mocks.gn, mode: "hardhat", needsSignIn: true };

    render(<GNDashboard />);

    expect(screen.getByText(/connect your wallet/i)).toBeDefined();
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
  });

  it("offers a credential sign-in link in custom mode", () => {
    mocks.gn = { ...mocks.gn, mode: "custom", needsSignIn: true };

    render(<GNDashboard />);

    expect(screen.getByRole("link", { name: /sign in/i }).getAttribute("href")).toBe("/login?next=%2Fgn");
    expect(screen.queryByText(/connect your wallet/i)).toBeNull();
  });

  it("names the account, not an address, when a custom-mode officer has no division", () => {
    mocks.gn = { ...mocks.gn, mode: "custom", identity: "gn.ghost", division: null, divisions: [DIVISION] };

    render(<GNDashboard />);

    expect(screen.getByText(/not scoped to a registered division/i)).toBeDefined();
    expect(screen.getByText("gn.ghost")).toBeDefined();
  });

  it("names the wallet address when a hardhat officer has no division", () => {
    mocks.gn = {
      ...mocks.gn,
      mode: "hardhat",
      identity: DIVISION.gnOfficers[0],
      division: null,
      divisions: [DIVISION],
    };

    render(<GNDashboard />);

    expect(screen.getByText(/not assigned as GN for any division/i)).toBeDefined();
    expect(screen.getByText(DIVISION.gnOfficers[0])).toBeDefined();
  });
});

describe("GN portal — the dashboard itself", () => {
  it("renders the division it was given, in custom mode with no wallet", async () => {
    mocks.gn = { ...mocks.gn, mode: "custom", identity: "gn.kaduwela", division: DIVISION, divisions: [DIVISION] };

    render(<GNDashboard />);

    expect(screen.getByText(/Kaduwela Division/)).toBeDefined();
    expect(screen.getByText(/authorized GN officer/i)).toBeDefined();
    await waitFor(() => expect(mocks.getLogs).toHaveBeenCalled());
  });

  it("surfaces a chain read failure instead of an empty dashboard", () => {
    mocks.gn = { ...mocks.gn, error: "Could not read the ElectionRegistry." };

    render(<GNDashboard />);

    expect(screen.getByText(/cannot reach the election chain/i)).toBeDefined();
  });

  it("shows a loading state while authorization is still resolving", () => {
    mocks.gn = { ...mocks.gn, isLoading: true };

    render(<GNDashboard />);

    expect(screen.getByText(/checking your GN authorization/i)).toBeDefined();
  });
});
