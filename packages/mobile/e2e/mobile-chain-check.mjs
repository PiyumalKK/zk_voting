#!/usr/bin/env node
/**
 * M13 acceptance harness — the mobile app's chain and API surface, against a
 * live node.
 *
 * The milestone's gate is otherwise a device walkthrough: install the app on a
 * phone, tap through onboarding, wait for a proof, watch a vote land. That
 * proves the whole system once, on one device, and proves nothing repeatably.
 * These checks drive the exact RPC path `src/services/chain.ts` builds by hand
 * — nonce, gas price, a signed **legacy** transaction, raw submission, receipt
 * — plus the `/api` shapes `src/services/api.ts` decodes, and they can be re-run
 * in seconds after any node change.
 *
 * What it deliberately does not cover: the keystore, biometric auth, OTP, and
 * the WebView UltraHonk prover. Those need a device, and the gate's step 4 is
 * where they get exercised.
 *
 *   Custom mode (the milestone's target):
 *     packages/blockchain$ make run-dev
 *     $ yarn deploy --network custom
 *     packages/nextjs$ yarn dev              # .env.local = custom column
 *     packages/mobile$  node e2e/mobile-chain-check.mjs
 *
 *   Hardhat mode (regression — MASTER §6 rule 4):
 *     $ yarn chain && yarn deploy && (cd packages/nextjs && yarn dev)
 *     packages/mobile$ CHECK_CHAIN_ID=31337 CHECK_RPC_URL=http://127.0.0.1:8545 \
 *                      node e2e/mobile-chain-check.mjs
 *
 * Flags / env:
 *   CHECK_RPC_URL   (default http://127.0.0.1:9545)  the node
 *   CHECK_CHAIN_ID  (default 9494)                   the chain id it must report
 *   CHECK_API_URL   (default http://127.0.0.1:3000)  the Next.js app
 *   CHECK_VOTER_KEY (optional)                       an allowlisted voter's key,
 *                                                    which turns the register
 *                                                    check from SKIP into a
 *                                                    real transaction
 *   --strict                                         treat SKIPs as failures
 *
 * The `CHECK_` prefix is carried over from `nextjs/e2e/frontend-check.mjs` for
 * the reason recorded there: names like `RPC_URL` collide with the app server's
 * own variables, and on Windows a `set` persists for the console session.
 *
 * Defaults point at the **custom** chain, unlike the Next.js harness, because
 * M13 is a custom-chain milestone. Hardhat mode is the explicit case here.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  decodeErrorResult,
  encodeFunctionData,
  http,
  parseTransaction,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// `||`, not `??`: an env var set to the empty string must fall back.
const RPC_URL = process.env.CHECK_RPC_URL?.trim() || "http://127.0.0.1:9545";
const API_URL = (process.env.CHECK_API_URL?.trim() || "http://127.0.0.1:3000").replace(/\/$/, "");
const EXPECTED_CHAIN_ID = Number(process.env.CHECK_CHAIN_ID?.trim() || 9494);
const VOTER_KEY = process.env.CHECK_VOTER_KEY?.trim() || "";
const STRICT = process.argv.includes("--strict");

/**
 * Account #0 of the `test test … junk` mnemonic — prefunded by both chains'
 * genesis (MASTER §3) and public knowledge. Used only as a sender that can pay
 * gas on Hardhat, for transactions that are expected to revert anyway.
 */
const HARDHAT_ACCOUNT_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const HERE = dirname(fileURLToPath(import.meta.url));
const VOTING_ARTIFACT = resolve(
  HERE,
  "../../hardhat/artifacts/contracts/Voting.sol/Voting.json",
);

let passed = 0;
let failed = 0;
let skipped = 0;

