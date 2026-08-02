#!/usr/bin/env node
/**
 * M11 acceptance harness — the Next.js API surface against a live chain.
 *
 * The milestone's gate is otherwise a browser walkthrough, which proves nothing
 * repeatably. These are the same reads the pages and the mobile app make, driven
 * over HTTP and checked field by field. It is backend-agnostic on purpose: run
 * it once in Hardhat mode and once in custom mode and the output should be
 * structurally identical. That equivalence *is* the milestone.
 *
 *   Custom mode:
 *     packages/blockchain$ make run-dev
 *     $ yarn deploy --network custom
 *     packages/nextjs$ yarn dev            # .env.local = custom column
 *     packages/nextjs$ CHECK_CHAIN_ID=9494 CHECK_RPC_URL=http://127.0.0.1:9545 \
 *                      node e2e/frontend-check.mjs
 *
 *   Hardhat mode:
 *     $ yarn chain && yarn deploy && (cd packages/nextjs && yarn dev)
 *     packages/nextjs$ node e2e/frontend-check.mjs
 *
 * Flags / env:
 *   APP_URL        (default http://127.0.0.1:3000)  the running Next.js server
 *   CHECK_RPC_URL  (default http://127.0.0.1:8545)  the node, read directly for cross-checks
 *   CHECK_CHAIN_ID (default 31337)                  the chain id the app must report
 *   --strict                                        treat SKIPs as failures
 *
 * The `CHECK_` prefix is deliberate. These were once called `RPC_URL` and
 * `CHAIN_ID` — the same names the *app server* reads from `.env.local`. On
 * Windows, `set RPC_URL=...` persists for the console session, so a `yarn dev`
 * later started from that same window inherited it, and process env outranks
 * `.env.local`. The result was a server reading contract addresses for one chain
 * while sending calls to the other: a hybrid configuration that looks like a code
 * bug and isn't. Distinct names make the collision impossible.
 *
 * Checks that depend on election data (a registered commitment, a cast vote)
 * SKIP with an explanation when the chain has none, rather than failing — a
 * freshly deployed chain legitimately has neither. `--strict` turns those into
 * failures for a full-flow run (M14).
 */
import { createPublicClient, http, parseAbiItem } from "viem";

// `||`, not `??`: an env var set to the empty string must fall back. `FOO=` in a
// .env file, and `set FOO=` on Windows, both yield "" rather than undefined.
const APP_URL = (process.env.APP_URL?.trim() || "http://127.0.0.1:3000").replace(/\/$/, "");
const RPC_URL = process.env.CHECK_RPC_URL?.trim() || "http://127.0.0.1:8545";
const EXPECTED_CHAIN_ID = Number(process.env.CHECK_CHAIN_ID?.trim() || 31337);
const STRICT = process.argv.includes("--strict");

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

/** Asserts a condition, attributing the result to a named check. */
const check = (name, condition, detail = "") => (condition ? pass(name, detail) : fail(name, detail || "assertion failed"));

const getJson = async (path, init) => {
  const res = await fetch(`${APP_URL}${path}`, init);
  let body;
  try {
    body = await res.json();
  } catch {
    body = { error: "<non-JSON response>" };
  }
  return { status: res.status, body };
};

const client = createPublicClient({ transport: http(RPC_URL) });

// ── preflight ───────────────────────────────────────────────────────────────

const preflight = async () => {
  // `RPC_URL` / `NEXT_PUBLIC_*` in this console are almost certainly also set in
  // the one running `yarn dev`, where they silently override `.env.local`.
  const leaked = ["RPC_URL", "NEXT_PUBLIC_RPC_URL", "NEXT_PUBLIC_CHAIN_ID", "NEXT_PUBLIC_CHAIN_BACKEND"].filter(
    name => process.env[name],
  );
  if (leaked.length) {
    console.warn("WARNING: these app-server variables are set in this shell:");
    for (const name of leaked) console.warn(`  ${name}=${process.env[name]}`);
    console.warn(
      "They do not configure this harness (it uses CHECK_RPC_URL / CHECK_CHAIN_ID),\n" +
        "but if `yarn dev` was started from a shell that had them, they overrode\n" +
        ".env.local there. Start the dev server from a clean window.\n",
    );
  }

  try {
    const chainId = await client.getChainId();
    if (chainId !== EXPECTED_CHAIN_ID) {
      console.error(
        `The node at ${RPC_URL} reports chain ${chainId}, but CHECK_CHAIN_ID=${EXPECTED_CHAIN_ID}.\n` +
          `Point CHECK_RPC_URL/CHECK_CHAIN_ID at the same chain the app is configured for.`,
      );
      process.exit(2);
    }
  } catch (e) {
    console.error(`Cannot reach the node at ${RPC_URL}: ${e.shortMessage ?? e.message}`);
    console.error("Start it first (`yarn chain`, or `make run-dev` in packages/blockchain).");
    process.exit(2);
  }

  try {
    const res = await fetch(`${APP_URL}/api/election`);
    if (res.status >= 500) {
      console.error(`The app at ${APP_URL} answered ${res.status} on /api/election.`);
      console.error("Read the URL in its terminal's stack trace before anything else:");
      console.error(`  - not ${RPC_URL}?  the server's env disagrees with this harness (see above)`);
      console.error(`  - ${RPC_URL}, ECONNREFUSED?  the node isn't running`);
      console.error(`  - ${RPC_URL}, reachable?  the contracts aren't deployed on this chain`);
    }
  } catch (e) {
    console.error(`Cannot reach the Next.js server at ${APP_URL}: ${e.message}`);
    console.error("Start it with `yarn dev` in packages/nextjs.");
    process.exit(2);
  }
};

