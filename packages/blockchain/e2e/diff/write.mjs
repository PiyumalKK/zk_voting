#!/usr/bin/env node
// Differential write-path harness (MASTER blockchain-v2 M05).
//
// Companion to diff.mjs (M04, read methods). This script drives the *write*
// half of MASTER §9's compatibility matrix through viem against both our Go
// node (OUR_URL) and a live `hardhat node` (HARDHAT_URL), and diffs what
// comes back. It deploys the same compiled contract (contracts/Probe.sol,
// artifact committed as contracts/Probe.json) on both, so every comparison
// is made on identical bytecode.
//
// Usage:
//   HARDHAT_URL=http://127.0.0.1:8545 node write.mjs
// or, from packages/blockchain: `make diff-write HARDHAT_URL=http://127.0.0.1:8545`
//
// BOTH NODES MUST BE FRESHLY STARTED (genesis-only). Several checks depend
// on account #0's nonce being 0 on both chains, which makes Probe deploy to
// the *same* address on both — that in turn is what lets `to`, each log's
// `address`, and `logsBloom` be diffed for exact equality rather than merely
// for shape. Run `make reset` before `make run`, and restart `yarn chain`.
//
// Checks (M05 spec "Differential" list a-f):
//   a) deploy Probe on both
//   b) successful write -> receipt field-by-field diff
//   c) revert via custom error -> viem decodes the same error name on both
//   d) revert on eth_call and on estimateGas
//   e) nonce-too-low replay -> compare error substrings
//   f) waitForTransactionReceipt completes on both

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));

const OUR_URL = process.env.OUR_URL ?? "http://127.0.0.1:9545";
const HARDHAT_URL = process.env.HARDHAT_URL;

if (!HARDHAT_URL) {
  console.error("HARDHAT_URL is required, e.g.:\n  HARDHAT_URL=http://127.0.0.1:8545 node write.mjs");
  process.exit(2);
}

// Same genesis-prefunded Hardhat test account #0 diff.mjs uses. Not a secret.
const ACCOUNT_0_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(ACCOUNT_0_PRIVATE_KEY);

const probe = JSON.parse(readFileSync(join(here, "contracts", "Probe.json"), "utf8"));

// Explicit gas limits everywhere a transaction is sent. Without them viem
// runs eth_estimateGas first, and for the revert checks that means the
// revert would surface from *estimateGas* — check (c) specifically needs it
// to surface from eth_sendRawTransaction itself (MASTER §10 pitfall 2), so
// estimation has to be skipped. Check (d) tests the estimateGas path
// separately and on purpose.
const DEPLOY_GAS = 1_500_000n;
const CALL_GAS = 300_000n;

// ---------------------------------------------------------------------------
// Reporting

const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail: detail ?? "" });
  console.log(`[${status}] ${name}${detail ? " — " + detail : ""}`);
}

function pass(name, detail) {
  record(name, "PASS", detail);
}
function fail(name, detail) {
  record(name, "FAIL", detail);
}
function info(name, detail) {
  record(name, "INFO", detail);
}

// ---------------------------------------------------------------------------
// Receipt diffing
//
// Fields split into three groups. The split is the whole point of this file:
// a field in the wrong group either hides a real incompatibility or produces
// a permanent false failure.

// Must be byte-identical between the two backends. Safe only because both
// chains are fresh, so the deployer's nonce — and therefore Probe's address
// and every address-derived field — is the same on both.
//
// If only `gasUsed`/`cumulativeGasUsed` mismatch, the two backends are on
// different hardforks rather than behaving differently: Probe.sol is
// compiled for `cancun` and this chain activates Prague from genesis, so
// check the `hardfork` setting of the `hardhat` network in
// packages/hardhat/hardhat.config.ts before treating it as a node bug.
const RECEIPT_EXACT_FIELDS = [
  "from",
  "to",
  "contractAddress",
  "status",
  "type",
  "transactionIndex",
  "blockNumber",
  "logsBloom",
  "cumulativeGasUsed",
  "gasUsed",
];

// Differ by design; reported so a human can eyeball them, never failed on.
//   transactionHash — the chain id is part of the signature (EIP-155).
//   blockHash       — different genesis, different parent chain.
//   effectiveGasPrice — Hardhat charges a real base fee; this chain is
//                     free-gas by design (MASTER §3), so ours is always 0x0.
const RECEIPT_EXPECTED_DIFFERENT_FIELDS = ["transactionHash", "blockHash", "effectiveGasPrice"];

const LOG_EXACT_FIELDS = ["address", "topics", "data", "logIndex", "transactionIndex", "removed"];