const pass = (name, detail = "") => {
  passed++;
  console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ""}`);
};
const fail = (name, detail) => {
  failed++;
  console.log(`[FAIL] ${name} — ${detail}`);
};
const skip = (name, why) => {
  if (STRICT) return fail(name, `${why} (--strict)`);
  skipped++;
  console.log(`[SKIP] ${name} — ${why}`);
};
const check = (name, condition, detail = "") =>
  condition ? pass(name, detail) : fail(name, detail || "assertion failed");

const client = createPublicClient({ transport: http(RPC_URL) });

/** A raw JSON-RPC call — the app's transport, not viem's typed wrapper. */
const rpc = async (method, params = []) => {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
};

const getJson = async path => {
  const res = await fetch(`${API_URL}${path}`);
  let body;
  try {
    body = await res.json();
  } catch {
    body = { error: "<non-JSON response>" };
  }
  return { status: res.status, body };
};

const isFreeGasChain = () => EXPECTED_CHAIN_ID !== 31337;

// ── preflight ───────────────────────────────────────────────────────────────

const preflight = async () => {
  const leaked = ["EXPO_PUBLIC_RPC_URL", "EXPO_PUBLIC_CHAIN_ID", "EXPO_PUBLIC_API_URL"].filter(
    name => process.env[name],
  );
  if (leaked.length) {
    console.warn("WARNING: these app variables are set in this shell:");
    for (const name of leaked) console.warn(`  ${name}=${process.env[name]}`);
    console.warn(
      "They do not configure this harness (it uses CHECK_*), but an Expo bundle\n" +
        "built from this window would inherit them.\n",
    );
  }

  try {
    const chainId = await client.getChainId();
    if (chainId !== EXPECTED_CHAIN_ID) {
      console.error(
        `The node at ${RPC_URL} reports chain ${chainId}, but CHECK_CHAIN_ID=${EXPECTED_CHAIN_ID}.`,
      );
      process.exit(2);
    }
  } catch (e) {
    console.error(`Cannot reach the node at ${RPC_URL}: ${e.shortMessage ?? e.message}`);
    console.error("Start it first (`make run-dev` in packages/blockchain, or `yarn chain`).");
    process.exit(2);
  }

  // The app serves the mobile client's entire read surface, so an unreachable
  // one is a setup problem, not a finding. Fail here rather than let every
  // later fetch throw the same connection error.
  try {
    await fetch(`${API_URL}/api/election`);
  } catch (e) {
    console.error(`Cannot reach the Next.js server at ${API_URL}: ${e.message}`);
    console.error("Start it with `yarn dev` in packages/nextjs, in the matching mode.");
    process.exit(2);
  }
};

// ── the raw legacy-transaction path (src/services/chain.ts) ─────────────────

/**
 * The compat-critical surface. `chain.ts` exists in its hand-rolled form
 * because viem's `writeContract` issues gas- and fee-estimation calls that are
 * malformed under Hermes; every assertion here is about the node answering the
 * three calls that path does make.
 */
const checkRawTxPath = async () => {
  const burner = privateKeyToAccount(generatePrivateKey());

  const nonceLatest = await rpc("eth_getTransactionCount", [burner.address, "latest"]);
  check(
    "eth_getTransactionCount(latest) answers for an unknown address",
    nonceLatest.result === "0x0",
    `result=${nonceLatest.result ?? JSON.stringify(nonceLatest.error)}`,
  );

  // MASTER §10 pitfall 4: there is no mempool, so `pending` must equal `latest`.
  // The app asks for `latest`; anything else here would mean a nonce that skips.
  const noncePending = await rpc("eth_getTransactionCount", [burner.address, "pending"]);
  check(
    "eth_getTransactionCount agrees on latest and pending",
    noncePending.result === nonceLatest.result,
    `latest=${nonceLatest.result} pending=${noncePending.result}`,
  );

  const gasPrice = await rpc("eth_gasPrice");
  check(
    "eth_gasPrice answers without an error",
    typeof gasPrice.result === "string" && gasPrice.result.startsWith("0x"),
    // Worth stating plainly: the app falls back to 1 gwei only when this call
    // *fails*. A failure here would silently reprice every vote.
    `result=${gasPrice.result ?? JSON.stringify(gasPrice.error)}`,
  );

  if (isFreeGasChain()) {
    check(
      "the chain prices gas at zero",
      gasPrice.result === "0x0",
      `eth_gasPrice=${gasPrice.result}`,
    );
  } else {
    skip("the chain prices gas at zero", `hardhat prices gas at ${gasPrice.result}`);
  }

  return { burner, gasPrice: BigInt(gasPrice.result ?? 0) };
};

/**
 * THE gas-problem proof: a wallet that has never held a wei signs, sends and
 * gets a mined receipt. On Hardhat this is impossible by design, so it skips.
 */
const checkUnfundedBurnerCanTransact = async ({ burner, gasPrice }) => {
  const name = "an unfunded burner transacts and is mined";
  if (!isFreeGasChain()) {
    return skip(name, "hardhat charges gas, so an unfunded sender cannot transact");
  }

  const balanceBefore = await client.getBalance({ address: burner.address });
  check(
    "the burner starts with a zero balance",
    balanceBefore === 0n,
    `balance=${balanceBefore}`,
  );

  // Exactly what `sendLegacyTx` builds: legacy envelope, node's gas price,
  // no estimation calls.
  const serialized = await burner.signTransaction({
    chainId: EXPECTED_CHAIN_ID,
    to: "0x000000000000000000000000000000000000dEaD",
    data: "0x",
    gas: 21_000n,
    gasPrice,
    nonce: 0,
    value: 0n,
    type: "legacy",
  });

  check(
    "the app's transaction is a legacy envelope",
    parseTransaction(serialized).type === "legacy",
    "type=legacy",
  );

  const sent = await rpc("eth_sendRawTransaction", [serialized]);
  if (!sent.result) {
    return fail(name, `eth_sendRawTransaction: ${JSON.stringify(sent.error)}`);
  }

  const receipt = await client.waitForTransactionReceipt({ hash: sent.result });
  check(name, receipt.status === "success", `status=${receipt.status} block=${receipt.blockNumber}`);
  check(
    "the receipt reports a zero effective gas price",
    receipt.effectiveGasPrice === 0n,
    `effectiveGasPrice=${receipt.effectiveGasPrice}`,
  );

  const balanceAfter = await client.getBalance({ address: burner.address });
  check(
    "the burner paid nothing to transact",
    balanceAfter === 0n,
    `balance after=${balanceAfter}`,
  );
};

// ── revert decoding (the app's error strings) ───────────────────────────────

/**
 * `vote.tsx` and `register.tsx` show `e.shortMessage ?? e.message`, and the
 * screens' copy relies on the custom error's *name* surviving the round trip —
 * `Voting__NullifierHashAlreadyUsed` is what "you have already voted" is
 * derived from. MASTER §10 pitfalls 1 and 2: the node must refuse the
 * transaction at submission and return the revert bytes in `data`.
 *
 * A garbage proof is enough to trigger it. Which error comes back depends on
 * the division's phase, so the assertion is that it is *a named Voting error*,
 * not a bare "execution reverted".
 */
const checkRevertCarriesCustomError = async (division, gasPrice) => {
  const name = "a reverting vote returns decodable custom-error data";

  let abi;
  try {
    abi = JSON.parse(readFileSync(VOTING_ARTIFACT, "utf8")).abi;
  } catch {
    return skip(name, `no Voting artifact at ${VOTING_ARTIFACT} — run \`yarn compile\``);
  }

  // On the custom chain any burner can send this. Hardhat charges gas, so there
  // it has to come from an account that can pay — otherwise the node rejects it
  // for being unfunded and never reaches the revert, which is the thing under
  // test. Account #0 of the default mnemonic is prefunded on both chains and is
  // a publicly known test key (the same one §9 uses for the relay).
  const sender = isFreeGasChain()
    ? privateKeyToAccount(generatePrivateKey())
    : privateKeyToAccount(VOTER_KEY || HARDHAT_ACCOUNT_0);
  const nonce = await client.getTransactionCount({ address: sender.address });

  const data = encodeFunctionData({
    abi,
    functionName: "vote",
    args: [
      "0xdeadbeef",
      `0x${"11".repeat(32)}`,
      `0x${"22".repeat(32)}`,
      `0x${"00".repeat(31)}00`,
      `0x${"00".repeat(31)}01`,
    ],
  });

  const serialized = await sender.signTransaction({
    chainId: EXPECTED_CHAIN_ID,
    to: division.votingContract,
    data,
    gas: 15_000_000n,
    gasPrice,
    nonce,
    value: 0n,
    type: "legacy",
  });

  const sent = await rpc("eth_sendRawTransaction", [serialized]);

  if (sent.result) {
    return fail(name, `the node mined an invalid vote (tx ${sent.result})`);
  }

  const error = sent.error ?? {};
  check(
    "a reverting transaction is refused at submission, not mined",
    error.code === 3 || /revert/i.test(error.message ?? ""),
    `code=${error.code} message=${error.message}`,
  );

  const revertData = typeof error.data === "string" ? error.data : error.data?.data;
  if (!revertData || revertData === "0x") {
    return fail(
      name,
      `no revert data in the error (${JSON.stringify(error).slice(0, 200)}). ` +
        "The app cannot name the failure without it.",
    );
  }

  try {
    const decoded = decodeErrorResult({ abi, data: revertData });
    check(name, decoded.errorName.startsWith("Voting__"), `errorName=${decoded.errorName}`);
  } catch (e) {
    fail(name, `revert data ${revertData.slice(0, 20)}… did not decode: ${e.message}`);
  }
};

