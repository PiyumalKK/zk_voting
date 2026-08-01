// Canonical block encoding, in JavaScript (M10).
//
// The cluster gate's tamper scenario has to put a block on the wire that the
// Go node will decode — the same RLP go-ethereum produces, byte for byte,
// because the block hash is defined over exactly those bytes. That is the
// only reason this file exists; nothing in the running system encodes blocks
// in JavaScript.
//
// It is a separate module rather than three functions inside the gate script
// so that it can be exercised on its own (block-rlp.test.mjs) without
// starting a cluster: the failure mode this guards against is a wrong field
// order producing a block the replica rejects as *undecodable*, which in the
// tamper scenario would look exactly like the tamper detection being tested.

import { keccak256, toRlp } from "viem";

/**
 * Header field order is go-ethereum's types.Header. Every optional trailing
 * field is present because this chain activates Shanghai through Prague from
 * block 0 (internal/state.ChainConfig), and internal/chain/seal.go's
 * buildHeader sets all of them on every block it seals.
 *
 * The names are eth_getBlockByNumber's JSON keys, so a header can be rebuilt
 * straight from what the node reports.
 */
export const HEADER_FIELDS = [
  { json: "parentHash", quantity: false },
  { json: "sha3Uncles", quantity: false },
  { json: "miner", quantity: false },
  { json: "stateRoot", quantity: false },
  { json: "transactionsRoot", quantity: false },
  { json: "receiptsRoot", quantity: false },
  { json: "logsBloom", quantity: false },
  { json: "difficulty", quantity: true },
  { json: "number", quantity: true },
  { json: "gasLimit", quantity: true },
  { json: "gasUsed", quantity: true },
  { json: "timestamp", quantity: true },
  { json: "extraData", quantity: false },
  { json: "mixHash", quantity: false },
  { json: "nonce", quantity: false },
  { json: "baseFeePerGas", quantity: true },
  { json: "withdrawalsRoot", quantity: false },
  { json: "blobGasUsed", quantity: true },
  { json: "excessBlobGas", quantity: true },
  { json: "parentBeaconBlockRoot", quantity: false },
  { json: "requestsHash", quantity: false },
];

/** keccak256 of the empty RLP string — the empty transaction/receipt root. */
export const EMPTY_ROOT = "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421";

/** A 256-byte zero bloom, as an empty block carries. */
export const EMPTY_BLOOM = `0x${"00".repeat(256)}`;

/**
 * Normalises a JSON-RPC quantity to its minimal big-endian byte string:
 * leading zero bytes removed, zero encoded as the empty string (RLP 0x80),
 * and an odd number of hex digits padded so the result is whole bytes.
 *
 * Fixed-width fields (hashes, the address, the bloom, the 8-byte nonce) must
 * NOT go through this — trimming them would change their length and with it
 * the block hash.
 */
export function quantity(hex) {
  const trimmed = String(hex).replace(/^0x/, "").replace(/^0+/, "");
  if (trimmed.length === 0) return "0x";
  return `0x${trimmed.length % 2 === 1 ? "0" : ""}${trimmed}`;
}

/**
 * Rebuilds a header's field list from eth_getBlockByNumber's output, with
 * optional overrides applied by JSON field name.
 *
 * Returns the fields as an array, not as encoded RLP: the header has to be
 * *nested* inside the block's list, and encoding it first would encode it
 * again as an opaque byte string.
 */
export function headerFields(block, overrides = {}) {
  return HEADER_FIELDS.map(({ json, quantity: isQuantity }) => {
    const value = json in overrides ? overrides[json] : block[json];
    if (value === undefined || value === null) {
      throw new Error(`block is missing header field ${json}; this node cannot be encoded`);
    }
    return isQuantity ? quantity(value) : value;
  });
}

/** The block hash: keccak256 of the header's RLP. */
export function headerHash(fields) {
  return keccak256(toRlp(fields));
}

/**
 * [header, transactions, uncles] — the canonical encoding of a block with no
 * transactions. Withdrawals are the trailing optional field and are omitted,
 * which is what go-ethereum emits for a block that has none.
 */
export function encodeEmptyBlock(fields) {
  return toRlp([fields, [], []]);
}