/** keySetDiff reports keys present in one object but not the other. */
function keySetDiff(ours, theirs) {
  const problems = [];
  for (const k of Object.keys(ours)) if (!(k in theirs)) problems.push(`our-only key: ${k}`);
  for (const k of Object.keys(theirs)) if (!(k in ours)) problems.push(`hardhat-only key: ${k}`);
  return problems;
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffReceipts(label, ours, theirs) {
  const keyProblems = keySetDiff(ours, theirs);
  if (keyProblems.length > 0) {
    fail(`${label}: receipt key set`, keyProblems.join("; "));
  } else {
    pass(`${label}: receipt key set`, `${Object.keys(ours).length} fields, identical`);
  }

  const mismatches = [];
  for (const field of RECEIPT_EXACT_FIELDS) {
    if (!(field in ours) || !(field in theirs)) continue; // already reported above
    if (!jsonEqual(ours[field], theirs[field])) {
      mismatches.push(`${field}: our=${JSON.stringify(ours[field])} hardhat=${JSON.stringify(theirs[field])}`);
    }
  }
  if (mismatches.length > 0) {
    fail(`${label}: receipt values`, mismatches.join("; "));
  } else {
    pass(`${label}: receipt values`, RECEIPT_EXACT_FIELDS.join(", "));
  }

  const differing = RECEIPT_EXPECTED_DIFFERENT_FIELDS.map(
    (f) => `${f}: our=${JSON.stringify(ours[f])} hardhat=${JSON.stringify(theirs[f])}`,
  );
  info(`${label}: fields expected to differ`, differing.join("; "));

  // Logs.
  const ourLogs = ours.logs ?? [];
  const theirLogs = theirs.logs ?? [];
  if (ourLogs.length !== theirLogs.length) {
    fail(`${label}: log count`, `our=${ourLogs.length} hardhat=${theirLogs.length}`);
    return;
  }
  pass(`${label}: log count`, String(ourLogs.length));

  const logProblems = [];
  for (let i = 0; i < ourLogs.length; i++) {
    logProblems.push(...keySetDiff(ourLogs[i], theirLogs[i]).map((p) => `log[${i}] ${p}`));
    for (const field of LOG_EXACT_FIELDS) {
      if (!jsonEqual(ourLogs[i][field], theirLogs[i][field])) {
        logProblems.push(
          `log[${i}].${field}: our=${JSON.stringify(ourLogs[i][field])} hardhat=${JSON.stringify(theirLogs[i][field])}`,
        );
      }
    }
  }
  if (logProblems.length > 0) {
    fail(`${label}: log shape and values`, logProblems.join("; "));
  } else {
    pass(`${label}: log shape and values`, LOG_EXACT_FIELDS.join(", "));
  }
}

// ---------------------------------------------------------------------------
// Error inspection

/**
 * revertedErrorName walks a viem error chain for the decoded custom-error
 * name. This is the assertion MASTER §10 pitfall 1 exists for: viem decodes
 * custom Solidity errors purely from the JSON-RPC error's `data` field, so if
 * our node's `data` is wrong (or absent), this comes back undefined while
 * Hardhat's does not.
 */
function revertedErrorName(err) {
  if (typeof err?.walk !== "function") return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted?.data?.errorName;
}

function revertedErrorArgs(err) {
  if (typeof err?.walk !== "function") return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted?.data?.args?.map(String);
}

/** rpcErrorMessage extracts the most specific human-readable message viem kept. */
function rpcErrorMessage(err) {
  return err?.details ?? err?.shortMessage ?? err?.message ?? String(err);
}

/** expectThrow runs fn and returns the error it threw, or null if it didn't. */
async function expectThrow(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

// ---------------------------------------------------------------------------

/** backend bundles the two clients plus the deployed Probe address for one node. */
async function setupBackend(name, url) {
  const publicClient = createPublicClient({ transport: http(url) });
  const walletClient = createWalletClient({ account, transport: http(url) });

  const hash = await walletClient.deployContract({
    abi: probe.abi,
    bytecode: probe.bytecode,
    gas: DEPLOY_GAS,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error(`${name}: deploy receipt has no contractAddress`);
  }
  return { name, url, publicClient, walletClient, address: receipt.contractAddress, deployHash: hash };
}

async function main() {
  // --- (a) deploy Probe on both ---
  let ours;
  let theirs;
  try {
    ours = await setupBackend("our node", OUR_URL);
  } catch (err) {
    fail("(a) deploy Probe on our node", rpcErrorMessage(err));
    summarize();
    return;
  }
  pass("(a) deploy Probe on our node", ours.address);

  theirs = await setupBackend("hardhat", HARDHAT_URL);
  pass("(a) deploy Probe on hardhat", theirs.address);

  if (ours.address.toLowerCase() === theirs.address.toLowerCase()) {
    pass("(a) same deploy address on both", "both chains fresh, deployer nonce 0");
  } else {
    fail(
      "(a) same deploy address on both",
      `our=${ours.address} hardhat=${theirs.address} — one of the chains is not fresh; ` +
        "several later checks compare address-derived fields exactly and will report false failures. " +
        "Run `make reset && make run` and restart `yarn chain`.",
    );
  }

  // --- (f) waitForTransactionReceipt completes on both (the deploy already
  // proved it; recorded explicitly because it is its own spec item) ---
  pass("(f) waitForTransactionReceipt completes", "both deploy receipts resolved");

  // --- (b) successful write -> receipt field-by-field diff ---
  // Two shapes: one log, and several logs (sequential logIndex).
  await diffWrite("(b) setValue(42)", ours, theirs, "setValue", [42n]);
  await diffWrite("(b) emitMany(3)", ours, theirs, "emitMany", [3n]);

  // The deploy receipts themselves are worth diffing too: they are the only
  // ones with a non-null contractAddress and a null `to`.
  const ourDeployReceipt = await rawReceipt(ours, ours.deployHash);
  const theirDeployReceipt = await rawReceipt(theirs, theirs.deployHash);
  diffReceipts("(b) deploy", ourDeployReceipt, theirDeployReceipt);

  // --- (c) revert via custom error, from eth_sendRawTransaction itself ---
  await diffCustomErrorOnWrite("(c) custom error with args (setValue over max)", ours, theirs, "setValue", [
    99_999n,
  ], "Probe__ValueTooLarge");
  await diffCustomErrorOnWrite("(c) custom error, no args", ours, theirs, "revertWithCustomError", [], "Probe__NoArgs");

  // --- (d) revert on eth_call and on estimateGas ---
  await diffRevertOnRead("(d) eth_call", ours, theirs, (b) =>
    b.publicClient.readContract({ address: b.address, abi: probe.abi, functionName: "revertWithCustomError" }),
  "Probe__NoArgs");

  await diffRevertOnRead("(d) estimateGas", ours, theirs, (b) =>
    b.publicClient.estimateContractGas({
      account,
      address: b.address,
      abi: probe.abi,
      functionName: "revertWithCustomError",
    }),
  "Probe__NoArgs");

  // A plain `require(false, "...")` decodes into the *message* rather than
  // into a custom error name — the other half of MASTER §10 pitfall 1.
  const ourReasonErr = await expectThrow(() =>
    ours.publicClient.readContract({ address: ours.address, abi: probe.abi, functionName: "revertWithReason" }),
  );
  const theirReasonErr = await expectThrow(() =>
    theirs.publicClient.readContract({ address: theirs.address, abi: probe.abi, functionName: "revertWithReason" }),
  );
  const REASON = "Probe: nope";
  const ourHasReason = rpcErrorMessage(ourReasonErr ?? {}).includes(REASON);
  const theirHasReason = rpcErrorMessage(theirReasonErr ?? {}).includes(REASON);
  record(
    "(d) revert reason string surfaces in the message",
    ourHasReason && theirHasReason ? "PASS" : "FAIL",
    `our=${JSON.stringify(rpcErrorMessage(ourReasonErr ?? {}))} hardhat=${JSON.stringify(rpcErrorMessage(theirReasonErr ?? {}))}`,
  );

  // --- (e) nonce-too-low replay ---
  await diffNonceTooLow("(e) nonce too low", ours, theirs);

  summarize();
}

/** rawReceipt fetches the unformatted JSON-RPC receipt (not viem's parsed one). */
async function rawReceipt(backend, hash) {
  return backend.publicClient.request({ method: "eth_getTransactionReceipt", params: [hash] });
}

async function diffWrite(label, ours, theirs, functionName, args) {
  const send = async (b) => {
    const hash = await b.walletClient.writeContract({
      address: b.address,
      abi: probe.abi,
      functionName,
      args,
      gas: CALL_GAS,
    });
    await b.publicClient.waitForTransactionReceipt({ hash });
    return rawReceipt(b, hash);
  };

  let ourReceipt;
  let theirReceipt;
  try {
    ourReceipt = await send(ours);
    theirReceipt = await send(theirs);
  } catch (err) {
    fail(label, `write failed: ${rpcErrorMessage(err)}`);
    return;
  }
  diffReceipts(label, ourReceipt, theirReceipt);
}

async function diffCustomErrorOnWrite(label, ours, theirs, functionName, args, wantErrorName) {
  const attempt = (b) =>
    expectThrow(() =>
      b.walletClient.writeContract({
        address: b.address,
        abi: probe.abi,
        functionName,
        args,
        // Explicit gas so viem does not estimate first: this check is
        // specifically about the revert coming back from
        // eth_sendRawTransaction (MASTER §10 pitfall 2).
        gas: CALL_GAS,
      }),
    );

  const ourErr = await attempt(ours);
  const theirErr = await attempt(theirs);

  if (!ourErr || !theirErr) {
    fail(label, `expected both to revert; our threw=${!!ourErr} hardhat threw=${!!theirErr}`);
    return;
  }

  const ourName = revertedErrorName(ourErr);
  const theirName = revertedErrorName(theirErr);
  const ok = ourName === wantErrorName && theirName === wantErrorName;
  record(
    label,
    ok ? "PASS" : "FAIL",
    `decoded error name: our=${ourName} hardhat=${theirName} (want ${wantErrorName})`,
  );
  if (ok) {
    const ourArgs = revertedErrorArgs(ourErr);
    const theirArgs = revertedErrorArgs(theirErr);
    record(
      `${label}: decoded args`,
      jsonEqual(ourArgs, theirArgs) ? "PASS" : "FAIL",
      `our=${JSON.stringify(ourArgs)} hardhat=${JSON.stringify(theirArgs)}`,
    );
  }

  // The head must not have moved on our node — a reverting tx is never
  // mined (MASTER §10 pitfall 2). Hardhat behaves the same way; asserted on
  // both so a future Hardhat change would show up here rather than silently
  // making the two backends diverge.
  for (const b of [ours, theirs]) {
    const before = await b.publicClient.getBlockNumber();
    await attempt(b);
    const after = await b.publicClient.getBlockNumber();
    record(
      `${label}: no block mined on ${b.name}`,
      before === after ? "PASS" : "FAIL",
      `block ${before} -> ${after}`,
    );
  }
}

async function diffRevertOnRead(label, ours, theirs, run, wantErrorName) {
  const ourErr = await expectThrow(() => run(ours));
  const theirErr = await expectThrow(() => run(theirs));

  if (!ourErr || !theirErr) {
    fail(label, `expected both to revert; our threw=${!!ourErr} hardhat threw=${!!theirErr}`);
    return;
  }
  const ourName = revertedErrorName(ourErr);
  const theirName = revertedErrorName(theirErr);
  record(
    label,
    ourName === wantErrorName && theirName === wantErrorName ? "PASS" : "FAIL",
    `decoded error name: our=${ourName} hardhat=${theirName} (want ${wantErrorName})`,
  );
}

async function diffNonceTooLow(label, ours, theirs) {
  const replay = async (b) => {
    // Nonce 0 was consumed by the Probe deploy at the top of this run, so
    // re-using it is guaranteed to be too low on both chains.
    return expectThrow(() =>
      b.walletClient.sendTransaction({
        to: account.address,
        value: 0n,
        gas: 21_000n,
        nonce: 0,
      }),
    );
  };

  const ourErr = await replay(ours);
  const theirErr = await replay(theirs);

  if (!ourErr || !theirErr) {
    fail(label, `expected both to reject; our threw=${!!ourErr} hardhat threw=${!!theirErr}`);
    return;
  }

  const ourMsg = rpcErrorMessage(ourErr);
  const theirMsg = rpcErrorMessage(theirErr);

  // Substring parity is what actually matters (MASTER §10 pitfall 1: the
  // clients substring-match), so assert on the phrases rather than on full
  // string equality — Hardhat appends node-version-specific trailers that
  // are not worth chasing.
  const phrases = ["Nonce too low", "Expected nonce to be"];
  const missing = phrases.filter((p) => !ourMsg.includes(p) || !theirMsg.includes(p));
  record(
    label,
    missing.length === 0 ? "PASS" : "FAIL",
    missing.length === 0
      ? `both messages contain: ${phrases.join(", ")}`
      : `missing phrase(s) ${missing.join(", ")} — our=${JSON.stringify(ourMsg)} hardhat=${JSON.stringify(theirMsg)}`,
  );
  info(`${label}: full messages`, `our=${JSON.stringify(ourMsg)} hardhat=${JSON.stringify(theirMsg)}`);
}

function summarize() {
  const counts = (status) => results.filter((r) => r.status === status).length;
  const fails = results.filter((r) => r.status === "FAIL");
  console.log("");
  console.log(
    `${results.length} checks: ${counts("PASS")} passed, ${fails.length} failed, ${counts("SKIP")} skipped, ${counts("INFO")} informational.`,
  );
  if (fails.length > 0) {
    console.log("FAILED checks:");
    for (const f of fails) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("write harness crashed:", err);
  process.exit(1);
});
