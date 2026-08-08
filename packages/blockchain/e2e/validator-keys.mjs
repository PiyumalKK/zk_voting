#!/usr/bin/env node
// Generate and verify the four validator consensus signing keys.
//
//   node validator-keys.mjs generate    # new key set -> ../validator-keys.txt
//   node validator-keys.mjs verify      # keys still match gen_inventory.py?
//
// A validator consensus key is a secp256k1 private key, but it is NOT an
// account: it holds no funds, sends no transactions, and never appears
// on-chain. Its only job is to sign this validator's PREPARE and COMMIT votes.
// Holding one is what it means to be one of the four parties; three of the
// four is control of block finality. See ../CONSENSUS.md.
//
// The split matters:
//
//   private key   secret. Lives in a GitHub repository secret, and on the host
//                 in data_3001/keys/validator.key mode 0600. Never in git.
//   address       public. Every node needs every other node's in order to
//                 check signatures, so it is committed in
//                 infra/scripts/gen_inventory.py.
//
// `verify` exists because a mismatch between the two is the single most
// annoying way to break a deployment: the node refuses to boot with
// "the consensus signing key derives to 0xA…, but VALIDATOR_SET lists
// authority as 0xB…". That check is deliberately loud — a validator signing
// with an unlisted identity is otherwise invisible, its messages verifying as
// coming from a stranger and being dropped, leaving the cluster one vote short
// with nothing in any log to explain why. Catching it here costs a second.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const BLOCKCHAIN = join(here, "..");
const REPO = join(BLOCKCHAIN, "..", "..");

const KEY_FILE = join(BLOCKCHAIN, "validator-keys.txt");
const INVENTORY = join(REPO, "infra", "scripts", "gen_inventory.py");

// Fixed and protocol-significant: the proposer for a height is
// validators[(height + round) % N], so every node must be given the same
// members in the same order or they disagree about whose turn it is at every
// height and the cluster never makes progress.
const VALIDATORS = [
  { node: "node1", name: "authority" },
  { node: "node2", name: "jvp" },
  { node: "node3", name: "unp" },
  { node: "node4", name: "sjb" },
];

/** The addresses currently committed in gen_inventory.py. */
function committedAddresses() {
  const py = readFileSync(INVENTORY, "utf8");
  const block = py.split("DEFAULT_VALIDATOR_ADDRESSES = [")[1]?.split("]")[0];
  if (!block) throw new Error(`could not find DEFAULT_VALIDATOR_ADDRESSES in ${INVENTORY}`);
  return [...block.matchAll(/"(0x[0-9a-fA-F]{40})"/g)].map((m) => m[1]);
}

/** The keys in the generated local file. */
function localKeys() {
  const txt = readFileSync(KEY_FILE, "utf8");
  return [...txt.matchAll(/SECRET VALUE:\r?\n([0-9a-f]{64})/g)].map((m) => m[1]);
}

function generate() {
  const rows = VALIDATORS.map(({ node, name }) => {
    const pk = generatePrivateKey();
    return { node, name, key: pk.slice(2), address: privateKeyToAccount(pk).address };
  });

  const lines = [
    "ZK VOTING — VALIDATOR CONSENSUS SIGNING KEYS",
    `Generated ${new Date().toISOString()}`,
    "",
    "These are NOT accounts. They hold no funds and send no transactions.",
    "Each one signs its validator's PREPARE/COMMIT votes. Holding one is what",
    "it means to be one of the four parties; three of the four is control of",
    "block finality.",
    "",
    "Paste each SECRET VALUE into the matching GitHub repository secret:",
    "  Settings → Secrets and variables → Actions → New repository secret",
    "",
    "This file is gitignored. Delete it once the secrets are set.",
    "",
    "=".repeat(72),
    "",
  ];

  for (const r of rows) {
    lines.push(
      `SECRET NAME : VALIDATOR_KEY_${r.node.toUpperCase()}`,
      `validator   : ${r.name}  (${r.node})`,
      `address     : ${r.address}   ← public`,
      "SECRET VALUE:",
      r.key,
      "",
    );
  }

  lines.push(
    "=".repeat(72),
    "",
    "Addresses, for DEFAULT_VALIDATOR_ADDRESSES in",
    "infra/scripts/gen_inventory.py (public — safe to commit):",
    rows.map((r) => r.address).join(","),
    "",
  );

  writeFileSync(KEY_FILE, lines.join("\n"));

  console.log(`wrote ${KEY_FILE}\n`);
  console.log("Addresses (public — put these in gen_inventory.py, same order):\n");
  for (const r of rows) {
    console.log(`  ${r.node}  ${r.name.padEnd(10)} ${r.address}`);
  }
  console.log(`\n  ${rows.map((r) => r.address).join(",")}\n`);
  console.log("The private keys are in the file above, not printed here.");
  console.log("Next: put them in GitHub secrets, then run `node validator-keys.mjs verify`.");
}

function verify() {
  const keys = localKeys();
  const addrs = committedAddresses();

  if (keys.length !== VALIDATORS.length || addrs.length !== VALIDATORS.length) {
    console.error(
      `expected ${VALIDATORS.length} keys and ${VALIDATORS.length} addresses, ` +
        `found ${keys.length} and ${addrs.length}`,
    );
    process.exit(1);
  }

  let ok = true;
  keys.forEach((key, i) => {
    const derived = privateKeyToAccount(`0x${key}`).address;
    const match = derived.toLowerCase() === addrs[i].toLowerCase();
    if (!match) ok = false;
    const { node, name } = VALIDATORS[i];
    console.log(`${match ? "MATCH   " : "MISMATCH"}  ${node}  ${name.padEnd(10)} ${addrs[i]}`);
    if (!match) console.log(`          key derives to ${derived}`);
  });

  if (!ok) {
    console.error(
      "\nMISMATCH — do not deploy. Every node whose key does not match its listed\n" +
        "address would refuse to boot. Re-run `generate` and update\n" +
        "gen_inventory.py and the GitHub secrets together, as one set.",
    );
    process.exit(1);
  }
  console.log("\nAll four keys derive to the addresses committed in gen_inventory.py.");
}

const command = process.argv[2];
if (command === "generate") {
  generate();
} else if (command === "verify") {
  verify();
} else {
  console.error("usage: node validator-keys.mjs generate|verify");
  process.exit(2);
}
