#!/usr/bin/env node
// Differential dev/compat-method harness (MASTER blockchain-v2 M07).
//
// Companion to diff.mjs (M04 reads), write.mjs (M05 writes) and logs.mjs
// (M06 eth_getLogs). This one covers the non-standard methods the Hardhat
// contract test suite and dev tooling need:
//
//   evm_increaseTime, evm_setNextBlockTimestamp, evm_mine,
//   hardhat_setBalance / anvil_setBalance
//
// It exists because Hardhat is *inconsistent* about how these encode their
// return values — two return decimal strings, one a hex quantity, one a
// boolean — and internal/rpc/dev.go reproduces that inconsistency from
// knowledge of Hardhat's source rather than from observation (the agent that
// wrote M07 had no Go or Hardhat toolchain). This script is the observation.
// Where it disagrees with dev.go, the script is right.
//
// Usage:
//   HARDHAT_URL=http://127.0.0.1:8545 node dev.mjs
// or, from packages/blockchain: `make diff-dev HARDHAT_URL=http://127.0.0.1:8545`
//
// Our node must be running with DEV_RPC=true, otherwise every method here is
// -32601 and the run fails immediately with a clear message.
//
// Unlike the other harnesses this one does NOT require freshly-started
// chains: every check is relative (a delta, or a value read back from an
// address this script itself writes), so it is safe to re-run.
//
// Checks:
//   a) evm_increaseTime return encoding + accumulation
//   b) evm_increaseTime with a bare JSON number (what the hardhat test suite sends)
//   c) evm_increaseTime actually shifts the next block's timestamp
//   d) evm_mine return encoding, height advance, and empty-block shape
//   e) evm_mine with an explicit timestamp
//   f) evm_setNextBlockTimestamp return encoding + exact pin
//   g) evm_setNextBlockTimestamp rejects a non-increasing timestamp
//   h) hardhat_setBalance return encoding + eth_getBalance readback
//   i) anvil_setBalance alias behaves identically
//   j) a value wider than 64 bits round-trips through setBalance

const OUR_URL = process.env.OUR_URL ?? "http://127.0.0.1:9545";
const HARDHAT_URL = process.env.HARDHAT_URL;

if (!HARDHAT_URL) {
  console.error("HARDHAT_URL is required, e.g.:\n  HARDHAT_URL=http://127.0.0.1:8545 node dev.mjs");
  process.exit(2);
}

// A burn address neither chain's deploy scripts ever touch, so writing to it
// cannot perturb any other harness sharing the same node.
const TARGET = "0x000000000000000000000000000000000000dEaD";

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

// compare is the workhorse: it asserts our value equals hardhat's, and
// reports the pair on failure in the `our=… hardhat=…` shape the other
// harnesses use (RUNNING-GATES.md §4 tells the reader that diff *is* the fix
// instruction).
function compare(name, ourValue, theirValue, extra) {
  const ours = JSON.stringify(ourValue);
  const theirs = JSON.stringify(theirValue);
  if (ours === theirs) {
    pass(name, `both ${ours}${extra ? " — " + extra : ""}`);
  } else {
    fail(name, `our=${ours} hardhat=${theirs}${extra ? " — " + extra : ""}`);
  }
}

// compareExpecting is compare() for checks whose value is a *verdict* rather
// than an encoding — "did the timestamp actually move", "was this rejected".
// For those, agreement is not enough: two backends that both fail the same
// way agree perfectly, and plain compare() reports that as a PASS.
//
// That is not hypothetical. Check (c) below originally used compare() and
// printed "[PASS] both false" on a run where *neither* backend had shifted
// its timestamp — the harness was silently broken and said so in green.
// Every boolean/count check therefore states the value it expects.
function compareExpecting(name, ourValue, theirValue, want, extra) {
  const ours = JSON.stringify(ourValue);
  const theirs = JSON.stringify(theirValue);
  const expected = JSON.stringify(want);
  const detail = `our=${ours} hardhat=${theirs} expected=${expected}${extra ? " — " + extra : ""}`;

  if (ours === expected && theirs === expected) {
    pass(name, detail);
  } else {
    fail(name, detail);
  }
}

