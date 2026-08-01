#!/usr/bin/env node
// JSON-shape contract test (MASTER blockchain-v2 M05).
//
// Runs with **no node and no chain**: it hand-builds the exact JSON that
// internal/rpc/convert.go's RPCReceipt / RPCLog / RPCTransaction structs
// marshal to — field names from the struct tags, encodings from
// hexutil/common's MarshalText behaviour — and runs viem's own formatters
// and decoders over it.
//
// Why this exists alongside the differential harness: MASTER §10 pitfall 5
// warns that a missing or mis-encoded receipt field "fails silently in odd
// places". `make diff-write` catches that too, but only when two live nodes
// are running. This runs in a second, in CI, and pinpoints the *encoding*
// rather than the behaviour — so if it and diff-write both fail, this one
// tells you which of the two is the actual cause.
//
// It is a contract test, not a mock: the objects below are transcribed from
// the Go struct definitions. If you change a `json:"…"` tag or a field type
// in convert.go, change it here too — a divergence is exactly the bug this
// file is meant to catch, so it will not detect that automatically.
//
// Usage: `make shape-check` from packages/blockchain, or `node shape-check.mjs`.

import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  formatLog,
  formatTransaction,
  formatTransactionReceipt,
  parseAbi,
} from "viem";

let failures = 0;

