import LoginPage from "./page";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The login page (M12 build-order item 2).
 *
 * Three things here are worth a test rather than a click-through: that hardhat
 * mode never shows a credential form, that the server's message is what the
 * operator sees on failure (the server is deliberately vague about *which*
 * half of the credentials was wrong), and that a hostile `?next=` cannot
 * redirect an admin off-site the instant they finish typing a password.
 */

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
  search: "",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock("~~/hooks/useElectionAuth", () => ({
  useElectionAuth: () => ({ refresh: mocks.refresh }),
}));

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;

const signIn = async (username = "returning-officer", password = "correct horse") => {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/username/i), username);
  await user.type(screen.getByLabelText(/password/i), password);
  await user.click(screen.getByRole("button", { name: /sign in/i }));
};

beforeEach(() => {
  mocks.replace.mockClear();
  mocks.refresh.mockClear();
  mocks.search = "";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("login page — hardhat mode", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "hardhat"));

  it("explains that this deployment signs in with a wallet", () => {
    render(<LoginPage />);

    expect(screen.getByText(/authenticate with a wallet/i)).toBeDefined();
  });

  it("shows no credential form at all", () => {
    render(<LoginPage />);

    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();
  });
});

describe("login page — custom mode", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "custom"));

  it("posts the credentials and sends an admin to the admin panel", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ username: "returning-officer", role: "admin" }));
    render(<LoginPage />);

    await signIn();

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/voting/admin"));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/login");
    expect(JSON.parse(init.body)).toEqual({ username: "returning-officer", password: "correct horse" });
    expect(init.credentials).toBe("same-origin");
  });

  it("sends a GN officer to the GN portal, not the admin panel", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ username: "gn.kaduwela", role: "gn", divisionId: 0 }));
    render(<LoginPage />);

    await signIn("gn.kaduwela", "pw");

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/gn"));
  });

  it("refreshes the cached session before navigating, so the header is already correct", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ role: "admin" }));
    render(<LoginPage />);

    await signIn();

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("returns the operator to the page the middleware bounced them from", async () => {
    mocks.search = "next=%2Fgn%2Fregister%3Fdivision%3D1";
    fetchMock.mockResolvedValue(jsonResponse({ role: "gn" }));
    render(<LoginPage />);

    await signIn("gn.kaduwela", "pw");

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/gn/register?division=1"));
  });

  it("ignores an off-site redirect target", async () => {
    mocks.search = "next=https%3A%2F%2Fevil.example%2Fharvest";
    fetchMock.mockResolvedValue(jsonResponse({ role: "admin" }));
    render(<LoginPage />);

    await signIn();

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/voting/admin"));
  });

  it("shows the server's single credential-failure message without embellishing it", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Incorrect username or password." }, 401));
    render(<LoginPage />);

    await signIn();

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Incorrect username or password.");
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("clears the password field after a rejected attempt", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Incorrect username or password." }, 401));
    render(<LoginPage />);

    await signIn();

    await waitFor(() => expect((screen.getByLabelText(/password/i) as HTMLInputElement).value).toBe(""));
  });

  it("surfaces the lockout message so the operator knows to wait, not to retry", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Account locked for 15 minutes after repeated failures." }, 429));
    render(<LoginPage />);

    await signIn();

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Account locked for 15 minutes after repeated failures.",
    );
  });

  it("names SESSION_SECRET when the middleware redirected here with a config error", () => {
    mocks.search = "error=config";
    render(<LoginPage />);

    expect(screen.getByRole("status").textContent).toContain("SESSION_SECRET");
  });

  it("explains an unreachable server rather than showing a raw fetch failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<LoginPage />);

    await signIn();

    expect((await screen.findByRole("alert")).textContent).toMatch(/could not reach/i);
  });

  it("keeps the submit button disabled until both fields are filled", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);
    const submit = screen.getByRole("button", { name: /sign in/i }) as HTMLButtonElement;

    expect(submit.disabled).toBe(true);
    await user.type(screen.getByLabelText(/username/i), "returning-officer");
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByLabelText(/password/i), "pw");
    expect(submit.disabled).toBe(false);
  });
});
