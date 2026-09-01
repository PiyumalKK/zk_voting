#!/usr/bin/env node
// The M14 acceptance gate: one complete election on the custom chain, headless.
//
// Every earlier milestone proved one layer. M08 proved the contracts deploy and
// their own test suite passes; M09 proved the chain survives a restart and
// replays; M10 proved replicas agree; M11-M13 proved the web and mobile clients
// talk to it. None of them ever ran an election end to end, with a real
// zero-knowledge proof, from a wallet that has never held a wei. That is what
// this does, in one command:
//
//    fresh node -> yarn deploy --network custom -> admin sets up the election
//    -> GN officer allowlists five voters -> each registers a commitment
//    -> Merkle path rebuilt from NewLeaf logs -> REAL UltraHonk proof
//    -> vote submitted by an UNFUNDED burner -> tally / nullifier / double-vote
//    -> node restarted, state intact -> cmd/audit replays the whole chain
//
// Usage:
//   node election.mjs                    # manage a node on :9545, data-e2e/
//   node election.mjs --quiet            # don't echo the node's own log
//   node election.mjs --keep-node        # leave the node up afterwards
//   node election.mjs --rpc-url=http://127.0.0.1:8545 --network=localhost
//                                        # drive a chain someone else is running
//   node election.mjs --no-deploy        # reuse the deployment already there
//   node election.mjs --no-reset-deployments   # keep hardhat-deploy's records
//                                        #   (only useful against a warm chain)
// or, from packages/blockchain: `make e2e`
//
// Prerequisites (each checked with a real message, not a crash):
//   - `make build` and `make build-audit`      the Go binaries
//   - `yarn compile` in the repo root          contract artifacts
//   - `yarn install` in the repo root          hardhat-deploy's toolchain
//   - `npm install` in e2e/                    viem, bb.js, noir_js, poseidon
//   - internet access on the FIRST run         bb.js caches its SRS in ~/.bb-crs
//
// Two things this script deliberately does NOT do. It does not reach into the
// Go node's internals — every interaction is JSON-RPC that viem or the mobile
// app also makes, because a gate that uses a private door proves nothing about
// the front one. And it does not use its own deployment path: it shells out to
// the very `yarn deploy --network custom` that MASTER §8 tells a human to run,
// so a break in the deploy scripts fails here rather than in front of the
// examiner.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  decodeErrorResult,
  defineChain,
  encodeFunctionData,
  http,
  keccak256,
  parseAbiItem,
  parseEventLogs,
  stringToHex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount, generatePrivateKey } from "viem/accounts";

import { ROOT, delay } from "./cluster.mjs";
import { AUDIT_BINARY, ElectionNode } from "./lib/node.mjs";
import { buildCircuitInputs, buildMerklePath, buildVoteArgs, generateCommitment } from "./lib/election-core.mjs";
import { generateVoteProof, loadCircuit, missingProverDependencies } from "./lib/prover.mjs";

const REPO = join(ROOT, "..", "..");
const HARDHAT = join(REPO, "packages", "hardhat");
const ARTIFACTS = join(HARDHAT, "artifacts");

// Hardhat's public test mnemonic — the same 20 accounts internal/state/genesis.go
// prefunds with 10,000 ETH each, and the accounts hardhat.config.ts's `custom`
// network signs with. Not a secret.
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const OWNER = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 0 }); // election authority
const GN_OFFICER = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 1 }); // grama niladhari

/**
 * The division's electorate. Five voters, not one — see runRegistration() for
 * why. Accounts #4 onwards, so they never collide with the deploy scripts,
 * which use signers #0-#3.
 */
const ELECTORATE = [4, 5, 6, 7, 8].map((addressIndex) => mnemonicToAccount(TEST_MNEMONIC, { addressIndex }));

/**
 * Which leaf actually votes. Index 2 of 5 puts it in the middle of the tree,
 * so its path carries siblings on both sides and a left/right ordering bug
 * cannot pass by symmetry.
 */
const VOTING_LEAF = 2;

// Gas limits. Deliberately fixed rather than estimated, and deliberately the
// same numbers the mobile app hard-codes (packages/mobile/src/services/chain.ts),
// so this harness exercises the transaction shape a real voter sends.
const ADMIN_GAS = 1_000_000n;
const REGISTER_GAS = 600_000n;
const VOTE_GAS = 15_000_000n;

const REGISTRATION_SECONDS = 3600n;
const VOTING_SECONDS = 3600n;

const QUESTION = "M14 end-to-end gate — who should be the next President of Sri Lanka?";
const CANDIDATES = ["Candidate A (M14)", "Candidate B (M14)", "Candidate C (M14)"];
const CHOSEN_CANDIDATE = 1;

const NEW_LEAF_EVENT = parseAbiItem("event NewLeaf(uint256 index, uint256 value)");
const VOTE_CAST_EVENT = parseAbiItem(
  "event VoteCast(bytes32 indexed nullifierHash, address indexed sender, uint256 indexed candidateIndex, uint256 timestamp, uint256 voteCount)",
);

// ---------------------------------------------------------------------------
// Reporting. Same vocabulary as the other harnesses in this tree: one line per
// check, [SKIP] carries the reason, the run's verdict is the last line.

const steps = [];
const timings = {};

function pass(name, detail) {
  steps.push({ name, ok: true });
  console.log(`[PASS] ${name}${detail ? " — " + detail : ""}`);
}

function fail(name, detail) {
  steps.push({ name, ok: false, detail });
  console.log(`[FAIL] ${name}${detail ? " — " + detail : ""}`);
}

