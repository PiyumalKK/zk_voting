import { Header } from "./Header";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The header's mode branch.
 *
 * Hardhat mode must still render the RainbowKit connect button and gate the
 * Admin link on wallet ownership — that is the visible half of the "hardhat
 * behaves exactly as before M12" rule. Custom mode must render neither, because
 * there is no wallet to connect and `useIsVotingOwner` can never be true there.
 */

const mocks = vi.hoisted(() => ({
  auth: { isAdmin: false, session: null as unknown, isLoading: false },
  isOwner: false,
}));

vi.mock("~~/hooks/useElectionAuth", () => ({ useElectionAuth: () => mocks.auth }));
vi.mock("~~/hooks/scaffold-eth", () => ({
  useIsVotingOwner: () => mocks.isOwner,
  useOutsideClick: () => {},
}));
vi.mock("~~/components/scaffold-eth", () => ({
  RainbowKitCustomConnectButton: () => <button type="button">Connect Wallet</button>,
}));
vi.mock("~~/components/ElectionIdentity", () => ({
  ElectionIdentity: () => <div data-testid="election-identity" />,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
// A span rather than an <img>: the logo is irrelevant here, and next/core-web-vitals
// warns on raw <img> elements.
vi.mock("next/image", () => ({ default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} /> }));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  mocks.auth = { isAdmin: false, session: null, isLoading: false };
  mocks.isOwner = false;
});

afterEach(() => vi.unstubAllEnvs());

describe("Header — hardhat mode", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "hardhat"));

  it("renders the wallet connect button", () => {
    render(<Header />);

    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeDefined();
    expect(screen.queryByTestId("election-identity")).toBeNull();
  });

  it("shows the Admin link only to the on-chain owner", () => {
    render(<Header />);
    expect(screen.queryAllByRole("link", { name: /admin/i })).toHaveLength(0);

    mocks.isOwner = true;
    render(<Header />);
    expect(screen.queryAllByRole("link", { name: /admin/i }).length).toBeGreaterThan(0);
  });

  it("ignores an admin session — it never has one here", () => {
    mocks.auth = { isAdmin: true, session: null, isLoading: false };

    render(<Header />);

    expect(screen.queryAllByRole("link", { name: /admin/i })).toHaveLength(0);
  });
});

describe("Header — custom mode", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "custom"));

  it("renders the credential identity instead of a connect button", () => {
    render(<Header />);

    expect(screen.getByTestId("election-identity")).toBeDefined();
    expect(screen.queryByRole("button", { name: /connect wallet/i })).toBeNull();
  });

  it("shows the Admin link from the session, since the wallet owner check can never pass", () => {
    mocks.auth = { isAdmin: true, session: { role: "admin" }, isLoading: false };

    render(<Header />);

    expect(screen.queryAllByRole("link", { name: /admin/i }).length).toBeGreaterThan(0);
  });

  it("hides the Admin link from a GN session", () => {
    mocks.auth = { isAdmin: false, session: { role: "gn" }, isLoading: false };
    mocks.isOwner = true; // would have shown it in hardhat mode

    render(<Header />);

    expect(screen.queryAllByRole("link", { name: /admin/i })).toHaveLength(0);
  });
});
