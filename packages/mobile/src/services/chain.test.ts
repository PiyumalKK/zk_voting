import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransactionSerializedLegacy } from "viem";
import { fromRlp, parseTransaction, recoverTransactionAddress, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * The compat-critical surface, tested against a real JSON-RPC wire.
 *
 * `chain.ts` builds, signs and sends a **legacy** transaction entirely by hand,
 * because viem's `writeContract` triggers gas and EIP-1559 fee estimation whose
 * requests are malformed under Hermes. That hand-rolled path is exactly what
 * M13 has to prove still works against the Go node, so these tests exercise it
 * over HTTP against a recording JSON-RPC server rather than by mocking viem.
 * What goes on the wire is the thing under test; a mock of viem would test the
 * mock.
 *
 * The two properties that matter most, and that no unit test of the screens
 * could establish:
 *
 *  1. The request set contains **no** `eth_estimateGas`, `eth_feeHistory` or
 *     `eth_maxPriorityFeePerGas`. Those are the calls that break under Hermes,
 *     and the manual path exists to avoid them.
 *  2. `gasPrice` is taken from the node. The node answers `0x0`, and the app's
 *     1-gwei fallback fires *only* when the RPC call itself fails — not when it
 *     legitimately returns zero. A fallback that triggered on zero would price
 *     every vote at 1 gwei and put the gas problem straight back.
 */

// Derived, not hand-copied: these must track `Voting.sol`'s real signatures,
// which is the point of asserting on them at all.
const REGISTER_SELECTOR = toFunctionSelector("function register(uint256)");
const VOTE_SELECTOR = toFunctionSelector(
  "function vote(bytes,bytes32,bytes32,bytes32,bytes32)",
);

const DIVISION = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const VOTER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const TX_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111";

interface RpcCall {
  method: string;
  params: unknown[];
}

/**
 * The gas price a signed legacy transaction actually carries.
 *
 * A legacy transaction RLP-encodes zero as an *empty* item, and viem's
 * `parseTransaction` omits the key entirely rather than reporting `0n` — so a
 * bare `expect(tx.gasPrice).toBe(0n)` fails on a correctly-priced free-gas
 * transaction. `gasPrice` is a mandatory field of the legacy envelope, so an
 * absent key can only mean zero.
 */
function gasPriceOf(serialized: TransactionSerializedLegacy): bigint {
  return parseTransaction(serialized).gasPrice ?? 0n;
}

/** The raw second RLP item of a legacy transaction — `[nonce, gasPrice, …]`. */
function rawGasPriceItem(serialized: TransactionSerializedLegacy): string {
  return (fromRlp(serialized, "hex") as string[])[1];
}

interface MockNode {
  url: string;
  calls: RpcCall[];
  /** Methods that should answer with a JSON-RPC error instead of a result. */
  failing: Set<string>;
  close: () => Promise<void>;
}

/** A JSON-RPC node that records every call and answers like the Go node does. */
async function startMockNode(chainId: number, overrides: Record<string, unknown> = {}): Promise<MockNode> {
  const calls: RpcCall[] = [];
  const failing = new Set<string>();

  const results: Record<string, unknown> = {
    eth_chainId: `0x${chainId.toString(16)}`,
    eth_blockNumber: "0x2a",
    eth_getTransactionCount: "0x7",
    // The custom chain's free-gas policy, and the reason the fallback must not
    // treat zero as a failure.
    eth_gasPrice: "0x0",
    eth_sendRawTransaction: TX_HASH,
    eth_getTransactionReceipt: {
      transactionHash: TX_HASH,
      transactionIndex: "0x0",
      blockHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
      blockNumber: "0x2a",
      from: "0x0000000000000000000000000000000000000001",
      to: DIVISION,
      cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208",
      contractAddress: null,
      logs: [],
      logsBloom: `0x${"0".repeat(512)}`,
      status: "0x1",
      effectiveGasPrice: "0x0",
      type: "0x0",
    },
    ...overrides,
  };

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const batch = Array.isArray(body) ? body : [body];
      const responses = batch.map(({ id, method, params }) => {
        calls.push({ method, params: params ?? [] });
        if (failing.has(method)) {
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `method ${method} unavailable` } };
        }
        return { jsonrpc: "2.0", id, result: results[method] ?? null };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
    });
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    failing,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