// ---------------------------------------------------------------------------
// Raw JSON-RPC
//
// Deliberately hand-rolled rather than going through viem: this file is
// *about* the exact JSON a method returns, and viem's transport would
// normalise some of it away (and refuses to model non-standard methods
// cleanly in the first place).

async function rpc(url, method, params = []) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch (cause) {
    // Node reports an unreachable server as a bare "TypeError: fetch
    // failed" whose real cause is buried in .cause — useless on its own.
    // Re-throw something that names the URL and says what to start.
    const err = new Error(`cannot reach ${url} (${cause.cause?.code ?? cause.message})`);
    err.unreachable = url;
    throw err;
  }
  const body = await res.json();
  if (body.error) {
    const err = new Error(`${method}: ${body.error.message}`);
    err.rpc = body.error;
    throw err;
  }
  return body.result;
}

// tryRpc returns {ok, value|error} instead of throwing, for the checks that
// expect a rejection. A transport failure (server not running) is reported
// with `unreachable` set, so callers can tell "the node said no" apart from
// "there is no node" — checkPreconditions branches on exactly that.
async function tryRpc(url, method, params = []) {
  try {
    return { ok: true, value: await rpc(url, method, params) };
  } catch (err) {
    if (err.unreachable) {
      return { ok: false, error: { message: err.message, unreachable: err.unreachable } };
    }
    return { ok: false, error: err.rpc ?? { message: String(err) } };
  }
}

const blockNumber = async (url) => Number(await rpc(url, "eth_blockNumber"));

async function blockAt(url, n) {
  return rpc(url, "eth_getBlockByNumber", ["0x" + n.toString(16), false]);
}

async function latestBlock(url) {
  return rpc(url, "eth_getBlockByNumber", ["latest", false]);
}

// ---------------------------------------------------------------------------
// Checks

// Both backends are driven through the same function so a check can never
// accidentally exercise different call sequences on the two chains — the
// failure mode that makes a differential harness lie.
async function onBoth(fn) {
  return { ours: await fn(OUR_URL), theirs: await fn(HARDHAT_URL) };
}

// typeShape describes a value the way this harness cares about it: the
// JS type, plus whether a string looks like a hex quantity or a decimal
// number. Two backends can legitimately return different *numbers* here
// (accumulated offsets differ between chains) while still having to agree on
// the encoding.
function typeShape(v) {
  if (typeof v !== "string") return typeof v;
  if (/^0x[0-9a-fA-F]+$/.test(v)) return "hex-quantity-string";
  // The optional sign is not cosmetic: evm_increaseTime's accumulated total
  // is legitimately negative once a block has been pinned below wall clock,
  // and classifying "-1784995400" as some other shape would make this
  // harness report a spurious encoding mismatch.
  if (/^-?\d+$/.test(v)) return "decimal-string";
  return "other-string";
}

async function checkPreconditions() {
  // Reachability first, and for BOTH nodes, before anything interprets a
  // response. This harness needs three terminals — our node, a hardhat
  // node, and itself — and forgetting the hardhat one is the single easiest
  // mistake to make. It used to surface as an unhandled "TypeError: fetch
  // failed" stack trace with the real cause buried two levels down.
  for (const [label, url, howToStart] of [
    ["our node", OUR_URL, "cd packages/blockchain  &&  make run-dev"],
    ["hardhat node", HARDHAT_URL, "cd to the repo root  &&  yarn chain"],
  ]) {
    const reachable = await tryRpc(url, "eth_blockNumber", []);
    if (!reachable.ok && reachable.error.unreachable) {
      console.error(
        `\nThe ${label} at ${url} is not running.\n\n` +
          `Start it in its own terminal:\n  ${howToStart}\n\n` +
          `This harness needs three terminals: our node, a hardhat node, and itself.\n`,
      );
      process.exit(2);
    }
  }

  const probe = await tryRpc(OUR_URL, "evm_mine", []);
  if (!probe.ok && probe.error.code === -32601) {
    console.error(
      "\nOur node answered -32601 for evm_mine: it is running without DEV_RPC=true.\n" +
        "Restart it as:  make run-dev\n",
    );
    process.exit(2);
  }
  if (!probe.ok) {
    console.error(`\nOur node rejected evm_mine: ${JSON.stringify(probe.error)}\n`);
    process.exit(2);
  }
  await rpc(HARDHAT_URL, "evm_mine", []);
  info("preconditions", "both nodes reachable and answering evm_mine");
}