// ── the API shapes src/services/api.ts decodes ──────────────────────────────

const REQUIRED_DIVISION_FIELDS = [
  "name",
  "votingContract",
  "gnOfficer",
  "active",
  "phase",
  "phaseLabel",
  "question",
  "candidates",
  "voteCounts",
  "totalVotes",
  "registeredVoters",
  "registrationEndTime",
  "votingEndTime",
  "root",
];

const checkElectionShape = async () => {
  const { status, body } = await getJson("/api/election");
  check("GET /api/election responds 200", status === 200, `status=${status} ${body.error ?? ""}`);
  if (status !== 200) return null;

  check(
    "election reports the chain the app is configured for",
    body.chainId === EXPECTED_CHAIN_ID,
    `reported=${body.chainId} expected=${EXPECTED_CHAIN_ID}`,
  );
  check("election lists at least one division", (body.divisions?.length ?? 0) > 0, `count=${body.divisionCount}`);
  if (!body.divisions?.length) return null;

  // `DivisionState` in src/services/api.ts declares these fields; a missing one
  // is `undefined` at runtime and renders as a blank card rather than an error.
  const division = body.divisions[0];
  const missing = REQUIRED_DIVISION_FIELDS.filter(f => division[f] === undefined);
  check(
    "every field DivisionState declares is present",
    missing.length === 0,
    missing.length ? `missing: ${missing.join(", ")}` : `${REQUIRED_DIVISION_FIELDS.length} fields`,
  );

  check(
    "phaseLabel matches PHASE_LABELS[phase]",
    ["Setup", "Registration", "Voting", "Ended"][division.phase] === division.phaseLabel,
    `phase=${division.phase} label=${division.phaseLabel}`,
  );

  return body;
};