function skip(name, reason) {
  steps.push({ name, skipped: true, detail: reason });
  console.log(`[SKIP] ${name} — ${reason}`);
}

function check(name, condition, detail) {
  if (condition) pass(name, detail);
  else fail(name, detail);
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

// ---------------------------------------------------------------------------
// Chain plumbing

/** One raw JSON-RPC call. Errors carry the node's error object untouched. */
async function rpc(url, method, params = []) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await resp.json();
  if (body.error) {
    const err = new Error(`${method}: ${body.error.message}`);
    err.rpcError = body.error;
    throw err;
  }
  return body.result;
}

/**
 * Build, sign and send a legacy transaction by hand, exactly as the mobile app
 * does — nonce, gasPrice, sendRawTransaction, nothing else. No eth_estimateGas,
 * no fee history, no 1559 negotiation.
 *
 * Rejection is not swallowed: on this chain a reverting transaction is refused
 * at submission (MASTER §10 pitfall 2), and several checks below depend on
 * catching exactly that.
 */
async function sendTx(ctx, account, to, data, gas) {
  const [nonceHex, gasPriceHex] = await Promise.all([
    rpc(ctx.rpcUrl, "eth_getTransactionCount", [account.address, "latest"]),
    rpc(ctx.rpcUrl, "eth_gasPrice"),
  ]);

  const serializedTransaction = await account.signTransaction({
    chainId: ctx.chainId,
    to,
    data,
    gas,
    gasPrice: BigInt(gasPriceHex),
    nonce: Number(BigInt(nonceHex)),
    value: 0n,
    type: "legacy",
  });

  const started = Date.now();
  const hash = await rpc(ctx.rpcUrl, "eth_sendRawTransaction", [serializedTransaction]);
  const receipt = await waitForReceipt(ctx, hash);
  return { hash, receipt, elapsedMs: Date.now() - started };
}

async function waitForReceipt(ctx, hash, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await rpc(ctx.rpcUrl, "eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await delay(100);
  }
  throw new Error(`no receipt for ${hash} within ${timeoutMs} ms`);
}

/** A contract call helper that reads through viem's decoder. */
function reader(ctx, address, abi) {
  return (functionName, args = []) => ctx.publicClient.readContract({ address, abi, functionName, args });
}

/** A write helper bound to one contract's ABI. */
function writer(ctx, address, abi) {
  return (account, functionName, args = [], gas = ADMIN_GAS) =>
    sendTx(ctx, account, address, encodeFunctionData({ abi, functionName, args }), gas);
}

/**
 * Pull the custom error out of a rejected submission.
 *
 * viem's decodeErrorResult needs the raw revert bytes, which live in the
 * JSON-RPC error's `data` field (MASTER §10 pitfall 1). Hardhat nests them one
 * level deeper on some paths, so both shapes are accepted; anything else is
 * reported as "no revert data", which is itself a meaningful failure.
 */
function decodeRevert(err, abi) {
  const rpcError = err?.rpcError ?? {};
  const raw = typeof rpcError.data === "string" ? rpcError.data : rpcError.data?.data;
  if (typeof raw !== "string" || !raw.startsWith("0x") || raw.length < 10) {
    return { errorName: null, message: rpcError.message ?? err?.message ?? "unknown error", raw };
  }
  try {
    const decoded = decodeErrorResult({ abi, data: raw });
    return { errorName: decoded.errorName, args: decoded.args, raw };
  } catch (decodeErr) {
    return { errorName: null, message: `undecodable revert data: ${decodeErr.message}`, raw };
  }
}

// ---------------------------------------------------------------------------
// Preflight

