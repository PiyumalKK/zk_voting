#!/usr/bin/env node
// Offline unit tests for block-rlp.mjs — no node, no cluster, no network.
//
//   node lib/block-rlp.test.mjs
// or, from packages/blockchain: `make block-rlp-test`
//
// What this can and cannot prove. It cannot prove the *field order* matches
// go-ethereum's — the only authority on that is a real block, which is why
// cluster-test.mjs re-encodes one and compares hashes before it tampers with
// anything. What it does prove is everything mechanical underneath: minimal
// integer encoding, that fixed-width fields survive untouched, that a missing
// field is reported rather than silently encoded as nothing, and that the
// block wrapper nests the header as a list instead of embedding its bytes.
//
// That distinction matters because those mechanical faults all produce the
// same symptom in the gate — the replica rejecting a block as undecodable —
// which is indistinguishable at a glance from the tamper detection the gate
// is there to observe.

import { toRlp } from "viem";

import { EMPTY_BLOOM, EMPTY_ROOT, encodeEmptyBlock, headerFields, headerHash, quantity } from "./block-rlp.mjs";

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`[PASS] ${name}${detail ? " — " + detail : ""}`);
  } else {
    failures++;
    console.log(`[FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

function equal(name, got, want) {
  check(name, got === want, got === want ? String(got) : `got ${got}, want ${want}`);
}

// A header with every field distinguishable, so a transposition shows up as a
// changed byte string rather than as an equal-looking value in the wrong slot.
const BLOCK = {
  parentHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
  sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
  miner: "0x0000000000000000000000000000000000000000",
  stateRoot: "0x2222222222222222222222222222222222222222222222222222222222222222",
  transactionsRoot: EMPTY_ROOT,
  receiptsRoot: EMPTY_ROOT,
  logsBloom: EMPTY_BLOOM,
  difficulty: "0x0",
  number: "0x2a",
  gasLimit: "0x3938700",
  gasUsed: "0x0",
  timestamp: "0x68abcdef",
  extraData: "0x",
  mixHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  nonce: "0x0000000000000000",
  baseFeePerGas: "0x0",
  withdrawalsRoot: "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
  blobGasUsed: "0x0",
  excessBlobGas: "0x0",
  parentBeaconBlockRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
  requestsHash: "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};

// --- quantity() ------------------------------------------------------------

equal("quantity(0x0) is the empty string (RLP 0x80)", quantity("0x0"), "0x");
equal("quantity(0x00000000) is the empty string", quantity("0x00000000"), "0x");
equal("quantity(0x1) is padded to a whole byte", quantity("0x1"), "0x01");
equal("quantity(0x2a) is unchanged", quantity("0x2a"), "0x2a");
equal("quantity strips leading zero bytes", quantity("0x0000ff01"), "0xff01");
equal("quantity keeps an odd digit count whole", quantity("0x3938700"), "0x03938700");
equal("quantity(0x0100) keeps interior zeros", quantity("0x0100"), "0x0100");

check(
  "RLP of a zero quantity is the canonical 0x80",
  toRlp([quantity("0x0")]) === "0xc180",
  toRlp([quantity("0x0")]),
);
check(
  "RLP of a single small byte is the byte itself",
  toRlp([quantity("0x2a")]) === "0xc12a",
  toRlp([quantity("0x2a")]),
);

// --- headerFields() --------------------------------------------------------

const fields = headerFields(BLOCK);
equal("a header has 21 fields", fields.length, 21);
equal("field 0 is the parent hash", fields[0], BLOCK.parentHash);
equal("field 3 is the state root", fields[3], BLOCK.stateRoot);
equal("the nonce keeps its full 8 bytes", fields[14], "0x0000000000000000");
equal("the mix hash keeps its full 32 bytes", fields[13], BLOCK.mixHash);
equal("the bloom keeps its full 256 bytes", fields[6].length, 2 + 512);
equal("the block number is minimally encoded", fields[8], "0x2a");
equal("a zero base fee is the empty string", fields[15], "0x");

const overridden = headerFields(BLOCK, { stateRoot: "0x" + "ba".repeat(32), number: "0x2b" });
equal("overrides replace the named field", overridden[3], "0x" + "ba".repeat(32));
equal("overrides are minimally encoded too", overridden[8], "0x2b");
equal("overrides leave other fields alone", overridden[0], BLOCK.parentHash);

// A field the node did not report must be an error: encoding it as nothing
// would produce a block whose hash is wrong for a reason nobody could see.
const incomplete = { ...BLOCK };
delete incomplete.requestsHash;
let threw = false;
try {
  headerFields(incomplete);
} catch (err) {
  threw = /requestsHash/.test(err.message);
}
check("a missing header field is reported by name", threw);

// --- hashing and the block wrapper ----------------------------------------

const hash = headerHash(fields);
check("the header hash is 32 bytes", /^0x[0-9a-f]{64}$/.test(hash), hash);

const tampered = headerHash(headerFields(BLOCK, { stateRoot: "0x" + "ba".repeat(32) }));
check("changing the state root changes the hash", tampered !== hash, `${hash.slice(0, 14)} vs ${tampered.slice(0, 14)}`);

// The wrapper must nest the header as a list. Decoding just far enough to
// see the first element's type catches the mistake this module exists to
// prevent: passing already-encoded header bytes, which would be re-encoded
// as an opaque string and rejected by the node as undecodable.
const block = encodeEmptyBlock(fields);
const firstElementTag = firstInnerTag(block);
check(
  "the block's first element is a list, not a byte string",
  firstElementTag >= 0xc0,
  `0x${firstElementTag.toString(16)}`,
);
check(
  "the block encodes exactly three items (header, txs, uncles)",
  countTopLevelItems(block) === 3,
  String(countTopLevelItems(block)),
);
check(
  "the last two items are empty lists",
  block.endsWith("c0c0"),
  block.slice(-8),
);

// The whole point: the bytes a node would hash out of this block are the
// bytes we hashed above.
check(
  "the header inside the block is the header we hashed",
  block.includes(toRlp(fields).slice(2)),
  "nested header matches",
);

// --- a tiny RLP reader, only as much as the assertions above need ----------

function bytes(hex) {
  const out = [];
  for (let i = 2; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** Returns the payload offset and length of the outermost list. */
function listPayload(hex) {
  const b = bytes(hex);
  const tag = b[0];
  if (tag < 0xc0) throw new Error("not a list");
  if (tag <= 0xf7) return { start: 1, length: tag - 0xc0 };
  const lengthOfLength = tag - 0xf7;
  let length = 0;
  for (let i = 1; i <= lengthOfLength; i++) length = length * 256 + b[i];
  return { start: 1 + lengthOfLength, length };
}

/** The tag byte of the first item inside the outermost list. */
function firstInnerTag(hex) {
  const { start } = listPayload(hex);
  return bytes(hex)[start];
}

/** How many items the outermost list holds. */
function countTopLevelItems(hex) {
  const b = bytes(hex);
  const { start, length } = listPayload(hex);
  let offset = start;
  let items = 0;
  const end = start + length;

  while (offset < end) {
    const tag = b[offset];
    let header = 1;
    let payload = 0;
    if (tag < 0x80) {
      payload = 0; // the byte is its own value
    } else if (tag <= 0xb7) {
      payload = tag - 0x80;
    } else if (tag <= 0xbf) {
      const lengthOfLength = tag - 0xb7;
      header = 1 + lengthOfLength;
      payload = 0;
      for (let i = 1; i <= lengthOfLength; i++) payload = payload * 256 + b[offset + i];
    } else if (tag <= 0xf7) {
      payload = tag - 0xc0;
    } else {
      const lengthOfLength = tag - 0xf7;
      header = 1 + lengthOfLength;
      payload = 0;
      for (let i = 1; i <= lengthOfLength; i++) payload = payload * 256 + b[offset + i];
    }
    offset += header + payload;
    items++;
  }
  return items;
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