const checkMerklePathShape = async division => {
  const name = "merkle-path serves a path the prover can use";
  if (division.registeredVoters === 0) {
    return skip(name, "no commitments registered on this division yet");
  }

  // The app looks up its own commitment; without device secrets the next best
  // thing is the first leaf, which `/api/merkle-path` can resolve by index.
  const logs = await client.getLogs({
    address: division.votingContract,
    event: {
      type: "event",
      name: "NewLeaf",
      inputs: [
        { name: "index", type: "uint256", indexed: false },
        { name: "value", type: "uint256", indexed: false },
      ],
    },
    fromBlock: 0n,
    toBlock: "latest",
  });

  if (!logs.length) return skip(name, "no NewLeaf logs on this division");

  const commitment = logs[0].args.value.toString();
  const { status, body } = await getJson(
    `/api/merkle-path?division=${division.votingContract}&commitment=${commitment}`,
  );
  if (status !== 200) return fail(name, `status=${status} ${body.error ?? ""}`);

  const missing = ["leafIndex", "circuitIndex", "depth", "root", "siblings", "treeSize"].filter(
    f => body[f] === undefined,
  );
  check(
    "every field MerklePathResponse declares is present",
    missing.length === 0,
    missing.length ? `missing: ${missing.join(", ")}` : "6 fields",
  );

  // The proof is generated against this root and verified on-chain against the
  // contract's — a mismatch produces `Voting__InvalidRoot` at vote time, which
  // is the single hardest failure to diagnose from the phone.
  check(
    name,
    BigInt(body.root) === BigInt(division.root),
    `api=${body.root} contract=${division.root}`,
  );
};