function loadArtifact(relativePath) {
  const path = join(ARTIFACTS, relativePath);
  if (!existsSync(path)) {
    throw new Error(`missing contract artifact ${path}\nCompile first:  yarn compile  (from the repo root)`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadDeployment(network, name) {
  const path = join(HARDHAT, "deployments", network, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `no deployment record at ${path}\n` +
        `Deploy first:  yarn deploy --network ${network}  (or drop --no-deploy so this script does it)`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * RUNNING-GATES §5.1, encoded as a check rather than a warning in prose.
 *
 * `deployedContracts.ts` is regenerated wholesale from whatever chain folders
 * exist under packages/hardhat/deployments. Deploying to `custom` while
 * `localhost` is missing therefore silently DELETES the 31337 entry from a
 * committed file, breaking hardhat mode — the one thing MASTER §8 promises the
 * swap never does. Cheaper to refuse here than to explain the git diff later.
 */
function requireOtherNetworkDeployment(network) {
  const other = network === "custom" ? "localhost" : "custom";
  const dir = join(HARDHAT, "deployments", other);
  if (existsSync(dir)) return null;
  return (
    `packages/hardhat/deployments/${other} does not exist.\n` +
    `  Deploying to '${network}' now would regenerate packages/nextjs/contracts/deployedContracts.ts\n` +
    `  WITHOUT the ${other === "localhost" ? "31337" : "9494"} entry, silently breaking the other mode\n` +
    `  (RUNNING-GATES §5.1). Recreate it first:\n` +
    `      ${other === "localhost" ? "yarn chain   # terminal 1\n      yarn deploy  # terminal 2" : "yarn deploy --network custom"}\n` +
    `  Or re-run with --no-deploy to use the deployment already on this chain,\n` +
    `  or with --allow-single-network if you accept the regeneration.`
  );
}

/**
 * Pull the one line that explains a failed deploy out of hardhat-deploy's
 * several screens of stack trace.
 *
 * hardhat-deploy prints "An unexpected error occurred:" followed by an
 * `Error: ERROR processing <script>:` line, then the actual cause, then forty
 * frames of its own internals — twice. The cause is the second `Error:` line,
 * and it is the only part worth putting at the bottom of our output where a
 * reader looks first.
 */
function summariseDeployFailure(text) {
  const errorLines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("Error:") && !l.startsWith("Error: ERROR processing"));
  return errorLines[0] ?? null;
}

/**
 * Run `yarn deploy --network <network>` and stream its output.
 *
 * `reset` passes hardhat-deploy's own `--reset` flag, which discards the
 * network's existing deployment records before running. That is mandatory
 * whenever this harness created the chain, and the reason is not obvious:
 * hardhat-deploy's `fetchIfDifferent` reads the recorded `transactionHash` of
 * each previous deployment and asks the node for that transaction, to decide
 * whether anything changed. On a chain that was created seconds ago the
 * transaction does not exist, the provider returns null, and hardhat-deploy
 * stops with "cannot get the transaction for PoseidonT3's previous deployment,
 * please check your node synced status" — which reads like a node fault and is
 * not one. The records are simply describing a chain that no longer exists.
 *
 * Deleting them is safe precisely here: the addresses are deterministic (same
 * mnemonic, same nonce order, fresh chain), so a successful run regenerates
 * byte-identical records and `deployedContracts.ts` does not move.
 */
function runDeploy(network, rpcUrl, chainId, quiet, reset) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CUSTOM_RPC_URL: rpcUrl, CUSTOM_CHAIN_ID: String(chainId) };
    const args = ["deploy", "--network", network, ...(reset ? ["--reset"] : [])];
    // shell: true so this works with yarn.cmd on Windows and yarn on POSIX
    // without the caller having to care which.
    const proc = spawn("yarn", args, {
      cwd: HARDHAT,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output = [];
    const capture = (stream) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output.push(chunk);
        if (!quiet) process.stdout.write(chunk);
      });
    };
    capture(proc.stdout);
    capture(proc.stderr);

    proc.once("error", reject);
    proc.once("exit", (code) => {
      const text = output.join("");
      if (code === 0) return resolve(text);

      const cause = summariseDeployFailure(text);
      const parts = [`yarn ${args.join(" ")} failed (exit ${code})`];
      if (cause) parts.push(`  ${cause}`);
      // Windows reports an aborted process as 0xC0000409 / 3221226505. It is
      // ts-node's libuv teardown crashing *after* the real error was printed
      // ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"), so the exit
      // code carries no information and the line above does.
      if (code === 3221226505) parts.push("  (the exit code is a Windows teardown crash, not the cause)");
      // The full output was already streamed unless --quiet suppressed it;
      // repeating it here would print the same stack trace twice.
      if (quiet) parts.push("", text.slice(-4000));
      reject(new Error(parts.join("\n")));
    });
  });
}

// ---------------------------------------------------------------------------
// The election

/**
 * Put the division into a known Setup state.
 *
 * A division that has already run an election (this gate re-run, or M08's test
 * suite) is not in Setup, and every admin call below would revert on the phase
 * check. resetElection() is the contract's own answer to that: it bumps the
 * election id, which cheaply clears voters, commitments, nullifiers, the tree
 * and the tally. So the gate is idempotent by construction rather than by
 * requiring a human to remember to reset the chain.
 */
async function ensureSetupPhase(ctx, voting) {
  const write = writer(ctx, voting.address, voting.abi);
  const read = reader(ctx, voting.address, voting.abi);

  const phase = Number(await read("currentPhase"));
  if (phase === 0) {
    pass("division starts in Setup", "no reset needed");
    return;
  }
  await write(OWNER, "resetElection");
  const after = Number(await read("currentPhase"));
  check("resetElection returns the division to Setup", after === 0, `phase ${phase} -> ${after}`);
}

async function runAdminLifecycle(ctx, voting) {
  const write = writer(ctx, voting.address, voting.abi);
  const read = reader(ctx, voting.address, voting.abi);

  await write(OWNER, "setQuestion", [QUESTION]);
  check("admin sets the question", (await read("getVotingData"))[0] === QUESTION);

  await write(OWNER, "setCandidates", [CANDIDATES]);
  const candidates = await read("getCandidates");
  check(
    "admin sets the candidates",
    candidates.length === CANDIDATES.length && candidates.every((c, i) => c === CANDIDATES[i]),
    candidates.join(" | "),
  );

  // Hand the division to a DIFFERENT account than the owner. The deploy script
  // assigns Kaduwela's GN seat to the deployer for demo convenience, which
  // would let this whole gate pass with the owner quietly doing the GN's job —
  // and the separation of those two roles is the point of 01-AUTH-DESIGN §4.
  await write(OWNER, "setGNOfficer", [GN_OFFICER.address, true]);
  check("admin assigns a GN officer", await read("s_isGnOfficer", [GN_OFFICER.address]), GN_OFFICER.address);

  await write(OWNER, "startRegistration", [REGISTRATION_SECONDS]);
  check("admin opens registration", Number(await read("currentPhase")) === 1);
}

/**
 * Enrolment, both halves of it.
 *
 * `reserveNicHash` binds each device to a NIC in the shared registry;
 * `addVoters` puts it on this division's roll. **Both** are required — a device
 * the registry has never seen is refused by `register()` with
 * `NicRegistry__DeviceNotEnrolled`, no matter what the allowlist says. That is
 * the point: enrolment has exactly one route, through a GN officer who checked
 * an identity document.
 *
 * This harness used to call `addVoters` alone, which is precisely the shortcut
 * the contracts now refuse, so it would fail at the first `register()`.
 *
 * The NIC hashes here stand in for the pepper-keyed HMACs the server computes
 * (`services/nic/nicHash.ts`); the registry only ever sees opaque bytes, so a
 * deterministic per-voter hash exercises the same paths.
 */
