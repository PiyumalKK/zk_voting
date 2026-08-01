#!/usr/bin/env node
// Differential eth_getLogs harness (MASTER blockchain-v2 M06).
//
// Third harness in the e2e/diff family, after diff.mjs (M04 reads) and
// write.mjs (M05 writes). It builds an *identical* event sequence on our Go
// node (OUR_URL) and on a live `hardhat node` (HARDHAT_URL) using the same
// compiled contract (contracts/Probe.sol, artifact committed as
// contracts/Probe.json), then issues the same eth_getLogs queries against
// both and diffs the raw JSON-RPC responses field by field.
//
// Usage:
//   HARDHAT_URL=http://127.0.0.1:8545 node logs.mjs
// or, from packages/blockchain: `make diff-logs HARDHAT_URL=http://127.0.0.1:8545`
//
// BOTH NODES MUST BE FRESHLY STARTED (genesis-only), for the same reason
// write.mjs says so: account #0's nonce must be 0 on both, which makes Probe
// deploy to the same address on both, which is what lets each log's
// `address` and the address-derived indexed topic be compared for exact
// equality rather than merely for shape. `make reset` before `make run`, and
// restart `yarn chain`.
//
// Checks:
//   (a) identical event sequence built on both
//   (b) unfiltered full-range query — count, ordering and field-by-field diff
//   (c) address filter (single and array form)
//   (d) topic0 filter (event signature)
//   (e) topic1 filter (indexed address argument)
//   (f) topic2 OR-list (indexed uint argument)
//   (g) wildcard middle position: [sig, null, value]
//   (h) block range subsets, and the app's real "fromBlock: 0, no toBlock" shape
//   (i) blockHash mode
//   (j) empty result is a JSON array, not null
//   (k) viem parseEventLogs decodes identically on both
//   (l) the app's three real query patterns, by shape
//   (m) behavioral notes reported for a human (from > to; blockHash + range)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  encodeEventTopics,
  http,
  numberToHex,
  pad,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));

const OUR_URL = process.env.OUR_URL ?? "http://127.0.0.1:9545";
const HARDHAT_URL = process.env.HARDHAT_URL;

if (!HARDHAT_URL) {
  console.error("HARDHAT_URL is required, e.g.:\n  HARDHAT_URL=http://127.0.0.1:8545 node logs.mjs");
  process.exit(2);
}

// Same genesis-prefunded Hardhat test account #0 the other harnesses use. Not a secret.
const ACCOUNT_0_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(ACCOUNT_0_PRIVATE_KEY);

const probe = JSON.parse(readFileSync(join(here, "contracts", "Probe.json"), "utf8"));

// Explicit gas limits: viem would otherwise call eth_estimateGas first,
// which adds nothing here and couples this harness to M04's estimate path.
const DEPLOY_GAS = 1_500_000n;
const CALL_GAS = 500_000n;

// ---------------------------------------------------------------------------
// Reporting

const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail: detail ?? "" });
  console.log(`[${status}] ${name}${detail ? " — " + detail : ""}`);
}

const pass = (name, detail) => record(name, "PASS", detail);
const fail = (name, detail) => record(name, "FAIL", detail);
const info = (name, detail) => record(name, "INFO", detail);

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Log diffing
//
// Same three-way field split write.mjs uses, and for the same reason: a
// field in the wrong group either hides a real incompatibility or produces a
// permanent false failure.

// Byte-identical between backends. Safe only because both chains are fresh:
// same deployer nonce -> same Probe address -> same `address` field and same
// address-derived indexed topic. blockNumber is here (not in the
// expected-to-differ group) because both nodes auto-mine exactly one
// transaction per block, so the same tx sequence lands at the same heights.
const LOG_EXACT_FIELDS = [
  "address",
  "topics",
  "data",
  "logIndex",
  "transactionIndex",
  "blockNumber",
  "removed",
];

// Differ by design, reported so a human can eyeball them, never failed on:
//   transactionHash — the chain id is part of the signature (EIP-155), and
//                     the two chains have different ids by design (9494 vs 31337).
//   blockHash       — different genesis, therefore a different parent chain.
const LOG_EXPECTED_DIFFERENT_FIELDS = ["transactionHash", "blockHash"];

function keySetDiff(ours, theirs) {
  const problems = [];
  for (const k of Object.keys(ours)) if (!(k in theirs)) problems.push(`our-only key: ${k}`);
  for (const k of Object.keys(theirs)) if (!(k in ours)) problems.push(`hardhat-only key: ${k}`);
  return problems;
}