// ── /api/election ───────────────────────────────────────────────────────────

const checkElection = async () => {
  const { status, body } = await getJson("/api/election");
  check("GET /api/election responds 200", status === 200, `status=${status} ${body.error ?? ""}`);
  if (status !== 200) return null;

  check(
    "election reports the configured chain id",
    body.chainId === EXPECTED_CHAIN_ID,
    `reported=${body.chainId} expected=${EXPECTED_CHAIN_ID}`,
  );
  check("election names a deployed ElectionRegistry", /^0x[0-9a-fA-F]{40}$/.test(body.registry ?? ""), `registry=${body.registry}`);
  check("election lists at least one division", (body.divisions?.length ?? 0) > 0, `divisionCount=${body.divisionCount}`);
  if (!body.divisions?.length) return body;

  check(
    "divisionCount matches the divisions array",
    body.divisionCount === body.divisions.length,
    `${body.divisionCount} vs ${body.divisions.length}`,
  );

  const unreachable = body.divisions.filter(d => d.phaseLabel === "Unreachable");
  check(
    "every division's Voting contract is readable",
    unreachable.length === 0,
    unreachable.length ? `unreachable: ${unreachable.map(d => d.name).join(", ")}` : `${body.divisions.length} readable`,
  );

  const misaligned = body.divisions.filter(d => d.candidates.length !== d.voteCounts.length);
  check(
    "candidates and voteCounts are index-aligned",
    misaligned.length === 0,
    misaligned.length ? `misaligned: ${misaligned.map(d => d.name).join(", ")}` : "all divisions",
  );

  const badTotals = body.divisions.filter(d => d.voteCounts.reduce((s, c) => s + c, 0) !== d.totalVotes);
  check("each division's totalVotes equals the sum of its counts", badTotals.length === 0, badTotals.map(d => d.name).join(", "));

  const nationalSum = body.divisions.reduce((s, d) => s + d.totalVotes, 0);
  check(
    "national totalVotes aggregates the divisions",
    body.national.totalVotes === nationalSum,
    `national=${body.national.totalVotes} sum=${nationalSum}`,
  );

  const filterTarget = body.divisions[0].votingContract;
  const filtered = await getJson(`/api/election?division=${filterTarget}`);
  check(
    "?division= filters to a single division",
    filtered.status === 200 && filtered.body.divisions?.length === 1 && filtered.body.divisions[0].votingContract === filterTarget,
    `status=${filtered.status} count=${filtered.body.divisions?.length}`,
  );

  return body;
};

// ── /api/merkle-path ────────────────────────────────────────────────────────

const NEW_LEAF_EVENT = parseAbiItem("event NewLeaf(uint256 index, uint256 value)");

const checkMerklePath = async election => {
  const missing = await getJson("/api/merkle-path");
  check("merkle-path rejects a missing division", missing.status === 400, `status=${missing.status}`);

  const noCommitment = await getJson(`/api/merkle-path?division=${election.divisions[0].votingContract}`);
  check("merkle-path rejects a missing commitment", noCommitment.status === 400, `status=${noCommitment.status}`);

  const withLeaves = election.divisions.find(d => d.registeredVoters > 0);
  if (!withLeaves) {
    return skip("merkle-path returns a proof for a registered commitment", "no division has any registered voters yet");
  }

  const logs = await client.getLogs({
    address: withLeaves.votingContract,
    event: NEW_LEAF_EVENT,
    fromBlock: 0n,
    toBlock: "latest",
  });
  if (logs.length === 0) {
    return fail(
      "merkle-path returns a proof for a registered commitment",
      `division ${withLeaves.name} reports ${withLeaves.registeredVoters} registered voters but emitted no NewLeaf logs — eth_getLogs disagrees with eth_call`,
    );
  }

  const commitment = logs[logs.length - 1].args.value.toString();
  const { status, body } = await getJson(
    `/api/merkle-path?division=${withLeaves.votingContract}&commitment=${commitment}`,
  );
  check("merkle-path returns a proof for a registered commitment", status === 200, `status=${status} ${body.error ?? ""}`);
  if (status !== 200) return;

  check("proof siblings are padded to the circuit depth of 16", body.siblings?.length === 16, `length=${body.siblings?.length}`);
  check("proof carries a derived circuit index", Number.isInteger(body.circuitIndex) && body.circuitIndex >= 0, `circuitIndex=${body.circuitIndex}`);
  check("proof treeSize matches the on-chain tree", body.treeSize === withLeaves.registeredVoters, `${body.treeSize} vs ${withLeaves.registeredVoters}`);
  check(
    "server-rebuilt root matches the contract's root",
    body.root === withLeaves.root,
    `rebuilt=${body.root} onChain=${withLeaves.root}`,
  );

  const unknown = await getJson(`/api/merkle-path?division=${withLeaves.votingContract}&commitment=1`);
  check("merkle-path 404s on a commitment that is not in the tree", unknown.status === 404, `status=${unknown.status}`);
};