/** Every transaction the node was asked to broadcast, in order. */
function sentTransactions(recorded: MockNode): TransactionSerializedLegacy[] {
  return recorded.calls
    .filter(c => c.method === "eth_sendRawTransaction")
    .map(c => c.params[0] as TransactionSerializedLegacy);
}

/** The single transaction under test, asserting that one was sent at all. */
function sentTransaction(recorded: MockNode): TransactionSerializedLegacy {
  const all = sentTransactions(recorded);
  expect(all.length, "a transaction reached the node").toBeGreaterThan(0);
  return all[all.length - 1];
}

/**
 * `chain.ts` reads CONFIG at module load, so each configuration needs a fresh
 * import — the same thing a rebuilt Expo bundle does.
 */
async function loadChain(rpcUrl: string, chainId: number) {
  process.env.EXPO_PUBLIC_RPC_URL = rpcUrl;
  process.env.EXPO_PUBLIC_CHAIN_ID = String(chainId);
  vi.resetModules();
  return import("./chain");
}

const savedEnv = { ...process.env };
let node: MockNode;

afterEach(async () => {
  process.env = { ...savedEnv };
  await node?.close();
});

describe("submitRegister", () => {
  beforeEach(async () => {
    node = await startMockNode(9494);
  });

  it("signs a legacy transaction for the configured chain at the node's gas price", async () => {
    const { submitRegister } = await loadChain(node.url, 9494);

    const hash = await submitRegister(DIVISION, "12345678901234567890", VOTER_KEY);

    expect(hash).toBe(TX_HASH);

    const serialized = sentTransaction(node);
    const tx = parseTransaction(serialized);
    expect(tx.type).toBe("legacy");
    expect(tx.chainId).toBe(9494);
    expect(gasPriceOf(serialized)).toBe(0n);
    expect(tx.gas).toBe(600_000n);
    expect(tx.nonce).toBe(7);
    expect(tx.to?.toLowerCase()).toBe(DIVISION.toLowerCase());
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.data?.startsWith(REGISTER_SELECTOR)).toBe(true);
  });

  it("signs with the voter's own key, since registration is allowlisted", async () => {
    const { submitRegister } = await loadChain(node.url, 9494);
    await submitRegister(DIVISION, "1", VOTER_KEY);

    const sender = await recoverTransactionAddress({
      serializedTransaction: sentTransaction(node),
    });

    expect(sender).toBe(privateKeyToAccount(VOTER_KEY).address);
  });

  it("makes no gas-estimation or EIP-1559 fee calls", async () => {
    // The Hermes constraint, asserted rather than described in a comment.
    const { submitRegister } = await loadChain(node.url, 9494);
    await submitRegister(DIVISION, "1", VOTER_KEY);

    const methods = node.calls.map(c => c.method);
    expect(methods).not.toContain("eth_estimateGas");
    expect(methods).not.toContain("eth_feeHistory");
    expect(methods).not.toContain("eth_maxPriorityFeePerGas");
    expect(methods).toContain("eth_getTransactionCount");
    expect(methods).toContain("eth_gasPrice");
  });

  it("asks for the nonce at the latest block, which the node maps `pending` onto", async () => {
    const { submitRegister } = await loadChain(node.url, 9494);
    await submitRegister(DIVISION, "1", VOTER_KEY);

    const nonceCall = node.calls.find(c => c.method === "eth_getTransactionCount")!;
    expect(nonceCall.params[0]).toBe(privateKeyToAccount(VOTER_KEY).address);
    expect(nonceCall.params[1]).toBe("latest");
  });

  it("waits for the receipt before resolving", async () => {
    const { submitRegister } = await loadChain(node.url, 9494);
    await submitRegister(DIVISION, "1", VOTER_KEY);

    expect(node.calls.map(c => c.method)).toContain("eth_getTransactionReceipt");
  });

  it("works identically against hardhat's chain id", async () => {
    await node.close();
    node = await startMockNode(31337, { eth_gasPrice: "0x3b9aca00" });
    const { submitRegister } = await loadChain(node.url, 31337);

    await submitRegister(DIVISION, "1", VOTER_KEY);

    const serialized = sentTransaction(node);
    const tx = parseTransaction(serialized);
    expect(tx.chainId).toBe(31337);
    expect(tx.gasPrice).toBe(1_000_000_000n);
  });
});