async function checkIncreaseTime() {
  // (a) return encoding. The absolute values differ between chains (each has
  // its own accumulated offset), so the *encoding* is compared for equality
  // and the accumulation is checked per-chain.
  const first = await onBoth((url) => rpc(url, "evm_increaseTime", ["0xe10"])); // 3600
  compare(
    "(a) evm_increaseTime return encoding",
    typeShape(first.ours),
    typeShape(first.theirs),
    `our=${JSON.stringify(first.ours)} hardhat=${JSON.stringify(first.theirs)}`,
  );

  // The absolute totals differ between backends by a second or so — Hardhat
  // seeds its offset from the last block's timestamp rather than from wall
  // clock — so the *delta* is what has to match, not the value.
  const second = await onBoth((url) => rpc(url, "evm_increaseTime", ["0xe10"]));
  const accumulated = (before, after) => Number(after) - Number(before) === 3600;
  compareExpecting(
    "(a) evm_increaseTime accumulates by the requested amount",
    accumulated(first.ours, second.ours),
    accumulated(first.theirs, second.theirs),
    true,
    `our ${first.ours}->${second.ours}, hardhat ${first.theirs}->${second.theirs}`,
  );

  // (b) the form `packages/hardhat/test/Voting.ts` actually sends:
  // ethers.provider.send("evm_increaseTime", [3601]) — a bare JSON number,
  // not a hex quantity string. This is the single most load-bearing check in
  // the file: if our node rejects it, the M08 hardhat test run cannot pass.
  const bare = await onBoth((url) => tryRpc(url, "evm_increaseTime", [3601]));
  compareExpecting(
    "(b) evm_increaseTime accepts a bare JSON number",
    bare.ours.ok,
    bare.theirs.ok,
    true,
    bare.ours.ok ? "" : `our error=${JSON.stringify(bare.ours.error)}`,
  );

  // (c) the effect that matters: the next sealed block's timestamp moves.
  const shifted = await onBoth(async (url) => {
    // Mine a baseline block FIRST. The checks above accumulated 7200s of
    // offset without sealing anything, so the current head predates that
    // offset entirely — measuring from it would report a delta of ~93600
    // against an expected 86400 and fail on both backends at once. (It did
    // exactly that on the first real run.) Sealing a block here folds the
    // accumulated offset into the baseline so the delta isolates the one
    // increment this check is about.
    await rpc(url, "evm_mine", []);
    const before = Number((await latestBlock(url)).timestamp);

    await rpc(url, "evm_increaseTime", [86400]);
    await rpc(url, "evm_mine", []);
    const after = Number((await latestBlock(url)).timestamp);

    // A range, not an equality: wall clock advances during the calls too.
    const delta = after - before;
    return { ok: delta >= 86400 && delta < 86400 + 120, delta };
  });
  compareExpecting(
    "(c) evm_increaseTime shifts the next block's timestamp",
    shifted.ours.ok,
    shifted.theirs.ok,
    true,
    `our delta=${shifted.ours.delta}s hardhat delta=${shifted.theirs.delta}s, want 86400..86520`,
  );
}

async function checkMine() {
  // (d) return encoding, plus the block it produces.
  const mined = await onBoth(async (url) => {
    const before = await blockNumber(url);
    const result = await rpc(url, "evm_mine", []);
    const after = await blockNumber(url);
    const block = await blockAt(url, after);
    return {
      result,
      advancedBy: after - before,
      txCount: block.transactions.length,
    };
  });

  compare("(d) evm_mine return encoding", typeShape(mined.ours.result), typeShape(mined.theirs.result),
    `our=${JSON.stringify(mined.ours.result)} hardhat=${JSON.stringify(mined.theirs.result)}`);
  compare("(d) evm_mine return value", mined.ours.result, mined.theirs.result);
  compareExpecting("(d) evm_mine advances the height by one", mined.ours.advancedBy, mined.theirs.advancedBy, 1);
  compareExpecting("(d) evm_mine seals an empty block", mined.ours.txCount, mined.theirs.txCount, 0);

  // (e) evm_mine with an explicit timestamp. Chosen relative to each chain's
  // own head so the two runs stay independent.
  const pinned = await onBoth(async (url) => {
    const head = Number((await latestBlock(url)).timestamp);
    const want = head + 5000;
    const result = await tryRpc(url, "evm_mine", [want]);
    if (!result.ok) return { accepted: false, exact: false };
    const got = Number((await latestBlock(url)).timestamp);
    return { accepted: true, exact: got === want };
  });
  compareExpecting("(e) evm_mine accepts an explicit timestamp", pinned.ours.accepted, pinned.theirs.accepted, true);
  compareExpecting("(e) evm_mine honours that timestamp exactly", pinned.ours.exact, pinned.theirs.exact, true);
}