/**
 * diffLogArrays compares two raw eth_getLogs responses. Returns true when
 * they match, so callers can skip dependent assertions on a failure.
 */
function diffLogArrays(label, ourLogs, theirLogs) {
  if (!Array.isArray(ourLogs) || !Array.isArray(theirLogs)) {
    fail(`${label}: result type`, `our=${typeof ourLogs} hardhat=${typeof theirLogs} (both must be arrays)`);
    return false;
  }
  if (ourLogs.length !== theirLogs.length) {
    fail(`${label}: log count`, `our=${ourLogs.length} hardhat=${theirLogs.length}`);
    return false;
  }

  const problems = [];
  for (let i = 0; i < ourLogs.length; i++) {
    problems.push(...keySetDiff(ourLogs[i], theirLogs[i]).map((p) => `log[${i}] ${p}`));
    for (const field of LOG_EXACT_FIELDS) {
      if (!jsonEqual(ourLogs[i][field], theirLogs[i][field])) {
        problems.push(
          `log[${i}].${field}: our=${JSON.stringify(ourLogs[i][field])} hardhat=${JSON.stringify(theirLogs[i][field])}`,
        );
      }
    }
  }

  if (problems.length > 0) {
    fail(`${label}: log fields`, problems.join("; "));
    return false;
  }
  pass(`${label}: ${ourLogs.length} logs, fields identical`, LOG_EXACT_FIELDS.join(", "));
  return true;
}

/** ascendingOrderProblems checks the (blockNumber, logIndex) ordering the spec requires. */
function ascendingOrderProblems(logs) {
  const problems = [];
  for (let i = 1; i < logs.length; i++) {
    const prevBlock = BigInt(logs[i - 1].blockNumber);
    const block = BigInt(logs[i].blockNumber);
    if (block < prevBlock) {
      problems.push(`log[${i}] block ${block} < log[${i - 1}] block ${prevBlock}`);
      continue;
    }
    if (block === prevBlock && BigInt(logs[i].logIndex) <= BigInt(logs[i - 1].logIndex)) {
      problems.push(`log[${i}] logIndex ${logs[i].logIndex} <= log[${i - 1}] logIndex ${logs[i - 1].logIndex}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Backends

async function setupBackend(name, url) {
  const publicClient = createPublicClient({ transport: http(url) });
  const walletClient = createWalletClient({ account, transport: http(url) });

  const deployHash = await walletClient.deployContract({
    abi: probe.abi,
    bytecode: probe.bytecode,
    gas: DEPLOY_GAS,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (!receipt.contractAddress) {
    throw new Error(`${name}: deploy receipt has no contractAddress`);
  }

  return { name, url, publicClient, walletClient, address: receipt.contractAddress };
}

/**
 * buildEventSequence writes the identical transaction sequence on a backend
 * and returns the block numbers each produced. Auto-mine on both nodes means
 * one transaction per block, so this also fixes the block layout:
 *
 *   block 1  deploy Probe            0 logs
 *   block 2  setValue(1)             1 log
 *   block 3  setValue(2)             1 log
 *   block 4  emitMany(3)             3 logs   <- multiple logs in one block
 *   block 5  setValue(3)             1 log
 *
 * Six logs in total, with one block carrying three of them so per-block
 * logIndex sequencing is actually exercised rather than assumed.
 */
async function buildEventSequence(backend) {
  const write = async (functionName, args) => {
    const hash = await backend.walletClient.writeContract({
      address: backend.address,
      abi: probe.abi,
      functionName,
      args,
      gas: CALL_GAS,
    });
    const receipt = await backend.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${backend.name}: ${functionName}(${args}) reverted`);
    }
    return receipt.blockNumber;
  };

  const blocks = {};
  blocks.setValue1 = await write("setValue", [1n]);
  blocks.setValue2 = await write("setValue", [2n]);
  blocks.emitMany = await write("emitMany", [3n]);
  blocks.setValue3 = await write("setValue", [3n]);
  return blocks;
}

/** getLogsRaw issues eth_getLogs with an explicit filter object. */
async function getLogsRaw(backend, filter) {
  return backend.publicClient.request({ method: "eth_getLogs", params: [filter] });
}

