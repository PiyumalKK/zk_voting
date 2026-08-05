import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

/**
 * `tryFundBurner` is the M13 finding, so it gets the tests.
 *
 * Before M13 both `register.tsx` and `vote.tsx` treated a faucet top-up as a
 * precondition: `vote.tsx` rewrote any failure into "Could not fund the
 * anonymous wallet", and `register.tsx` let it propagate. On the custom chain
 * gas costs nothing, so an unfunded burner is not merely tolerable — voting
 * from one is the property the milestone exists to demonstrate. A faucet that
 * is down, disabled for this chain id, or absent entirely must not be able to
 * stop a vote.
 */

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.tryFundBurner", () => {
  const address = "0x000000000000000000000000000000000000dEaD";

  it("reports true when the faucet funds the address", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { funded: true, txHash: "0xabc" })),
    );

    await expect(api.tryFundBurner(address)).resolves.toBe(true);
  });

  it("posts the address to the faucet route", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, { funded: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.tryFundBurner(address);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/faucet$/);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ address });
  });

  it("resolves false instead of throwing when the faucet is disabled for the chain", async () => {
    // What `FAUCET_CHAIN_IDS` not covering 9494 looks like from here.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(400, { error: "Faucet disabled for chain 9494" })),
    );

    await expect(api.tryFundBurner(address)).resolves.toBe(false);
  });

  it("resolves false when the API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Network request failed");
      }),
    );

    await expect(api.tryFundBurner(address)).resolves.toBe(false);
  });

  it("resolves false when the faucet answers 200 but declines to fund", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { funded: false, error: "out of funds" })),
    );

    await expect(api.tryFundBurner(address)).resolves.toBe(false);
  });

  it("resolves false on a malformed body rather than propagating a parse error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
      ),
    );

    await expect(api.tryFundBurner(address)).resolves.toBe(false);
  });
});

describe("api.fundBurner", () => {
  it("still throws, so a caller that needs the failure can see it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(400, { error: "Faucet disabled for chain 9494" })),
    );

    await expect(api.fundBurner("0x1")).rejects.toThrow("Faucet disabled for chain 9494");
  });
});