async function checkSetNextBlockTimestamp() {
  // (f) return encoding + exact pin.
  const pinned = await onBoth(async (url) => {
    const head = Number((await latestBlock(url)).timestamp);
    const want = head + 4242;
    const result = await rpc(url, "evm_setNextBlockTimestamp", [want]);
    await rpc(url, "evm_mine", []);
    const got = Number((await latestBlock(url)).timestamp);
    return { result, want, exact: got === want, got };
  });

  compare(
    "(f) evm_setNextBlockTimestamp return encoding",
    typeShape(pinned.ours.result),
    typeShape(pinned.theirs.result),
    `our=${JSON.stringify(pinned.ours.result)} hardhat=${JSON.stringify(pinned.theirs.result)}`,
  );
  compareExpecting(
    "(f) evm_setNextBlockTimestamp returns the timestamp it was given",
    Number(pinned.ours.result) === pinned.ours.want,
    Number(pinned.theirs.result) === pinned.theirs.want,
    true,
    `our=${JSON.stringify(pinned.ours.result)} (wanted ${pinned.ours.want}), hardhat=${JSON.stringify(pinned.theirs.result)} (wanted ${pinned.theirs.want})`,
  );
  compareExpecting(
    "(f) evm_setNextBlockTimestamp pins the next block exactly",
    pinned.ours.exact,
    pinned.theirs.exact,
    true,
    `our got ${pinned.ours.got} (wanted ${pinned.ours.want}), hardhat got ${pinned.theirs.got} (wanted ${pinned.theirs.want})`,
  );

  // (g) a timestamp at or before the head must be rejected on both — the
  // strictly-increasing invariant MASTER §10 pitfall 7 relies on.
  const rejected = await onBoth(async (url) => {
    const head = Number((await latestBlock(url)).timestamp);
    const result = await tryRpc(url, "evm_setNextBlockTimestamp", [head]);
    return result.ok;
  });
  compareExpecting(
    "(g) evm_setNextBlockTimestamp rejects a non-increasing timestamp",
    rejected.ours,
    rejected.theirs,
    false,
    "the value is `call succeeded`, so false on both is the pass condition",
  );
}

