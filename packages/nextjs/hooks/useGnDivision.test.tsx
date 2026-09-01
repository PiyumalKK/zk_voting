import { useGnDivision } from "./useGnDivision";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Which division am I the GN for?" answered from two different kinds of
 * evidence.
 *
 * The failure this guards against is subtle: if the custom path fell back to
 * the wallet lookup, a signed-in officer with no wallet would be told they are
 * not a GN — and if the hardhat path consulted the session, an officer would be
 * scoped by a cookie that mode never issues.
 */

const KADUWELA_GN = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const COLOMBO_GN = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const DIVISIONS = [
  {
    id: 0,
    name: "Kaduwela",
    votingContract: "0x0000000000000000000000000000000000000aa1",
    gnOfficers: [KADUWELA_GN],
    active: true,
    phase: 1,
    treeSize: 3,
    root: 0n,
  },
  {
    id: 1,
    name: "Colombo",
    votingContract: "0x0000000000000000000000000000000000000aa2",
    gnOfficers: [COLOMBO_GN],
    active: true,
    phase: 0,
    treeSize: 0,
    root: 0n,
  },
];

const mocks = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, isConnected: false },
  auth: { session: null as unknown, isLoading: false },
  divisions: { divisions: [] as unknown[], isLoading: false, error: null as string | null, refetch: vi.fn() },
}));

vi.mock("wagmi", () => ({ useAccount: () => mocks.account }));
vi.mock("~~/hooks/useElectionAuth", () => ({ useElectionAuth: () => mocks.auth }));
// Mocked wholesale: the real module pulls in the wagmi/scaffold read stack,
// which this hook's logic does not need. The pure lookups it uses live in
// `utils/gnDivision` and run for real.
vi.mock("~~/hooks/useDivisions", () => ({ useDivisions: () => mocks.divisions }));

beforeEach(() => {
  mocks.account = { address: undefined, isConnected: false };
  mocks.auth = { session: null, isLoading: false };
  mocks.divisions = { divisions: DIVISIONS, isLoading: false, error: null, refetch: vi.fn() };
});

afterEach(() => vi.unstubAllEnvs());

describe("useGnDivision — hardhat mode", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "hardhat"));

  it("resolves the division from the connected wallet", () => {
    mocks.account = { address: KADUWELA_GN, isConnected: true };

    const { result } = renderHook(() => useGnDivision());

    expect(result.current.division?.name).toBe("Kaduwela");
    expect(result.current.identity).toBe(KADUWELA_GN);
  });

  it("matches the on-chain officer case-insensitively", () => {
    mocks.account = { address: KADUWELA_GN.toLowerCase(), isConnected: true };

    const { result } = renderHook(() => useGnDivision());

    expect(result.current.division?.name).toBe("Kaduwela");
  });

  it("asks for a wallet, not a sign-in, when disconnected", () => {
    const { result } = renderHook(() => useGnDivision());

    expect(result.current.needsSignIn).toBe(true);
    expect(result.current.mode).toBe("hardhat");
  });

  it("reports no division for a connected wallet that is nobody's GN", () => {
    mocks.account = { address: "0x000000000000000000000000000000000000dEaD", isConnected: true };

    const { result } = renderHook(() => useGnDivision());

    expect(result.current.division).toBeNull();
    expect(result.current.needsSignIn).toBe(false);
  });

  it("ignores a session entirely — hardhat mode never issues one", () => {
    mocks.auth = { session: { username: "gn.colombo", role: "gn", divisionId: 1, loggedInAt: 1 }, isLoading: false };
    mocks.account = { address: KADUWELA_GN, isConnected: true };

    const { result } = renderHook(() => useGnDivision());

    expect(result.current.division?.name).toBe("Kaduwela");
  });
});

describe("useGnDivision — custom mode", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CHAIN_BACKEND", "custom"));

  it("resolves the division from the session, with no wallet connected", () => {
    mocks.auth = { session: { username: "gn.colombo", role: "gn", divisionId: 1, loggedInAt: 1 }, isLoading: false };

    const { result } = renderHook(() => useGnDivision());

    expect(result.current.division?.name).toBe("Colombo");
    expect(result.current.identity).toBe("gn.colombo");
    expect(result.current.needsSignIn).toBe(false);
  });

  it("sends an unauthenticated visitor to sign in", () => {
    const { result } = renderHook(() => useGnDivision());

    expect(result.current.needsSignIn).toBe(true);
    expect(result.current.division).toBeNull();
  });

  it("does not treat an admin session as a GN", () => {
    mocks.auth = { session: { username: "returning-officer", role: "admin", loggedInAt: 1 }, isLoading: false };

    const { result } = renderHook(() => useGnDivision());

    expect(result.current.division).toBeNull();
    expect(result.current.needsSignIn).toBe(true);
  });

  it("waits for the session before claiming the visitor is unauthenticated", () => {
    mocks.auth = { session: null, isLoading: true };

    const { result } = renderHook(() => useGnDivision());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.needsSignIn).toBe(false);
  });

  it("reports no division when the session points at one that no longer exists", () => {
    mocks.auth = { session: { username: "gn.ghost", role: "gn", divisionId: 9, loggedInAt: 1 }, isLoading: false };

    const { result } = renderHook(() => useGnDivision());

    expect(result.current.division).toBeNull();
    expect(result.current.needsSignIn).toBe(false);
  });

  it("ignores a connected wallet — the session is the only identity here", () => {
    mocks.account = { address: KADUWELA_GN, isConnected: true };
    mocks.auth = { session: { username: "gn.colombo", role: "gn", divisionId: 1, loggedInAt: 1 }, isLoading: false };

    const { result } = renderHook(() => useGnDivision());

    expect(result.current.division?.name).toBe("Colombo");
  });

  it("passes a chain read failure through untouched", () => {
    mocks.divisions = {
      divisions: [],
      isLoading: false,
      error: "Could not read the ElectionRegistry.",
      refetch: vi.fn(),
    };
    mocks.auth = { session: { username: "gn.colombo", role: "gn", divisionId: 1, loggedInAt: 1 }, isLoading: false };

    const { result } = renderHook(() => useGnDivision());

    expect(result.current.error).toContain("ElectionRegistry");
  });
});