const checkRegister = async division => {
  const name = "a registration transaction is mined from the app's path";
  if (!VOTER_KEY) {
    return skip(name, "set CHECK_VOTER_KEY to an allowlisted voter's key to run this");
  }
  if (division.phase !== 1) {
    return skip(name, `division "${division.name}" is in ${division.phaseLabel}, not Registration`);
  }

  const account = privateKeyToAccount(VOTER_KEY);
  const abi = [
    {
      name: "register",
      type: "function",
      stateMutability: "nonpayable",
      inputs: [{ name: "_commitment", type: "uint256" }],
      outputs: [],
    },
  ];
  // A commitment is a field element, not an arbitrary uint256: the LeanIMT and
  // the Poseidon hash behind it work in BN254's scalar field. A full-width
  // 256-bit value overflows it. 128 random bits is comfortably inside and still
  // collision-free for a gate run.
  const commitment = BigInt(
    `0x${Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`,
  );

  const nonce = await client.getTransactionCount({ address: account.address });
  const gasPrice = await client.getGasPrice().catch(() => 1_000_000_000n);
  const serialized = await account.signTransaction({
    chainId: EXPECTED_CHAIN_ID,
    to: division.votingContract,
    data: encodeFunctionData({ abi, functionName: "register", args: [commitment] }),
    gas: 600_000n,
    gasPrice,
    nonce,
    value: 0n,
    type: "legacy",
  });

  const sent = await rpc("eth_sendRawTransaction", [serialized]);
  if (!sent.result) return fail(name, `eth_sendRawTransaction: ${JSON.stringify(sent.error)}`);

  const receipt = await client.waitForTransactionReceipt({ hash: sent.result });
  check(name, receipt.status === "success", `status=${receipt.status} block=${receipt.blockNumber}`);
  check(
    "the registration emits the NewLeaf log the merkle path is rebuilt from",
    receipt.logs.length > 0,
    `${receipt.logs.length} logs`,
  );
};

// ── run ─────────────────────────────────────────────────────────────────────

const main = async () => {
  console.log(`node=${RPC_URL} chain=${EXPECTED_CHAIN_ID} app=${API_URL}\n`);
  await preflight();

  console.log("── raw legacy transaction path (src/services/chain.ts)");
  const ctx = await checkRawTxPath();
  await checkUnfundedBurnerCanTransact(ctx);

  console.log("\n── API shapes (src/services/api.ts)");
  const election = await checkElectionShape();

  if (election?.divisions?.length) {
    const division = election.divisions[0];
    console.log("\n── contract interaction");
    await checkRevertCarriesCustomError(division, ctx.gasPrice);
    await checkMerklePathShape(division);
    await checkRegister(division);
  } else {
    skip("contract interaction checks", "no divisions to drive them against");
  }

  const total = passed + failed + skipped;
  console.log(
    `\n${total} checks: ${passed} passed, ${failed} failed, ${skipped} skipped`,
  );
  console.log(failed === 0 ? "PASS" : "FAIL");
  process.exit(failed === 0 ? 0 : 1);
};

main().catch(e => {
  console.error(`\nHarness crashed: ${e.stack ?? e.message}`);
  process.exit(2);
});