describe("gas price handling", () => {
  beforeEach(async () => {
    node = await startMockNode(9494);
  });

  it("uses the node's zero price rather than the fallback", async () => {
    // A `||`-style fallback would see 0n as falsy here and quietly substitute
    // 1 gwei, which is the gas problem the custom chain exists to remove.
    const { submitRegister } = await loadChain(node.url, 9494);
    await submitRegister(DIVISION, "1", VOTER_KEY);

    const serialized = sentTransaction(node);
    expect(gasPriceOf(serialized)).toBe(0n);
    // Asserted on the wire bytes too, since the decoded form represents zero by
    // an absent key: the second RLP item must be the empty item, not 1 gwei.
    expect(rawGasPriceItem(serialized)).toBe("0x");
  });

  it("falls back to 1 gwei only when the RPC call itself fails", async () => {
    node.failing.add("eth_gasPrice");
    const { submitRegister } = await loadChain(node.url, 9494);

    await submitRegister(DIVISION, "1", VOTER_KEY);

    const serialized = sentTransaction(node);
    expect(gasPriceOf(serialized)).toBe(1_000_000_000n);
  });
});

describe("submitVote", () => {
  const payload = {
    proof: "0xdeadbeef",
    nullifierHash: `0x${"11".repeat(32)}`,
    root: `0x${"22".repeat(32)}`,
    vote: `0x${"33".repeat(32)}`,
    depth: `0x${"44".repeat(32)}`,
  } as const;

  beforeEach(async () => {
    node = await startMockNode(9494);
  });

  it("sends from a burner at zero gas price with the fixed 15M limit", async () => {
    const { submitVote } = await loadChain(node.url, 9494);

    const hash = await submitVote(DIVISION, payload);

    expect(hash).toBe(TX_HASH);
    const serialized = sentTransaction(node);
    const tx = parseTransaction(serialized);
    expect(tx.type).toBe("legacy");
    expect(gasPriceOf(serialized)).toBe(0n);
    // MASTER §2: the node's block gas limit must stay above this.
    expect(tx.gas).toBe(15_000_000n);
    expect(tx.data?.startsWith(VOTE_SELECTOR)).toBe(true);
  });

  it("never checks the burner's balance, so an unfunded burner is not blocked here", async () => {
    // The gasless proof-point, from the client's side: nothing in this path
    // consults `eth_getBalance`, so whether the faucet ran is invisible to it.
    const { submitVote } = await loadChain(node.url, 9494);
    await submitVote(DIVISION, payload);

    expect(node.calls.map(c => c.method)).not.toContain("eth_getBalance");
  });

  it("uses a different sender on every vote unless one is supplied", async () => {
    // Anonymity comes from the proof, but a reused `msg.sender` would still
    // link two votes together.
    const { submitVote } = await loadChain(node.url, 9494);

    await submitVote(DIVISION, payload);
    await submitVote(DIVISION, payload);

    const senders = await Promise.all(
      sentTransactions(node).map(serializedTransaction =>
        recoverTransactionAddress({ serializedTransaction }),
      ),
    );

    expect(senders).toHaveLength(2);
    expect(senders[0]).not.toBe(senders[1]);
  });

  it("honours an explicitly supplied burner key", async () => {
    const { submitVote, newBurnerAccount } = await loadChain(node.url, 9494);
    const burner = newBurnerAccount();

    await submitVote(DIVISION, payload, burner.privateKey);

    const sender = await recoverTransactionAddress({
      serializedTransaction: sentTransaction(node),
    });
    expect(sender).toBe(burner.address);
  });

  it("surfaces a revert from the node instead of swallowing it", async () => {
    // Double voting: the node rejects at submission (MASTER §10 pitfall 2) and
    // the screens substring-match the custom error name, so the message has to
    // survive the round trip.
    const { submitVote } = await loadChain(node.url, 9494);
    node.failing.add("eth_sendRawTransaction");

    await expect(submitVote(DIVISION, payload)).rejects.toThrow(
      /eth_sendRawTransaction unavailable/,
    );
  });
});

describe("newBurnerAccount", () => {
  beforeEach(async () => {
    node = await startMockNode(9494);
  });

  it("returns a fresh key and its matching address", async () => {
    const { newBurnerAccount } = await loadChain(node.url, 9494);

    const a = newBurnerAccount();
    const b = newBurnerAccount();

    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.address).toBe(privateKeyToAccount(a.privateKey).address);
    expect(a.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