function check(name, condition, detail) {
  console.log(`${condition ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  if (!condition) failures++;
}

// Representative values in the encodings Go produces: hexutil quantities are
// "0x"-prefixed with no leading zeros, common.Hash/Address are lowercase and
// fixed-width, types.Bloom is 256 bytes, a nil *common.Address is null, and
// an empty []*RPCLog is [].
const CONTRACT = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const SENDER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const TX_HASH = "0x" + "11".repeat(32);
const BLOCK_HASH = "0x" + "22".repeat(32);
const BLOOM = "0x" + "00".repeat(256);
const TOPIC = "0x" + "33".repeat(32);
const CHAIN_ID_HEX = "0x2516"; // 9494

// --- RPCLog ---------------------------------------------------------------

function rpcLog(logIndex) {
  return {
    address: CONTRACT,
    topics: [TOPIC],
    data: "0x",
    blockNumber: "0x2",
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    transactionIndex: "0x0",
    logIndex: "0x" + logIndex.toString(16),
    removed: false,
  };
}

// --- RPCReceipt -----------------------------------------------------------

const callReceipt = {
  transactionHash: TX_HASH,
  transactionIndex: "0x0",
  blockHash: BLOCK_HASH,
  blockNumber: "0x2",
  from: SENDER,
  to: CONTRACT,
  cumulativeGasUsed: "0xabcd",
  gasUsed: "0xabcd",
  contractAddress: null,
  logs: [rpcLog(0), rpcLog(1)],
  logsBloom: BLOOM,
  status: "0x1",
  type: "0x2",
  effectiveGasPrice: "0x0",
};

const deployReceipt = { ...callReceipt, to: null, contractAddress: CONTRACT, logs: [], type: "0x0" };

// status 0x0 is unreachable on this chain (a reverting tx is never mined —
// MASTER §10 pitfall 2), but the encoding must still round-trip: M10's
// replicas and M09's audit replay both decode receipts written by other
// processes, and nothing should depend on the status being 1.
const revertedReceipt = { ...callReceipt, status: "0x0" };

for (const [name, raw] of [
  ["contract-call receipt", callReceipt],
  ["deploy receipt", deployReceipt],
  ["failed-status receipt", revertedReceipt],
]) {
  let formatted;
  try {
    formatted = formatTransactionReceipt(raw);
  } catch (err) {
    check(`${name}: viem formats it`, false, err.message);
    continue;
  }
  check(`${name}: viem formats it`, true);

  const wantStatus = raw.status === "0x1" ? "success" : "reverted";
  check(`${name}: status -> "${wantStatus}"`, formatted.status === wantStatus, String(formatted.status));
  check(`${name}: blockNumber is a bigint`, typeof formatted.blockNumber === "bigint", typeof formatted.blockNumber);
  check(`${name}: gasUsed is a bigint`, typeof formatted.gasUsed === "bigint", typeof formatted.gasUsed);
  check(`${name}: effectiveGasPrice is 0n`, formatted.effectiveGasPrice === 0n, String(formatted.effectiveGasPrice));
  check(`${name}: transactionIndex is a number`, typeof formatted.transactionIndex === "number");
  check(`${name}: logs is an array`, Array.isArray(formatted.logs), `${formatted.logs?.length} log(s)`);
  check(
    `${name}: contractAddress is ${raw.contractAddress ? "an address" : "null"}`,
    raw.contractAddress ? !!formatted.contractAddress : formatted.contractAddress === null,
    String(formatted.contractAddress),
  );
}

// --- logs must survive formatting *and* ABI event decoding ----------------

const abi = parseAbi(["event ValueSet(address indexed setter, uint256 indexed value, string note)"]);

try {
  const formatted = formatLog(rpcLog(0));
  check(
    "log: viem formats it",
    typeof formatted.logIndex === "number" && typeof formatted.blockNumber === "bigint",
    `logIndex ${typeof formatted.logIndex}, blockNumber ${typeof formatted.blockNumber}`,
  );
} catch (err) {
  check("log: viem formats it", false, err.message);
}

try {
  // A realistically encoded ValueSet log — proves indexed and non-indexed
  // arguments both decode off the exact field names our receipts emit, which
  // is what the audit and results pages depend on from M06 on.
  const realLog = {
    ...rpcLog(0),
    topics: encodeEventTopics({ abi, eventName: "ValueSet", args: { setter: SENDER, value: 42n } }),
    data: encodeAbiParameters([{ type: "string" }], ["set"]),
  };
  const decoded = decodeEventLog({ abi, topics: realLog.topics, data: realLog.data });
  check(
    "log: decodeEventLog off our shape",
    decoded.eventName === "ValueSet" && decoded.args.value === 42n && decoded.args.note === "set",
    `${decoded.eventName}(value=${decoded.args.value}, note=${decoded.args.note})`,
  );
  check("log: viem formats the encoded one", typeof formatLog(realLog).logIndex === "number");
} catch (err) {
  check("log: decodeEventLog off our shape", false, err.message);
}

// --- RPCTransaction, one per tx type this chain accepts -------------------

const baseTx = {
  blockHash: BLOCK_HASH,
  blockNumber: "0x2",
  from: SENDER,
  gas: "0x5208",
  gasPrice: "0x0",
  hash: TX_HASH,
  input: "0x",
  nonce: "0x0",
  to: CONTRACT,
  transactionIndex: "0x0",
  value: "0x7",
  type: "0x0",
  v: "0x4a4d",
  r: "0x1",
  s: "0x2",
};

const transactions = {
  // MASTER §10 pitfall 3: mobile sends legacy and it must never break;
  // hardhat-deploy's ethers v6 may send 1559.
  legacy: { ...baseTx, type: "0x0", chainId: CHAIN_ID_HEX },
  "eip-2930": { ...baseTx, type: "0x1", chainId: CHAIN_ID_HEX, accessList: [] },
  "eip-1559": {
    ...baseTx,
    type: "0x2",
    chainId: CHAIN_ID_HEX,
    accessList: [],
    maxFeePerGas: "0x0",
    maxPriorityFeePerGas: "0x0",
  },
};

const wantViemType = { legacy: "legacy", "eip-2930": "eip2930", "eip-1559": "eip1559" };

for (const [name, raw] of Object.entries(transactions)) {
  try {
    const formatted = formatTransaction(raw);
    check(`tx ${name}: viem formats it`, true);
    check(`tx ${name}: type -> ${wantViemType[name]}`, formatted.type === wantViemType[name], String(formatted.type));
    check(`tx ${name}: value is a bigint`, typeof formatted.value === "bigint", typeof formatted.value);
  } catch (err) {
    check(`tx ${name}: viem formats it`, false, err.message);
  }
}

console.log(`\n${failures === 0 ? "ALL SHAPE CHECKS PASSED" : `${failures} SHAPE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