/** bothRaw runs the same raw filter on both backends. */
async function bothRaw(ours, theirs, filter) {
  const [a, b] = await Promise.all([getLogsRaw(ours, filter), getLogsRaw(theirs, filter)]);
  return [a, b];
}

// ---------------------------------------------------------------------------

async function main() {
  // --- (a) identical event sequence on both ---
  let ours;
  let theirs;
  try {
    ours = await setupBackend("our node", OUR_URL);
  } catch (err) {
    fail("(a) deploy Probe on our node", err?.details ?? err?.shortMessage ?? String(err));
    return summarize();
  }
  theirs = await setupBackend("hardhat", HARDHAT_URL);

  if (ours.address.toLowerCase() !== theirs.address.toLowerCase()) {
    fail(
      "(a) Probe deployed to the same address on both",
      `our=${ours.address} hardhat=${theirs.address} — one of the chains was not freshly reset, ` +
        "so every address-derived comparison below would be meaningless",
    );
    return summarize();
  }
  pass("(a) Probe deployed to the same address on both", ours.address);

  const ourBlocks = await buildEventSequence(ours);
  const theirBlocks = await buildEventSequence(theirs);
  if (!jsonEqual(ourBlocks, theirBlocks)) {
    fail(
      "(a) identical block layout",
      `our=${JSON.stringify(ourBlocks, bigintReplacer)} hardhat=${JSON.stringify(theirBlocks, bigintReplacer)}`,
    );
    return summarize();
  }
  pass("(a) identical event sequence and block layout", JSON.stringify(ourBlocks, bigintReplacer));

  const blocks = ourBlocks;
  const fullRange = { fromBlock: "0x0", toBlock: "latest" };

  // Topics of the ValueSet(address indexed setter, uint256 indexed value, string note) event.
  const [valueSetSig] = encodeEventTopics({ abi: probe.abi, eventName: "ValueSet" });
  const setterTopic = pad(account.address.toLowerCase());
  const topicOfValue = (n) => pad(numberToHex(n), { size: 32 });

  // --- (b) unfiltered full-range query ---
  {
    const [a, b] = await bothRaw(ours, theirs, fullRange);
    if (diffLogArrays("(b) full range, no filter", a, b)) {
      if (a.length !== 6) {
        fail("(b) expected log count", `got ${a.length}, want 6 (1 + 1 + 3 + 1)`);
      } else {
        pass("(b) expected log count", "6");
      }
      const problems = ascendingOrderProblems(a);
      if (problems.length > 0) {
        fail("(b) ascending (blockNumber, logIndex) order", problems.join("; "));
      } else {
        pass("(b) ascending (blockNumber, logIndex) order");
      }
      // The emitMany block must carry logIndex 0,1,2 — the per-block counter.
      const many = a.filter((l) => BigInt(l.blockNumber) === blocks.emitMany).map((l) => BigInt(l.logIndex));
      if (!jsonEqual(many.map(String), ["0", "1", "2"])) {
        fail("(b) logIndex is block-scoped", `emitMany block logIndexes = ${many.map(String).join(",")}, want 0,1,2`);
      } else {
        pass("(b) logIndex is block-scoped", "0,1,2 within the emitMany block");
      }
    }
  }

  // --- (c) address filter ---
  {
    const [a, b] = await bothRaw(ours, theirs, { ...fullRange, address: ours.address });
    diffLogArrays("(c) address as a string", a, b);

    const [c, d] = await bothRaw(ours, theirs, { ...fullRange, address: [ours.address] });
    diffLogArrays("(c) address as a one-element array", c, d);

    const unrelated = "0x00000000000000000000000000000000deadbeef";
    const [e, f] = await bothRaw(ours, theirs, { ...fullRange, address: [ours.address, unrelated] });
    diffLogArrays("(c) address as a two-element array (one unrelated)", e, f);

    if (a.length !== e.length) {
      fail("(c) adding an unrelated address changes nothing", `single=${a.length} array=${e.length}`);
    } else {
      pass("(c) adding an unrelated address changes nothing", `${a.length} logs either way`);
    }
  }

  // --- (d) topic0 ---
  {
    const [a, b] = await bothRaw(ours, theirs, { ...fullRange, topics: [valueSetSig] });
    diffLogArrays("(d) topic0 = ValueSet signature", a, b);
  }

  // --- (e) topic1: the indexed address argument ---
  {
    const [a, b] = await bothRaw(ours, theirs, { ...fullRange, topics: [valueSetSig, setterTopic] });
    if (diffLogArrays("(e) topic1 = indexed setter address", a, b) && a.length !== 6) {
      fail("(e) every event has the same setter", `got ${a.length}, want 6`);
    }

    const otherSetter = pad("0x00000000000000000000000000000000deadbeef");
    const [c, d] = await bothRaw(ours, theirs, { ...fullRange, topics: [valueSetSig, otherSetter] });
    if (diffLogArrays("(e) topic1 = a setter that never emitted", c, d) && c.length !== 0) {
      fail("(e) unmatched topic1 returns nothing", `got ${c.length}, want 0`);
    }
  }

  // --- (f) topic2 OR-list: indexed uint argument ---
  {
    const orList = [topicOfValue(1), topicOfValue(2)];
    const [a, b] = await bothRaw(ours, theirs, { ...fullRange, topics: [valueSetSig, null, orList] });
    diffLogArrays("(f) topic2 OR-list [1, 2]", a, b);

    const [c, d] = await bothRaw(ours, theirs, { ...fullRange, topics: [valueSetSig, null, [topicOfValue(2)]] });
    diffLogArrays("(f) topic2 single-element array", c, d);

    if (a.length <= c.length) {
      fail("(f) an OR-list matches at least as much as one element", `or=${a.length} single=${c.length}`);
    } else {
      pass("(f) an OR-list matches strictly more here", `or=${a.length} single=${c.length}`);
    }
  }

  // --- (g) wildcard middle position ---
  {
    const [a, b] = await bothRaw(ours, theirs, { ...fullRange, topics: [valueSetSig, null, topicOfValue(2)] });
    diffLogArrays("(g) [sig, null, value] wildcard middle", a, b);

    // A constraint on a fourth position can never match a three-topic log.
    const [c, d] = await bothRaw(ours, theirs, { ...fullRange, topics: [null, null, null, valueSetSig] });
    if (diffLogArrays("(g) constraining a fourth topic position", c, d) && c.length !== 0) {
      fail("(g) fourth position never matches", `got ${c.length}, want 0`);
    }
  }

  // --- (h) block ranges ---
  {
    const hex = (n) => numberToHex(n);
    const cases = [
      ["single block (emitMany)", { fromBlock: hex(blocks.emitMany), toBlock: hex(blocks.emitMany) }],
      ["first two logging blocks", { fromBlock: hex(blocks.setValue1), toBlock: hex(blocks.setValue2) }],
      ["from the emitMany block onward", { fromBlock: hex(blocks.emitMany), toBlock: "latest" }],
      ["earliest..latest tags", { fromBlock: "earliest", toBlock: "latest" }],
      // The exact shape /api/merkle-path uses: fromBlock only, toBlock
      // omitted entirely. It must default to latest, not to "the same block
      // as fromBlock" — otherwise the route silently sees one block's events.
      ["fromBlock only, toBlock omitted (merkle-path shape)", { fromBlock: "0x0" }],
      ["pending resolves to latest", { fromBlock: "0x0", toBlock: "pending" }],
    ];
    for (const [name, filter] of cases) {
      const [a, b] = await bothRaw(ours, theirs, filter);
      diffLogArrays(`(h) range: ${name}`, a, b);
    }
  }

  // --- (i) blockHash mode ---
  {
    const ourBlock = await ours.publicClient.request({
      method: "eth_getBlockByNumber",
      params: [numberToHex(blocks.emitMany), false],
    });
    const theirBlock = await theirs.publicClient.request({
      method: "eth_getBlockByNumber",
      params: [numberToHex(blocks.emitMany), false],
    });

    // The two chains' block hashes differ by design, so each side is queried
    // with its own hash and the *results* are compared.
    const [a, b] = await Promise.all([
      getLogsRaw(ours, { blockHash: ourBlock.hash }),
      getLogsRaw(theirs, { blockHash: theirBlock.hash }),
    ]);
    diffLogArrays("(i) blockHash mode (emitMany block)", a, b);
    if (Array.isArray(a) && a.length !== 3) {
      fail("(i) blockHash returns exactly that block's logs", `got ${a.length}, want 3`);
    }

    // blockHash must still honour the topic filter.
    const [c, d] = await Promise.all([
      getLogsRaw(ours, { blockHash: ourBlock.hash, topics: [valueSetSig, null, topicOfValue(1)] }),
      getLogsRaw(theirs, { blockHash: theirBlock.hash, topics: [valueSetSig, null, topicOfValue(1)] }),
    ]);
    diffLogArrays("(i) blockHash mode with a topic filter", c, d);
  }

  // --- (j) empty result is [] and not null ---
  {
    const filter = { ...fullRange, address: "0x00000000000000000000000000000000deadbeef" };
    const [a, b] = await bothRaw(ours, theirs, filter);
    const shape = (v) => (v === null ? "null" : Array.isArray(v) ? `array(${v.length})` : typeof v);
    if (!Array.isArray(a) || a.length !== 0) {
      fail("(j) empty result is an empty array on our node", shape(a));
    } else {
      pass("(j) empty result is an empty array on our node");
    }
    if (shape(a) !== shape(b)) {
      fail("(j) empty-result shape matches hardhat", `our=${shape(a)} hardhat=${shape(b)}`);
    } else {
      pass("(j) empty-result shape matches hardhat", shape(a));
    }
  }

  // --- (k) viem parseEventLogs parity ---
  {
    const decode = async (backend) => {
      const logs = await backend.publicClient.getLogs({ address: backend.address, fromBlock: 0n });
      return parseEventLogs({ abi: probe.abi, logs }).map((l) => ({
        eventName: l.eventName,
        args: {
          setter: l.args.setter?.toLowerCase(),
          value: l.args.value?.toString(),
          note: l.args.note,
        },
      }));
    };
    const [a, b] = await Promise.all([decode(ours), decode(theirs)]);
    if (!jsonEqual(a, b)) {
      fail("(k) parseEventLogs output", `our=${JSON.stringify(a)} hardhat=${JSON.stringify(b)}`);
    } else if (a.length === 0) {
      fail("(k) parseEventLogs output", "decoded 0 events on both — the query returned nothing to decode");
    } else {
      pass("(k) parseEventLogs output identical", `${a.length} events decoded on both`);
    }
  }

  // --- (l) the app's real query patterns, by shape ---
  //
  // The production queries target Voting/ElectionRegistry events (NewLeaf,
  // VoteCast, DivisionCreated). Those contracts are exercised end-to-end by
  // e2e/smoke-deploy.mjs and by M14's suite; what matters *here* is the
  // JSON-RPC filter shape viem generates for each, which is contract-
  // independent. Probe.ValueSet stands in for each one: it has an indexed
  // address and an indexed uint, which between them cover every filter shape
  // the three real queries produce.
  {
    const patterns = [
      [
        "merkle-path: getLogs({address, event, fromBlock: 0n})",
        (backend) =>
          backend.publicClient.getLogs({
            address: backend.address,
            event: probe.abi.find((e) => e.type === "event" && e.name === "ValueSet"),
            fromBlock: 0n,
          }),
      ],
      [
        "verify-vote: getLogs({event, args}) filtering on an indexed argument",
        (backend) =>
          backend.publicClient.getLogs({
            address: backend.address,
            event: probe.abi.find((e) => e.type === "event" && e.name === "ValueSet"),
            args: { value: 2n },
            fromBlock: 0n,
          }),
      ],
      [
        "useDivisions/audit: getLogs({event}) with no address, whole chain",
        (backend) =>
          backend.publicClient.getLogs({
            event: probe.abi.find((e) => e.type === "event" && e.name === "ValueSet"),
            fromBlock: 0n,
            toBlock: "latest",
          }),
      ],
    ];

    for (const [name, run] of patterns) {
      const [a, b] = await Promise.all([run(ours), run(theirs)]);
      const normalize = (logs) =>
        logs.map((l) => ({
          address: l.address.toLowerCase(),
          topics: l.topics,
          data: l.data,
          blockNumber: l.blockNumber?.toString(),
          logIndex: l.logIndex,
          eventName: l.eventName,
          args: l.args && Object.fromEntries(Object.entries(l.args).map(([k, v]) => [k, String(v).toLowerCase()])),
        }));
      if (!jsonEqual(normalize(a), normalize(b))) {
        fail(`(l) ${name}`, `our=${JSON.stringify(normalize(a))} hardhat=${JSON.stringify(normalize(b))}`);
      } else if (a.length === 0) {
        fail(`(l) ${name}`, "returned 0 logs on both — the pattern is not actually being exercised");
      } else {
        pass(`(l) ${name}`, `${a.length} logs, identical`);
      }
    }
  }

  // --- (n) the one genuinely ambiguous filter rule, measured not assumed ---
  //
  // A filter with MORE topic positions than the log has topics, where the
  // surplus positions are wildcards. Two defensible readings (see
  // internal/chain/logs_test.go's long note): go-ethereum rejects on length
  // before consulting any rule, so a trailing wildcard still rejects; the
  // alternative skips wildcards first and only rejects on a real constraint
  // past the end. internal/chain/logs.go implements go-ethereum's reading.
  //
  // This is a hard PASS/FAIL rather than an INFO: nothing in the app produces
  // the shape today, but a silent divergence from Hardhat on filter semantics
  // is exactly the class of bug this whole harness exists to catch.
  {
    // ValueSet logs carry 3 topics (signature + 2 indexed args), so a
    // 4-position filter is one past the end.
    const overPadded = { ...fullRange, topics: [valueSetSig, null, null, null] };
    const [a, b] = await bothRaw(ours, theirs, overPadded);

    const ourCount = Array.isArray(a) ? a.length : `non-array(${JSON.stringify(a)})`;
    const theirCount = Array.isArray(b) ? b.length : `non-array(${JSON.stringify(b)})`;

    if (ourCount !== theirCount) {
      fail(
        "(n) over-padded topic filter agrees with hardhat",
        `our=${ourCount} hardhat=${theirCount} — hardhat disagrees with the rule ` +
          "internal/chain/logs.go's matchLog implements. Flip the length guard to skip " +
          "wildcards before bounds-checking, and invert the corresponding case in " +
          "internal/chain/logs_test.go.",
      );
    } else {
      pass(
        "(n) over-padded topic filter agrees with hardhat",
        `both returned ${ourCount} logs (0 = go-ethereum's length-first rule confirmed)`,
      );
    }

    // Control: padding to *exactly* the log's topic count must match. This is
    // the shape /api/verify-vote really sends, so a regression here breaks
    // vote verification.
    const exactlyPadded = { ...fullRange, topics: [valueSetSig, null, null] };
    const [c, d] = await bothRaw(ours, theirs, exactlyPadded);
    if (diffLogArrays("(n) control: padding to the exact topic count", c, d)) {
      if (!Array.isArray(c) || c.length === 0) {
        fail("(n) control returns logs", `got ${c?.length}, want > 0 — this is the verify-vote shape`);
      } else {
        pass("(n) control returns logs", `${c.length} logs`);
      }
    }
  }

  // --- (m) behavioral notes ---
  //
  // Reported, not failed on. These are the two places where the spec leaves
  // room and internal/chain/logs.go made an explicit choice; if hardhat
  // disagrees, the choice is worth revisiting — but neither shape is produced
  // by any consumer in MASTER §2's table, so neither blocks the gate.
  {
    const describe = async (backend, filter) => {
      try {
        const r = await getLogsRaw(backend, filter);
        return Array.isArray(r) ? `array(${r.length})` : JSON.stringify(r);
      } catch (err) {
        return `error: ${err?.details ?? err?.shortMessage ?? String(err)}`;
      }
    };

    const head = await ours.publicClient.getBlockNumber();
    const reversed = { fromBlock: numberToHex(head), toBlock: "0x1" };
    info(
      "(m) fromBlock > toBlock",
      `our=${await describe(ours, reversed)} hardhat=${await describe(theirs, reversed)} ` +
        "(ours returns the empty range rather than erroring — see logs.go)",
    );

    const conflict = { blockHash: "0x" + "11".repeat(32), fromBlock: "0x0" };
    info(
      "(m) blockHash together with fromBlock",
      `our=${await describe(ours, conflict)} hardhat=${await describe(theirs, conflict)}`,
    );

    const unknownHash = { blockHash: "0x" + "22".repeat(32) };
    info(
      "(m) unknown blockHash",
      `our=${await describe(ours, unknownHash)} hardhat=${await describe(theirs, unknownHash)}`,
    );
  }

  summarize();
}

function bigintReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function summarize() {
  const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  console.log(
    `\n${results.length} checks: ` +
      Object.entries(counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(", "),
  );

  const failures = results.filter((r) => r.status === "FAIL");
  if (failures.length > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
    console.log("\nFAIL");
    process.exit(1);
  }
  console.log("\nPASS");
}

main().catch((err) => {
  console.error("\nharness crashed:", err);
  process.exit(1);
});
