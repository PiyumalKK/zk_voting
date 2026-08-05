#!/usr/bin/env node
// Differential JSON-RPC harness (MASTER blockchain-v2 M04 deliverable 4).
//
// Runs an identical set of calls against our Go node (OUR_URL) and a live
// `hardhat node` (HARDHAT_URL), normalizes fields that are expected to
// differ by design (chain id, genesis hashes/timestamps, client version
// strings), and diffs everything else. Exit code is non-zero if any
// unexplained difference is found.
//
// Usage:
//   HARDHAT_URL=http://127.0.0.1:8545 node diff.mjs
//   OUR_URL=http://127.0.0.1:9545 HARDHAT_URL=http://127.0.0.1:8545 node diff.mjs
// or, from packages/blockchain: `make diff HARDHAT_URL=http://127.0.0.1:8545`
//
// Assumptions: both nodes are freshly started (genesis-only, no prior
// transactions) — the balance/nonce/code-of-prefunded-account checks
// compare exact values, which only holds before either chain has spent any
// gas. Re-run against fresh nodes if those checks report a mismatch you
// don't understand.
//
// Scope note (read this if a check unexpectedly SKIPs): M04 only builds
// the *read* half of the JSON-RPC surface (MASTER §5). eth_sendRawTransaction
// lands in M05. The "deploy a test contract" / "eth_call" / "revert shape"
// checks below try to submit a transaction to OUR_URL first; if that comes
// back "method not found", they SKIP (not FAIL) and say so — this script
// does not change once M05 lands, those checks just start actually running.

import { createPublicClient, createWalletClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const OUR_URL = process.env.OUR_URL ?? "http://127.0.0.1:9545";
const HARDHAT_URL = process.env.HARDHAT_URL;

if (!HARDHAT_URL) {
  console.error("HARDHAT_URL is required, e.g.:\n  HARDHAT_URL=http://127.0.0.1:8545 node diff.mjs");
  process.exit(2);
}

// Hardhat's well-known default test account #0 (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266),
// genesis-prefunded on both chains: internal/state/genesis.go prefunds the
// same public mnemonic's accounts, and a fresh `hardhat node` does too by
// default. Not a secret.
const ACCOUNT_0_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(ACCOUNT_0_PRIVATE_KEY);

// ---------------------------------------------------------------------------
// Tiny hand-assembled EVM contracts, built the same way (named opcodes,
// length-patched offsets) as internal/chain/testcontracts_test.go and
// internal/rpc/testcontracts_test.go — kept as a third copy here rather
// than hex-literal transcription, so there's no manual hex arithmetic to
// get wrong.

function buildInitCode(runtime) {
  if (runtime.length > 255) throw new Error("buildInitCode: runtime too long for a single PUSH1 length operand");
  const prologue = [
    0x60, runtime.length, // PUSH1 len(runtime)
    0x80, // DUP1
    0x60, 0, // PUSH1 codeOffset (placeholder, patched below)
    0x60, 0x00, // PUSH1 0x00
    0x39, // CODECOPY
    0x60, 0x00, // PUSH1 0x00
    0xf3, // RETURN
  ];
  const codeOffsetIndex = 4;
  prologue[codeOffsetIndex] = prologue.length;
  return new Uint8Array([...prologue, ...runtime]);
}

function revertWithDataRuntime(data) {
  if (data.length > 255) throw new Error("revertWithDataRuntime: data too long for a single PUSH1 length operand");
  const prologue = [
    0x60, data.length, // PUSH1 len(data)
    0x80, // DUP1
    0x60, 0, // PUSH1 codeOffset (placeholder, patched below)
    0x60, 0x00, // PUSH1 0x00
    0x39, // CODECOPY
    0x60, 0x00, // PUSH1 0x00
    0xfd, // REVERT
  ];
  const codeOffsetIndex = 4;
  prologue[codeOffsetIndex] = prologue.length;
  return new Uint8Array([...prologue, ...data]);
}

const RETURN_42_RUNTIME = new Uint8Array([
  0x60, 0x2a, // PUSH1 0x2a
  0x60, 0x00, // PUSH1 0x00
  0x52, // MSTORE
  0x60, 0x20, // PUSH1 0x20
  0x60, 0x00, // PUSH1 0x00
  0xf3, // RETURN
]);

const CUSTOM_REVERT_SELECTOR = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

function toHex(bytes) {
  return "0x" + Buffer.from(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// Small diff/reporting engine.

const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail: detail ?? "" });
  const tag = { PASS: "PASS", FAIL: "FAIL", SKIP: "SKIP", INFO: "INFO" }[status];
  console.log(`[${tag}] ${name}${detail ? " — " + detail : ""}`);
}