async function runGnEnrolment(ctx, voting, nicRegistry) {
  const write = writer(ctx, voting.address, voting.abi);
  const read = reader(ctx, voting.address, voting.abi);
  const writeNic = writer(ctx, nicRegistry.address, nicRegistry.abi);

  const addresses = ELECTORATE.map((a) => a.address);

  for (const address of addresses) {
    const { receipt } = await write_nic_hash(writeNic, voting.address, address);
    if (receipt.status !== "0x1") {
      fail("GN officer reserves a NIC for each voter", `reserveNicHash reverted for ${address}`);
      return;
    }
  }
  pass("GN officer reserves a NIC for each voter", `${addresses.length} devices bound in the NicRegistry`);

  await write(GN_OFFICER, "addVoters", [addresses, addresses.map(() => true)]);

  const rolls = await Promise.all(addresses.map((a) => read("getVoterData", [a])));
  check(
    "GN officer allowlists the electorate",
    rolls.every(([allowlisted, registered]) => allowlisted === true && registered === false),
    `${addresses.length} voters, first ${addresses[0]}`,
  );
}

/** One voter's NIC reservation, signed by the GN officer. */
function write_nic_hash(writeNic, votingAddress, device) {
  return writeNic(GN_OFFICER, "reserveNicHash", [nicHashFor(device), votingAddress, device]);
}

/** A stand-in for the server's pepper-keyed NIC hash: stable, and unique per voter. */
function nicHashFor(address) {
  return keccak256(stringToHex(`sl-vote-e2e-nic:${address.toLowerCase()}`));
}

/**
 * Every allowlisted voter registers a commitment.
 *
 * More than one, deliberately. A division with a single registered voter has a
 * Merkle tree whose root IS that voter's commitment: the path has no siblings,
 * the circuit index is 0, and `buildMerklePath`'s sibling ordering and index
 * brute-force — the most bug-prone code in the whole flow — would never run.
 * A gate that cannot fail in the interesting way is not a gate. It is also
 * closer to reality: a one-voter election has no anonymity set to hide in.
 *
 * The voter this harness later votes as is NOT the first or last leaf, so the
 * path has siblings on both sides.
 */
async function runRegistration(ctx, voting) {
  const write = writer(ctx, voting.address, voting.abi);
  const read = reader(ctx, voting.address, voting.abi);

  const before = Number((await read("getVotingData"))[5]);
  const identities = [];

  for (const [i, account] of ELECTORATE.entries()) {
    const identity = generateCommitment();
    const { receipt } = await write(account, "register", [BigInt(identity.commitment)], REGISTER_GAS);
    if (receipt.status !== "0x1") {
      fail("every allowlisted voter registers a commitment", `voter ${i} (${account.address}) reverted`);
      return { identities, voter: null };
    }
    const logs = parseEventLogs({ abi: [NEW_LEAF_EVENT], logs: receipt.logs });
    if (logs.length !== 1 || logs[0].args.value !== BigInt(identity.commitment)) {
      fail("every allowlisted voter registers a commitment", `voter ${i} emitted ${logs.length} NewLeaf logs`);
      return { identities, voter: null };
    }
    identities.push({ ...identity, account, leafIndex: Number(logs[0].args.index) });
  }

  pass("every allowlisted voter registers a commitment", `${identities.length} commitments, one NewLeaf log each`);

  check(
    "NewLeaf indices are consecutive from the previous tree size",
    identities.every((id, i) => id.leafIndex === before + i),
    identities.map((id) => id.leafIndex).join(","),
  );

  const after = Number((await read("getVotingData"))[5]);
  check(
    "the division's tree grows by one leaf per registration",
    after === before + ELECTORATE.length,
    `${before} -> ${after}`,
  );

  // Vote as a middle voter: their path has siblings on both sides, so a
  // left/right ordering bug cannot pass by symmetry.
  return { identities, voter: identities[VOTING_LEAF] };
}

/**
 * Rebuild the inclusion proof from public chain data alone, the way
 * /api/merkle-path does for the mobile app.
 *
 * The check that matters is the last one. This harness derives the root from
 * `eth_getLogs`; the contract computes it inside the EVM from its own storage.
 * If those two disagree, either the node's log index is wrong or its execution
 * is — and on the phone the symptom would be `Voting__InvalidRoot` arriving two
 * minutes after a proof started, which RUNNING-GATES §11 calls the hardest
 * failure in the system to diagnose. Here it is one line.
 */
async function buildPath(ctx, voting, identity) {
  const read = reader(ctx, voting.address, voting.abi);
  const votingData = await read("getVotingData");
  const treeSize = Number(votingData[5]);
  const contractRoot = BigInt(votingData[7]);

  const logs = await ctx.publicClient.getLogs({
    address: voting.address,
    event: NEW_LEAF_EVENT,
    fromBlock: 0n,
    toBlock: "latest",
  });

  const path = buildMerklePath({
    leafEvents: logs.map((l) => ({ index: l.args.index, value: l.args.value })),
    treeSize,
    commitment: identity.commitment,
  });

  check(
    "the Merkle path rebuilt from NewLeaf logs matches the contract's root",
    BigInt(path.root) === contractRoot,
    `root ${path.root} depth ${path.depth} leaf ${path.leafIndex} circuitIndex ${path.circuitIndex}`,
  );

  // Guard against the gate quietly weakening itself. With one registered voter
  // the root is the commitment, the path is empty and the sibling ordering and
  // circuit-index search never execute — so the check above would pass while
  // proving nothing about them. If ELECTORATE is ever trimmed to one, this
  // fails loudly instead.
  check(
    "the path is non-trivial, so the sibling ordering is actually exercised",
    path.depth > 0 && path.leafIndex > 0 && path.leafIndex < treeSize - 1,
    `depth ${path.depth}, leaf ${path.leafIndex} of ${treeSize} (not an edge leaf)`,
  );
  return path;
}