async function checkSetBalance() {
  const ONE_ETHER = "0xde0b6b3a7640000";

  // (h) hardhat_setBalance: return encoding + readback.
  const set = await onBoth(async (url) => {
    const result = await rpc(url, "hardhat_setBalance", [TARGET, ONE_ETHER]);
    const balance = await rpc(url, "eth_getBalance", [TARGET, "latest"]);
    return { result, balance };
  });
  compareExpecting("(h) hardhat_setBalance return value", set.ours.result, set.theirs.result, true);
  compareExpecting("(h) hardhat_setBalance is visible via eth_getBalance", set.ours.balance, set.theirs.balance, ONE_ETHER);

  // The set-not-add semantic: writing the same value twice must leave the
  // same balance, and a *smaller* value must actually shrink it.
  const overwritten = await onBoth(async (url) => {
    await rpc(url, "hardhat_setBalance", [TARGET, "0x1"]);
    return rpc(url, "eth_getBalance", [TARGET, "latest"]);
  });
  compareExpecting("(h) hardhat_setBalance overwrites rather than adds", overwritten.ours, overwritten.theirs, "0x1");

  // (i) the anvil_ alias.
  //
  // This is deliberately NOT a two-sided diff. Hardhat does not implement
  // anvil_setBalance at all — it answers -32004 "Method anvil_setBalance is
  // not supported" — so there is nothing to compare against. (An earlier
  // version of this harness assumed parity here and crashed on that error
  // mid-run, losing checks (j) entirely.) The alias exists on our node
  // because MASTER §9 lists both spellings for Anvil-flavoured tooling; the
  // assertion is therefore just that ours works and matches our own
  // hardhat_setBalance.
  const aliasTheirs = await tryRpc(HARDHAT_URL, "anvil_setBalance", [TARGET, ONE_ETHER]);
  info(
    "(i) anvil_setBalance on hardhat",
    aliasTheirs.ok
      ? `supported, returned ${JSON.stringify(aliasTheirs.value)} — parity is now possible; consider making this a real diff`
      : `not supported (${aliasTheirs.error.message}) — ours-only by design, nothing to diff`,
  );

  const aliasOurs = await tryRpc(OUR_URL, "anvil_setBalance", [TARGET, ONE_ETHER]);
  if (!aliasOurs.ok) {
    fail("(i) anvil_setBalance works on our node", `error=${JSON.stringify(aliasOurs.error)}`);
  } else if (aliasOurs.value !== set.ours.result) {
    fail(
      "(i) anvil_setBalance returns the same as hardhat_setBalance on our node",
      `anvil=${JSON.stringify(aliasOurs.value)} hardhat=${JSON.stringify(set.ours.result)}`,
    );
  } else {
    const balance = await rpc(OUR_URL, "eth_getBalance", [TARGET, "latest"]);
    if (balance !== ONE_ETHER) {
      fail("(i) anvil_setBalance is visible via eth_getBalance", `balance=${balance} want=${ONE_ETHER}`);
    } else {
      pass("(i) anvil_setBalance is a faithful alias of hardhat_setBalance on our node", `both return ${JSON.stringify(aliasOurs.value)}, balance ${balance}`);
    }
  }

  // (j) a value wider than 64 bits — 10,000 ETH, what the genesis alloc and
  // the dev faucet actually deal in.
  const TEN_THOUSAND_ETHER = "0x21e19e0c9bab2400000";
  const wide = await onBoth(async (url) => {
    await rpc(url, "hardhat_setBalance", [TARGET, TEN_THOUSAND_ETHER]);
    return rpc(url, "eth_getBalance", [TARGET, "latest"]);
  });
  compareExpecting("(j) setBalance round-trips a value wider than 64 bits", wide.ours, wide.theirs, TEN_THOUSAND_ETHER);

  // Our node additionally records the mutation in the block's extraData
  // (MASTER §10 pitfall 10 — Hardhat has no equivalent, so this is a
  // one-sided assertion, not a diff).
  const head = await latestBlock(OUR_URL);
  const extra = head.extraData ?? "0x";
  const decoded = extra === "0x" ? "" : Buffer.from(extra.slice(2), "hex").toString("utf8");
  if (decoded.startsWith("sysop:setBalance:")) {
    pass("(j) our setBalance block records the operation in extraData", decoded);
  } else {
    fail(
      "(j) our setBalance block records the operation in extraData",
      `extraData=${JSON.stringify(extra)} decoded=${JSON.stringify(decoded)} — expected a "sysop:setBalance:…" encoding`,
    );
  }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`our node:     ${OUR_URL}`);
  console.log(`hardhat node: ${HARDHAT_URL}`);
  console.log("");

  await checkPreconditions();

  // Each group runs independently: an unexpected RPC error inside one must
  // not abort the whole run. The first real run of this harness crashed in
  // checkSetBalance and lost every check after it, which is exactly the
  // information you most want when something is unexpectedly missing.
  for (const check of [checkIncreaseTime, checkMine, checkSetNextBlockTimestamp, checkSetBalance]) {
    try {
      await check();
    } catch (err) {
      fail(`${check.name} crashed`, err.rpc ? JSON.stringify(err.rpc) : String(err));
    }
  }

  summarize();
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
    console.log("");
    console.log("Each `our=… hardhat=…` pair above is the fix instruction: internal/rpc/dev.go");
    console.log("must be changed to match the hardhat column.");
    process.exitCode = 1;
  } else {
    console.log("PASS");
  }
}

main().catch((err) => {
  console.error("dev harness crashed:", err);
  process.exit(1);
});