async function tryCall(client, method, params) {
  return client.request({ method, params });
}

/** deepEqualJSON compares two JSON-ish values for exact structural equality. */
function deepEqualJSON(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * shapeDiff compares two objects' *key sets* and each shared key's JS type
 * (not value) — used for genesis/block objects whose exact values are
 * expected to differ between two independently-generated chains, but whose
 * shape (which fields exist, hash vs number vs array) must match.
 */
function shapeDiff(a, b) {
  const problems = [];
  const keysA = new Set(Object.keys(a));
  const keysB = new Set(Object.keys(b));
  for (const k of keysA) if (!keysB.has(k)) problems.push(`our-only key: ${k}`);
  for (const k of keysB) if (!keysA.has(k)) problems.push(`hardhat-only key: ${k}`);
  for (const k of keysA) {
    if (!keysB.has(k)) continue;
    const ta = Array.isArray(a[k]) ? "array" : typeof a[k];
    const tb = Array.isArray(b[k]) ? "array" : typeof b[k];
    if (ta !== tb) problems.push(`${k}: type our=${ta} hardhat=${tb}`);
  }
  return problems;
}

// Method-not-found is JSON-RPC code -32601; used to distinguish "not
// implemented yet" (SKIP) from a real bug (FAIL).
function isMethodNotFound(err) {
  return err && (err.code === -32601 || /method.*not (found|exist)/i.test(String(err?.message ?? err)));
}

// ---------------------------------------------------------------------------

async function main() {
  const ourClient = createPublicClient({ transport: http(OUR_URL) });
  const hhClient = createPublicClient({ transport: http(HARDHAT_URL) });

  // --- chainId / net_version / web3_clientVersion: format-only checks ---
  // (MASTER: "chainId differs by design (31337 vs 9494 — normalized)").
  const ourChainId = await tryCall(ourClient, "eth_chainId", []);
  const hhChainId = await tryCall(hhClient, "eth_chainId", []);
  if (/^0x[0-9a-f]+$/.test(ourChainId) && /^0x[0-9a-f]+$/.test(hhChainId)) {
    record("eth_chainId (format only)", "PASS", `our=${ourChainId} hardhat=${hhChainId}`);
  } else {
    record("eth_chainId (format only)", "FAIL", `our=${ourChainId} hardhat=${hhChainId}`);
  }

  const ourNetVersion = await tryCall(ourClient, "net_version", []);
  const hhNetVersion = await tryCall(hhClient, "net_version", []);
  if (/^\d+$/.test(ourNetVersion) && /^\d+$/.test(hhNetVersion)) {
    record("net_version (format only)", "PASS", `our=${ourNetVersion} hardhat=${hhNetVersion}`);
  } else {
    record("net_version (format only)", "FAIL", `our=${ourNetVersion} hardhat=${hhNetVersion}`);
  }

  const ourClientVersion = await tryCall(ourClient, "web3_clientVersion", []);
  record("web3_clientVersion (presence only)", typeof ourClientVersion === "string" && ourClientVersion.length > 0 ? "PASS" : "FAIL", ourClientVersion);

  // --- eth_syncing / net_listening: exact match expected ---
  for (const [method, params] of [["eth_syncing", []], ["net_listening", []]]) {
    const ours = await tryCall(ourClient, method, params);
    const hh = await tryCall(hhClient, method, params);
    record(`${method} (exact)`, deepEqualJSON(ours, hh) ? "PASS" : "FAIL", `our=${JSON.stringify(ours)} hardhat=${JSON.stringify(hh)}`);
  }

  // --- eth_accounts: differs by design, not a bug ---
  // Hardhat Network manages a set of local unlocked signer accounts (a dev
  // convenience) and lists them here; this node never holds private keys
  // at all (MASTER §3 — voter/admin/GN key custody is entirely client-side
  // or in nextjs, see 01-AUTH-DESIGN.md), so it always returns []. Confirmed
  // 2026-07-31 against a real `hardhat node`: it returns its 20 default
  // unlocked accounts here. Checked for shape (must be an array of
  // addresses) rather than equality.
  const ourAccounts = await tryCall(ourClient, "eth_accounts", []);
  const hhAccounts = await tryCall(hhClient, "eth_accounts", []);
  const accountsShapeOK =
    Array.isArray(ourAccounts) && ourAccounts.length === 0 &&
    Array.isArray(hhAccounts) && hhAccounts.every((a) => /^0x[0-9a-f]{40}$/i.test(a));
  record(
    "eth_accounts (shape only, differs by design)",
    accountsShapeOK ? "PASS" : "FAIL",
    `our=${JSON.stringify(ourAccounts)} (expected empty) hardhat=${hhAccounts.length} unlocked account(s)`,
  );

  // --- block 0 shape ---
  const ourBlock0 = await tryCall(ourClient, "eth_getBlockByNumber", ["0x0", false]);
  const hhBlock0 = await tryCall(hhClient, "eth_getBlockByNumber", ["0x0", false]);
  const shapeProblems = shapeDiff(ourBlock0, hhBlock0);
  record("eth_getBlockByNumber(0x0) shape", shapeProblems.length === 0 ? "PASS" : "FAIL", shapeProblems.join("; "));
  record(
    "eth_getBlockByNumber(0x0) transactions empty",
    Array.isArray(ourBlock0.transactions) && ourBlock0.transactions.length === 0 &&
      Array.isArray(hhBlock0.transactions) && hhBlock0.transactions.length === 0
      ? "PASS"
      : "FAIL",
    `our=${JSON.stringify(ourBlock0.transactions)} hardhat=${JSON.stringify(hhBlock0.transactions)}`,
  );

  // --- prefunded account #0: balance/nonce/code, exact match ---
  // Only valid before either chain has spent any gas — run first, before
  // any deploy/send below.
  const addr = getAddress(account.address);
  const ourBalance = await tryCall(ourClient, "eth_getBalance", [addr, "latest"]);
  const hhBalance = await tryCall(hhClient, "eth_getBalance", [addr, "latest"]);
  record("eth_getBalance(account#0) (exact)", ourBalance === hhBalance ? "PASS" : "FAIL", `our=${ourBalance} hardhat=${hhBalance}`);

  const ourNonce = await tryCall(ourClient, "eth_getTransactionCount", [addr, "latest"]);
  const hhNonce = await tryCall(hhClient, "eth_getTransactionCount", [addr, "latest"]);
  record("eth_getTransactionCount(account#0) (exact)", ourNonce === hhNonce ? "PASS" : "FAIL", `our=${ourNonce} hardhat=${hhNonce}`);

  const ourCode = await tryCall(ourClient, "eth_getCode", [addr, "latest"]);
  const hhCode = await tryCall(hhClient, "eth_getCode", [addr, "latest"]);
  record("eth_getCode(account#0, EOA) (exact)", ourCode === hhCode ? "PASS" : "FAIL", `our=${ourCode} hardhat=${hhCode}`);

  // --- eth_feeHistory: field names only (values are 0 on our chain by design) ---
  const ourFeeHistory = await tryCall(ourClient, "eth_feeHistory", ["0x4", "latest", [25, 75]]);
  const hhFeeHistory = await tryCall(hhClient, "eth_feeHistory", ["0x4", "latest", [25, 75]]);
  const feeHistoryShapeProblems = shapeDiff(ourFeeHistory, hhFeeHistory);
  record("eth_feeHistory field names", feeHistoryShapeProblems.length === 0 ? "PASS" : "FAIL", feeHistoryShapeProblems.join("; "));

  // --- write-dependent checks: deploy, eth_call, revert shape ---
  // Try OUR node first; SKIP (not FAIL) if eth_sendRawTransaction isn't
  // implemented yet (M05) rather than reporting a false failure.
  await runWriteDependentChecks(ourClient, hhClient);

  // --- summary ---
  const fails = results.filter((r) => r.status === "FAIL");
  console.log("");
  console.log(`${results.length} checks: ${results.filter((r) => r.status === "PASS").length} passed, ${fails.length} failed, ${results.filter((r) => r.status === "SKIP").length} skipped.`);
  if (fails.length > 0) {
    console.log("FAILED checks:");
    for (const f of fails) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
}

async function runWriteDependentChecks(ourClient, hhClient) {
  const ourWallet = createWalletClient({ account, transport: http(OUR_URL) });
  const hhWallet = createWalletClient({ account, transport: http(HARDHAT_URL) });

  let ourDeployedAddr;
  try {
    const hash = await ourWallet.sendTransaction({ data: toHex(buildInitCode(RETURN_42_RUNTIME)) });
    const receipt = await ourClient.waitForTransactionReceipt({ hash });
    ourDeployedAddr = receipt.contractAddress;
  } catch (err) {
    if (isMethodNotFound(err)) {
      record("eth_call to a deployed contract", "SKIP", "our node has no eth_sendRawTransaction yet (M05)");
      record("revert error shape", "SKIP", "our node has no eth_sendRawTransaction yet (M05)");
      return;
    }
    record("eth_call to a deployed contract", "FAIL", `deploy to our node errored: ${err}`);
    return;
  }

  const hhHash = await hhWallet.sendTransaction({ data: toHex(buildInitCode(RETURN_42_RUNTIME)) });
  const hhReceipt = await hhClient.waitForTransactionReceipt({ hash: hhHash });
  const hhDeployedAddr = hhReceipt.contractAddress;

  const ourCallResult = await tryCall(ourClient, "eth_call", [{ to: ourDeployedAddr }, "latest"]);
  const hhCallResult = await tryCall(hhClient, "eth_call", [{ to: hhDeployedAddr }, "latest"]);
  record("eth_call to a deployed contract (exact)", ourCallResult === hhCallResult ? "PASS" : "FAIL", `our=${ourCallResult} hardhat=${hhCallResult}`);

  // --- revert shape: identical contract on both, compare code + data ---
  // (wallet.sendTransaction fills in the nonce itself via
  // eth_getTransactionCount, so no manual nonce bookkeeping is needed here.)
  const ourRevertAddr = await deployAndGetAddress(ourWallet, ourClient, revertWithDataRuntime(CUSTOM_REVERT_SELECTOR));
  const hhRevertAddr = await deployAndGetAddress(hhWallet, hhClient, revertWithDataRuntime(CUSTOM_REVERT_SELECTOR));

  const ourRevertErr = await callExpectingRevert(ourClient, ourRevertAddr);
  const hhRevertErr = await callExpectingRevert(hhClient, hhRevertAddr);

  if (!ourRevertErr || !hhRevertErr) {
    record("revert error shape", "FAIL", `expected both calls to revert; our=${!!ourRevertErr} hardhat=${!!hhRevertErr}`);
    return;
  }
  const codeMatch = ourRevertErr.code === 3 && hhRevertErr.code === 3;
  const dataMatch = ourRevertErr.data === hhRevertErr.data;
  record(
    "revert error shape (code=3, data exact)",
    codeMatch && dataMatch ? "PASS" : "FAIL",
    `our={code:${ourRevertErr.code},data:${ourRevertErr.data}} hardhat={code:${hhRevertErr.code},data:${hhRevertErr.data}}`,
  );
  record(
    "revert error message (informational)",
    "INFO",
    `our=${JSON.stringify(ourRevertErr.message)} hardhat=${JSON.stringify(hhRevertErr.message)}`,
  );
}

async function deployAndGetAddress(wallet, client, runtime) {
  const hash = await wallet.sendTransaction({ data: toHex(buildInitCode(runtime)) });
  const receipt = await client.waitForTransactionReceipt({ hash });
  return receipt.contractAddress;
}

async function callExpectingRevert(client, to) {
  try {
    await tryCall(client, "eth_call", [{ to }, "latest"]);
    return null; // did not revert
  } catch (err) {
    return { code: err.code, data: err.data, message: err.shortMessage ?? err.message };
  }
}

main().catch((err) => {
  console.error("diff harness crashed:", err);
  process.exit(1);
});
