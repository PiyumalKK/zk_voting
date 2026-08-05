import { ElectionIdentity } from "./ElectionIdentity";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The header control that replaces the connect button in custom-chain mode.
 *
 * Its job is small but load-bearing: an operator must always be able to see who
 * they are signed in as, and to stop being that person. A stale identity left
 * in the header after a session expires is how someone keeps clicking actions
 * that silently 401.
 */

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  signOut: vi.fn().mockResolvedValue(undefined),
  auth: { session: null as unknown, isLoading: false },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("~~/hooks/useElectionAuth", () => ({
  useElectionAuth: () => ({ ...mocks.auth, signOut: mocks.signOut }),
}));

beforeEach(() => {
  mocks.push.mockClear();
  mocks.signOut.mockClear();
  mocks.auth = { session: null, isLoading: false };
});

afterEach(() => vi.unstubAllEnvs());

describe("ElectionIdentity", () => {
  it("offers a sign-in link when nobody is signed in", () => {
    render(<ElectionIdentity />);

    expect(screen.getByRole("link", { name: /sign in/i }).getAttribute("href")).toBe("/login");
  });

  it("shows a spinner rather than 'signed out' while the session is still loading", () => {
    mocks.auth = { session: null, isLoading: true };

    render(<ElectionIdentity />);

    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
    expect(screen.getByLabelText(/checking sign-in status/i)).toBeDefined();
  });

  it("names the signed-in admin and their role", () => {
    mocks.auth = { session: { username: "returning-officer", role: "admin", loggedInAt: 1 }, isLoading: false };

    render(<ElectionIdentity />);

    expect(screen.getByText("returning-officer")).toBeDefined();
    expect(screen.getByText(/Election Authority/)).toBeDefined();
  });

  it("shows a GN officer which division they are scoped to", () => {
    mocks.auth = {
      session: { username: "gn.kaduwela", role: "gn", divisionId: 2, loggedInAt: 1 },
      isLoading: false,
    };

    render(<ElectionIdentity />);

    expect(screen.getByText(/GN Officer · Division 2/)).toBeDefined();
  });

  it("signs out and then sends the operator to the login page", async () => {
    mocks.auth = { session: { username: "returning-officer", role: "admin", loggedInAt: 1 }, isLoading: false };
    const user = userEvent.setup();

    render(<ElectionIdentity />);
    await user.click(screen.getByRole("button", { name: /sign out/i }));

    await waitFor(() => expect(mocks.signOut).toHaveBeenCalled());
    expect(mocks.push).toHaveBeenCalledWith("/login");
  });
});