async function proveVote(ctx, path, identity) {
  const inputs = buildCircuitInputs({
    nullifier: identity.nullifier,
    secret: identity.secret,
    circuitIndex: path.circuitIndex,
    siblings: path.siblings,
    root: path.root,
    candidateIndex: CHOSEN_CANDIDATE,
    depth: path.depth,
  });

  const { proof, publicInputs, witnessMs, proveMs } = await ctx.prove(ctx.circuit, inputs);
  timings.witnessMs = witnessMs;
  timings.proveMs = proveMs;

  check(
    "a real UltraHonk proof is generated",
    proof.length > 2 && publicInputs.length === 4,
    `${(proof.length - 2) / 2} bytes, ${publicInputs.length} public inputs, witness ${witnessMs} ms, prove ${proveMs} ms`,
  );

  return buildVoteArgs(inputs, proof);
}

/**
 * Cast the vote from a wallet created seconds ago that has never been funded.
 *
 * This is the milestone's headline result and the reason the custom chain
 * exists. On a chain that prices gas at zero the burner needs nothing, so a
 * voter's anonymity costs neither a faucet, a paymaster nor a relayer. Against
 * a chain that does charge (the hardhat control run), the free-gas claim is
 * reported as a SKIP with its reason and the burner is funded, so the rest of
 * the flow is still exercised — M13's lesson that a check which only ever runs
 * against one backend is not yet a check.
 */
async function castVote(ctx, voting, voteArgs) {
  const burner = privateKeyToAccount(generatePrivateKey());
  const gasPrice = BigInt(await rpc(ctx.rpcUrl, "eth_gasPrice"));
  const freeGas = gasPrice === 0n;

  if (!freeGas) {
    skip("the burner votes without ever being funded", `this chain prices gas at ${gasPrice} wei`);
    const funding = gasPrice * VOTE_GAS;
    const serialized = await OWNER.signTransaction({
      chainId: ctx.chainId,
      to: burner.address,
      value: funding,
      gas: 21_000n,
      gasPrice,
      nonce: Number(BigInt(await rpc(ctx.rpcUrl, "eth_getTransactionCount", [OWNER.address, "latest"]))),
      type: "legacy",
    });
    await waitForReceipt(ctx, await rpc(ctx.rpcUrl, "eth_sendRawTransaction", [serialized]));
  }

  const balanceBefore = BigInt(await rpc(ctx.rpcUrl, "eth_getBalance", [burner.address, "latest"]));
  if (freeGas) {
    check("the burner starts with a zero balance", balanceBefore === 0n, `${burner.address} = ${balanceBefore} wei`);
  }

  const data = encodeFunctionData({
    abi: voting.abi,
    functionName: "vote",
    args: [voteArgs.proof, voteArgs.nullifierHash, voteArgs.root, voteArgs.vote, voteArgs.depth],
  });

  const { receipt, elapsedMs } = await sendTx(ctx, burner, voting.address, data, VOTE_GAS);
  timings.voteMs = elapsedMs;

  check(
    "the vote transaction is mined successfully",
    receipt.status === "0x1",
    `block ${BigInt(receipt.blockNumber)}, gasUsed ${BigInt(receipt.gasUsed)}, ${elapsedMs} ms submit-to-receipt`,
  );

  const balanceAfter = BigInt(await rpc(ctx.rpcUrl, "eth_getBalance", [burner.address, "latest"]));
  if (freeGas) {
    check(
      "the burner votes without ever being funded",
      balanceBefore === 0n && balanceAfter === 0n && receipt.status === "0x1",
      `${burner.address} held 0 wei before and after a ${BigInt(receipt.gasUsed)}-gas transaction`,
    );
  }

  return { receipt, burner };
}

async function assertOutcome(ctx, voting, receipt, voteArgs, countsBefore) {
  const read = reader(ctx, voting.address, voting.abi);

  const counts = (await read("getVoteCounts")).map((c) => Number(c));
  check(
    "the chosen candidate's tally increases by exactly one",
    counts[CHOSEN_CANDIDATE] === countsBefore[CHOSEN_CANDIDATE] + 1 &&
      counts.every((c, i) => i === CHOSEN_CANDIDATE || c === countsBefore[i]),
    `${countsBefore.join("/")} -> ${counts.join("/")}`,
  );

  const used = await read("isNullifierUsed", [voteArgs.nullifierHash]);
  check("the nullifier is recorded as spent", used === true, voteArgs.nullifierHash);

  const events = parseEventLogs({ abi: [VOTE_CAST_EVENT], logs: receipt.logs });
  check(
    "VoteCast names the right candidate",
    events.length === 1 &&
      Number(events[0].args.candidateIndex) === CHOSEN_CANDIDATE &&
      events[0].args.nullifierHash.toLowerCase() === voteArgs.nullifierHash.toLowerCase(),
    events.length === 1 ? `candidate ${events[0].args.candidateIndex}, count ${events[0].args.voteCount}` : "no VoteCast",
  );
}