// ── /api/verify-vote ────────────────────────────────────────────────────────

const VOTE_CAST_EVENT = parseAbiItem(
  "event VoteCast(bytes32 indexed nullifierHash, address indexed voter, uint256 indexed candidate, uint256 timestamp, uint256 newCount)",
);

const checkVerifyVote = async election => {
  const missing = await getJson("/api/verify-vote");
  check("verify-vote rejects missing params", missing.status === 400, `status=${missing.status}`);

  const division = election.divisions[0];
  const unusedNullifier = `0x${"11".repeat(32)}`;
  const unused = await getJson(`/api/verify-vote?division=${division.votingContract}&nullifierHash=${unusedNullifier}`);
  check(
    "verify-vote reports an unused nullifier as not found",
    unused.status === 200 && unused.body.found === false,
    `status=${unused.status} found=${unused.body.found}`,
  );

  const voted = election.divisions.find(d => d.totalVotes > 0);
  if (!voted) {
    return skip("verify-vote resolves a real vote to its candidate", "no votes cast on this chain yet");
  }

  const logs = await client.getLogs({
    address: voted.votingContract,
    event: VOTE_CAST_EVENT,
    fromBlock: 0n,
    toBlock: "latest",
  });
  if (logs.length === 0) {
    return fail(
      "verify-vote resolves a real vote to its candidate",
      `division ${voted.name} reports ${voted.totalVotes} votes but emitted no VoteCast logs`,
    );
  }

  const { nullifierHash, candidate } = logs[0].args;
  const { status, body } = await getJson(
    `/api/verify-vote?division=${voted.votingContract}&nullifierHash=${nullifierHash}`,
  );
  check("verify-vote resolves a real vote to its candidate", status === 200 && body.found === true, `status=${status} found=${body.found}`);
  if (status !== 200 || !body.found) return;

  check("verify-vote returns the candidate index from the log", body.candidateIndex === Number(candidate), `${body.candidateIndex} vs ${candidate}`);
  check(
    "verify-vote resolves the candidate name from the contract",
    body.candidate === voted.candidates[Number(candidate)],
    `${body.candidate} vs ${voted.candidates[Number(candidate)]}`,
  );
};

// ── /api/faucet ─────────────────────────────────────────────────────────────

const checkFaucet = async () => {
  const bad = await getJson("/api/faucet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: "not-an-address" }),
  });
  check("faucet rejects a malformed address", bad.status === 400, `status=${bad.status}`);

  // A deterministic, otherwise-unused address per run so the balance delta is unambiguous.
  const target = `0x${Date.now().toString(16).padStart(40, "0").slice(-40)}`;
  const before = await client.getBalance({ address: target });

  const { status, body } = await getJson("/api/faucet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: target }),
  });

  if (status === 403) {
    return skip(
      "faucet funds an address on this chain",
      `disabled for chain ${EXPECTED_CHAIN_ID} (allowed: ${(body.allowedChainIds ?? []).join(", ") || "none"})`,
    );
  }

  check("faucet funds an address on this chain", status === 200 && body.funded === true, `status=${status} ${body.error ?? ""}`);
  if (status !== 200) return;

  await client.waitForTransactionReceipt({ hash: body.txHash });
  const after = await client.getBalance({ address: target });
  check("the funded balance actually increased on chain", after > before, `${before} → ${after}`);
};

// ── run ─────────────────────────────────────────────────────────────────────

const main = async () => {
  console.log(`app=${APP_URL} rpc=${RPC_URL} chainId=${EXPECTED_CHAIN_ID}${STRICT ? " [strict]" : ""}\n`);
  await preflight();

  const election = await checkElection();
  if (election?.divisions?.length) {
    await checkMerklePath(election);
    await checkVerifyVote(election);
  } else {
    skip("merkle-path checks", "no divisions to read");
    skip("verify-vote checks", "no divisions to read");
  }
  await checkFaucet();

  const total = passed + failed + skipped;
  console.log(`\n${total} checks: ${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log(failed === 0 ? "PASS" : "FAIL");
  process.exit(failed === 0 ? 0 : 1);
};

main().catch(e => {
  console.error("\nharness crashed:", e);
  process.exit(3);
});