/**
 * The same proof, from a different wallet. The nullifier is what makes a vote
 * single-use, and it is checked in the contract, not in the app — so replaying
 * a valid proof from a fresh burner is exactly the attack the design has to
 * refuse, and refusing it with a NAMED custom error is what the phone's
 * "you have already voted" copy is derived from.
 */
async function assertDoubleVoteRejected(ctx, voting, voteArgs) {
  const replayBurner = privateKeyToAccount(generatePrivateKey());
  const gasPrice = BigInt(await rpc(ctx.rpcUrl, "eth_gasPrice"));

  if (gasPrice !== 0n) {
    const serialized = await OWNER.signTransaction({
      chainId: ctx.chainId,
      to: replayBurner.address,
      value: gasPrice * VOTE_GAS,
      gas: 21_000n,
      gasPrice,
      nonce: Number(BigInt(await rpc(ctx.rpcUrl, "eth_getTransactionCount", [OWNER.address, "latest"]))),
      type: "legacy",
    });
    await waitForReceipt(ctx, await rpc(ctx.rpcUrl, "eth_sendRawTransaction", [serialized]));
  }

  const data = encodeFunctionData({
    abi: voting.abi,
    functionName: "vote",
    args: [voteArgs.proof, voteArgs.nullifierHash, voteArgs.root, voteArgs.vote, voteArgs.depth],
  });

  const heightBefore = BigInt(await rpc(ctx.rpcUrl, "eth_blockNumber"));
  try {
    await sendTx(ctx, replayBurner, voting.address, data, VOTE_GAS);
    fail("replaying the proof from another wallet is rejected", "the second vote was accepted");
    return;
  } catch (err) {
    const decoded = decodeRevert(err, voting.abi);
    check(
      "replaying the proof from another wallet is rejected",
      decoded.errorName === "Voting__NullifierHashAlreadyUsed",
      decoded.errorName ?? decoded.message,
    );
  }

  // MASTER §10 pitfall 2: a reverting transaction is refused at submission and
  // must not be mined. If it were, the audit would still pass and the chain
  // would still be consistent — it would just contain a transaction that did
  // nothing, which is precisely the kind of thing an election audit must not
  // have to explain.
  const heightAfter = BigInt(await rpc(ctx.rpcUrl, "eth_blockNumber"));
  check(
    "the rejected vote is not mined into a block",
    heightAfter === heightBefore,
    `height ${heightBefore} unchanged`,
  );
}

async function closeElection(ctx, voting, registry) {
  const write = writer(ctx, voting.address, voting.abi);
  const read = reader(ctx, voting.address, voting.abi);

  await write(OWNER, "endElection");
  check("admin ends the election", Number(await read("currentPhase")) === 3);

  const national = await reader(ctx, registry.address, registry.abi)("getNationalResults");
  check(
    "the registry's national tally includes the vote",
    Number(national[CHOSEN_CANDIDATE]) >= 1,
    national.map((n) => Number(n)).join("/"),
  );
}

// ---------------------------------------------------------------------------
// Durability: restart, then an independent replay

async function assertRestartPreservesState(ctx, node, voting) {
  const read = reader(ctx, voting.address, voting.abi);
  const before = {
    head: await rpc(ctx.rpcUrl, "eth_getBlockByNumber", ["latest", false]),
    counts: (await read("getVoteCounts")).map((c) => Number(c)),
  };

  // Only lines produced by the RESTART count towards the recovery check below.
  // The first start of this chain logs its own startup lines, and searching the
  // whole buffer would let a restart that logged nothing at all pass.
  const logMark = node.logLines.length;

  const graceful = await node.stop();
  await node.start();

  const after = {
    head: await rpc(ctx.rpcUrl, "eth_getBlockByNumber", ["latest", false]),
    counts: (await read("getVoteCounts")).map((c) => Number(c)),
  };

  const heightBefore = BigInt(before.head.number);
  const heightAfter = BigInt(after.head.number);
  const sameHead = after.head.hash === before.head.hash && heightAfter === heightBefore;

  // The distinction this reports is the whole point. Losing the tail of the
  // chain is one failure; coming back at a DIFFERENT block of the same height,
  // or at a height that was never sealed, is a far more serious one — that
  // would mean the stored history disagrees with itself rather than being
  // merely short.
  let detail = `height ${heightBefore} hash ${before.head.hash.slice(0, 12)}… stateRoot ${before.head.stateRoot.slice(0, 12)}…`;
  if (!sameHead) {
    const lost = heightBefore - heightAfter;
    detail =
      lost > 0n
        ? `lost the last ${lost} block(s): height ${heightBefore} -> ${heightAfter}. ` +
          (graceful
            ? "The shutdown was graceful, so this is a durability fault in the node: blocks whose receipts were already returned to a client did not survive db.Close()."
            : "The shutdown was ABRUPT (Node.js cannot signal a child process on Windows), and go-ethereum's Pebble wrapper commits without fsync — so recently sealed blocks were still buffered. See RUNNING-GATES §12."
          )
        : `head changed without losing height: ${heightBefore} ${before.head.hash.slice(0, 12)}… -> ${heightAfter} ${after.head.hash.slice(0, 12)}…`;
  }

  check("the chain comes back at the same head after a restart", sameHead, detail);
  check(
    "the election result survives the restart",
    after.counts.join("/") === before.counts.join("/"),
    `${before.counts.join("/")} -> ${after.counts.join("/")}`,
  );

  const restartLog = node.logLines.slice(logMark);
  const recovered = restartLog.some((l) => l.includes("chain head recovered"));
  check(
    "the restarted node logs a recovered head",
    recovered,
    recovered ? "chain head recovered" : `no such line in the ${restartLog.length} lines the restart produced`,
  );

  return { head: before.head, expectedHeight: heightBefore };
}

/**
 * Replay the whole election from genesis with the independent auditor.
 *
 * This is the claim the FYP report rests on: an observer who trusts nothing
 * but the block list can re-derive every state root, including the one
 * produced by verifying a zero-knowledge proof, and get the same answer.
 */
async function runAudit(node, expectedHeight = null) {
  await node.stop();

  if (!existsSync(AUDIT_BINARY)) {
    skip("cmd/audit replays the whole election", `audit binary not found at ${AUDIT_BINARY} (make build-audit)`);
    return null;
  }

  const result = await new Promise((resolve, reject) => {
    const proc = spawn(AUDIT_BINARY, ["-data-dir", node.dataDir], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    proc.stdout.on("data", (c) => out.push(c.toString()));
    proc.stderr.on("data", (c) => out.push(c.toString()));
    proc.once("error", reject);
    proc.once("exit", (code) => resolve({ code, text: out.join("").trim() }));
  });

  const line = result.text.split("\n").find((l) => l.startsWith("AUDIT")) ?? result.text;
  check("cmd/audit replays the chain", result.code === 0 && line.startsWith("AUDIT OK"), line);

  // "AUDIT OK" alone is not the claim M14 makes. A chain that lost its last
  // blocks is perfectly self-consistent and audits clean — it simply no longer
  // contains the election. So the height the auditor reports has to match the
  // height the election actually reached, or the headline result is a green
  // tick over a shorter story than the one the checks above told.
  if (expectedHeight !== null) {
    const audited = line.match(/height=(\d+)/);
    const auditedHeight = audited ? BigInt(audited[1]) : null;
    check(
      "the audited chain is the one the election ran on",
      auditedHeight === expectedHeight,
      auditedHeight === null
        ? "could not read a height from the audit line"
        : `audited height ${auditedHeight}, election reached ${expectedHeight}`,
    );
  }
  return line;
}

// ---------------------------------------------------------------------------
// Orchestration

function parseArgs(argv) {
  const opts = {
    rpcUrl: null,
    network: "custom",
    chainId: null,
    deploy: true,
    quiet: false,
    keepNode: false,
    allowSingleNetwork: false,
    // null = decide from whether we own the chain (see main()).
    resetDeployments: null,
  };
  for (const arg of argv) {
    if (arg === "--no-deploy") opts.deploy = false;
    else if (arg === "--quiet") opts.quiet = true;
    else if (arg === "--keep-node") opts.keepNode = true;
    else if (arg === "--allow-single-network") opts.allowSingleNetwork = true;
    else if (arg === "--reset-deployments") opts.resetDeployments = true;
    else if (arg === "--no-reset-deployments") opts.resetDeployments = false;
    else if (arg.startsWith("--rpc-url=")) opts.rpcUrl = arg.slice("--rpc-url=".length);
    else if (arg.startsWith("--network=")) opts.network = arg.slice("--network=".length);
    else if (arg.startsWith("--chain-id=")) opts.chainId = Number(arg.slice("--chain-id=".length));
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const managed = opts.rpcUrl === null;

  section("preflight");
  const votingArtifact = loadArtifact("contracts/Voting.sol/Voting.json");
  pass("contract artifacts are compiled", "packages/hardhat/artifacts");
  const circuit = loadCircuit();
  pass("the compiled circuit is readable", `${(circuit.bytecode.length / 1024).toFixed(0)} KB of bytecode`);

  const missingDeps = missingProverDependencies();
  if (missingDeps.length > 0) {
    throw new Error(
      `the proving stack is not installed: ${missingDeps.join(", ")}\n` +
        `Install it first:  make diff-install   (raw: cd e2e && npm install)\n` +
        `Checked here rather than at the proof step, which is several minutes into the run.`,
    );
  }
  pass("the proving stack is installed", "@noir-lang/noir_js, @aztec/bb.js");

  if (opts.deploy && !opts.allowSingleNetwork) {
    const problem = requireOtherNetworkDeployment(opts.network);
    if (problem) throw new Error(problem);
    pass("both networks' deployment records exist", "deployedContracts.ts will keep 31337 and 9494");
  }

  let node = null;
  let completed = false;
  let rpcUrl = opts.rpcUrl;
  let chainId = opts.chainId;

  if (managed) {
    section("a fresh chain");
    node = new ElectionNode({ quiet: opts.quiet, ...(chainId ? { chainId } : {}) });
    node.reset();
    await node.start();
    rpcUrl = node.rpcUrl;
    chainId = node.chainId;
    pass("a fresh node is running", `${rpcUrl}, data ${node.dataDir}`);
  } else {
    chainId = chainId ?? Number(BigInt(await rpc(rpcUrl, "eth_chainId")));
    pass("driving an externally managed chain", `${rpcUrl} (chain id ${chainId})`);
  }

  const chain = defineChain({
    id: chainId,
    name: "Election Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const ctx = {
    rpcUrl,
    chainId,
    circuit,
    prove: generateVoteProof,
    publicClient: createPublicClient({ chain, transport: http(rpcUrl) }),
  };

  const onChainId = Number(BigInt(await rpc(rpcUrl, "eth_chainId")));
  check("the node reports the expected chain id", onChainId === chainId, String(onChainId));

  try {
    if (opts.deploy) {
      // Default: discard the network's deployment records whenever we created
      // the chain, because they describe a chain that no longer exists. On a
      // chain someone else is running (--rpc-url) reuse is legitimate, so the
      // default flips. See runDeploy().
      const reset = opts.resetDeployments ?? managed;
      section(`yarn deploy --network ${opts.network}${reset ? " --reset" : ""}`);
      const started = Date.now();
      await runDeploy(opts.network, rpcUrl, chainId, opts.quiet, reset);
      timings.deployMs = Date.now() - started;
      pass("the real deploy scripts complete", `${(timings.deployMs / 1000).toFixed(1)} s${reset ? ", records reset" : ""}`);
    } else {
      skip("the real deploy scripts complete", "--no-deploy");
    }

    const registryRecord = loadDeployment(opts.network, "ElectionRegistry");
    const registry = { address: registryRecord.address, abi: registryRecord.abi };
    const divisions = await reader(ctx, registry.address, registry.abi)("getAllDivisions");
    check("the registry lists the deployed divisions", divisions.length >= 1, `${divisions.length} divisions`);

    const division = divisions[0];
    const voting = { address: division.votingContract, abi: votingArtifact.abi };
    console.log(`\nDriving division "${division.name}" at ${voting.address}\n`);

    section("admin lifecycle (election authority)");
    await ensureSetupPhase(ctx, voting);
    await runAdminLifecycle(ctx, voting);

    section("GN officer enrols the electorate");
    const nicRegistryRecord = loadDeployment(opts.network, "NicRegistry");
    const nicRegistry = { address: nicRegistryRecord.address, abi: nicRegistryRecord.abi };
    await runGnEnrolment(ctx, voting, nicRegistry);

    section("the voters register");
    const { voter } = await runRegistration(ctx, voting);
    if (!voter) throw new Error("registration did not complete; see the failing check above");

    const write = writer(ctx, voting.address, voting.abi);
    await write(OWNER, "startVoting", [VOTING_SECONDS]);
    check("admin opens voting", Number(await reader(ctx, voting.address, voting.abi)("currentPhase")) === 2);

    section("Merkle path from public chain data");
    const path = await buildPath(ctx, voting, voter);

    section("zero-knowledge proof");
    const voteArgs = await proveVote(ctx, path, voter);

    section("the anonymous vote");
    const countsBefore = (await reader(ctx, voting.address, voting.abi)("getVoteCounts")).map((c) => Number(c));
    const { receipt } = await castVote(ctx, voting, voteArgs);
    await assertOutcome(ctx, voting, receipt, voteArgs, countsBefore);
    await assertDoubleVoteRejected(ctx, voting, voteArgs);

    section("closing the election");
    await closeElection(ctx, voting, registry);

    if (managed) {
      section("durability");
      const { expectedHeight } = await assertRestartPreservesState(ctx, node, voting);
      timings.auditLine = await runAudit(node, expectedHeight);
    } else {
      skip("the chain comes back at the same head after a restart", "not managing the node (--rpc-url)");
      skip("cmd/audit replays the chain", "not managing the node (--rpc-url)");
    }
    completed = true;
  } finally {
    // Reported from the finally so that a run which dies part-way still prints
    // what it managed to establish — the checks before the failure are exactly
    // the context needed to read it. `completed` is what stops that partial
    // report from announcing PASS: an election that threw at the proof step has
    // no failed checks, and without this it would end on the word "PASS"
    // immediately above its own stack trace.
    if (node && !opts.keepNode) await node.stop();
    else if (node?.proc) console.log(`\nnode left running at ${node.rpcUrl} (--keep-node)`);
    report(completed);
  }
}

function report(completed) {
  const passed = steps.filter((s) => s.ok).length;
  const failed = steps.filter((s) => s.ok === false).length;
  const skipped = steps.filter((s) => s.skipped).length;

  console.log("\n--- numbers for the report ---");
  if (timings.deployMs) console.log(`  deploy (yarn deploy)      ${(timings.deployMs / 1000).toFixed(1)} s`);
  if (timings.witnessMs) console.log(`  witness generation        ${timings.witnessMs} ms`);
  if (timings.proveMs) console.log(`  UltraHonk proof           ${(timings.proveMs / 1000).toFixed(1)} s`);
  if (timings.voteMs) console.log(`  vote submit -> receipt     ${timings.voteMs} ms`);
  if (timings.auditLine) console.log(`  audit                     ${timings.auditLine}`);

  console.log(`\n${steps.length} checks: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (!completed) {
    console.log("\nINCOMPLETE — the run aborted before the last phase; the error follows");
    process.exitCode = 2;
  } else if (failed > 0) {
    console.log("\nFAIL");
    process.exitCode = 1;
  } else {
    console.log("\nPASS");
  }
}

// Only run when invoked directly. The phases below are also imported by
// control runs that drive a subset of them, and a module that starts an
// election on import would make that impossible.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    if (process.env.E2E_STACK === "1") console.error(err.stack);
    process.exit(2);
  });
}

// Exported so the phases can be driven individually — used by the offline
// control runs, and the reason each phase is a named function rather than a
// paragraph of main().
export {
  assertDoubleVoteRejected,
  assertOutcome,
  assertRestartPreservesState,
  buildPath,
  castVote,
  closeElection,
  ensureSetupPhase,
  proveVote,
  runAdminLifecycle,
  runAudit,
  runGnEnrolment,
  runRegistration,
  sendTx,
  rpc,
  reader,
  writer,
  decodeRevert,
  OWNER,
  GN_OFFICER,
  ELECTORATE,
  VOTING_LEAF,
  CANDIDATES,
  CHOSEN_CANDIDATE,
};
