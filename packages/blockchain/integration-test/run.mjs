// Stage 6 integration test (see PLAN.md).
//
// This script is a headless stand-in for a *browser* — it generates one real ZK
// proof using the exact libraries the real frontend uses (see
// packages/nextjs/app/voting/_components/{GenerateProof,CreateCommitment}.tsx,
// which this ports its proof-generation logic from almost verbatim). It is not
// part of the running node and never becomes backend code: packages/blockchain
// never sees a nullifier or secret, only a commitment (at registration) and
// later a proof + public inputs with no voter identity attached — that split is
// exactly what this test exists to exercise, not to change.
//
// Steps (mirrors PLAN.md's Stage 6 deliverable list exactly):
//   1. Start a Go node (embedded EVM)
//   2. Register voters via the REST API
//   3. Verify EVM state updates (check the Merkle root)
//   4. Submit a real, valid ZK proof
//   5. Verify the EVM rejects an invalid proof and a double-vote
//   6. Stop/start the node and verify state is perfectly reconstructed from blocks

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Fr, UltraHonkBackend } from "@aztec/bb.js";
import { Noir } from "@noir-lang/noir_js";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon1, poseidon2 } from "poseidon-lite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOCKCHAIN_DIR = path.resolve(__dirname, "..");
const CIRCUITS_PATH = path.resolve(__dirname, "../../nextjs/public/circuits.json");
const ASSETS_DIR = path.resolve(BLOCKCHAIN_DIR, "assets");
const NODE_ID = "9998";
const PORT = 9998;
const DATA_DIR = path.resolve(BLOCKCHAIN_DIR, `data_${NODE_ID}`);
const BASE_URL = `https://127.0.0.1:${PORT}`;
const BIN_PATH = path.resolve(BLOCKCHAIN_DIR, process.platform === "win32" ? "zk-node-integration-test.exe" : "zk-node-integration-test");

// ─── Logging & assertions ──────────────────────────────────────────────────────

function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ─── Certs & keys ───────────────────────────────────────────────────────────────

function generateCertsAndKeys() {
  const certsDir = path.join(DATA_DIR, "certs");
  const keysDir = path.join(DATA_DIR, "keys");
  fs.mkdirSync(certsDir, { recursive: true });
  fs.mkdirSync(keysDir, { recursive: true });

  const opensslEnv = { ...process.env, MSYS_NO_PATHCONV: "1" };

  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:4096", "-nodes",
      "-keyout", path.join(certsDir, "server.key"),
      "-out", path.join(certsDir, "server.crt"),
      "-days", "365", "-subj", "/CN=localhost",
    ],
    { stdio: "pipe", env: opensslEnv },
  );

  execFileSync("openssl", ["genrsa", "-out", path.join(keysDir, "admin_private.pem"), "2048"], {
    stdio: "pipe",
    env: opensslEnv,
  });
  execFileSync(
    "openssl",
    ["rsa", "-in", path.join(keysDir, "admin_private.pem"), "-pubout", "-out", path.join(keysDir, "admin_public.pem")],
    { stdio: "pipe", env: opensslEnv },
  );

  return {
    cert: fs.readFileSync(path.join(certsDir, "server.crt")),
    key: fs.readFileSync(path.join(certsDir, "server.key")),
    adminPrivateKey: fs.readFileSync(path.join(keysDir, "admin_private.pem"), "utf8"),
  };
}

// ─── Node process lifecycle ─────────────────────────────────────────────────────

function buildBinary() {
  log("setup", "Building node binary...");
  execFileSync("go", ["build", "-o", BIN_PATH, "./cmd/node"], { cwd: BLOCKCHAIN_DIR, stdio: "inherit" });
}

function spawnNode() {
  const child = spawn(BIN_PATH, [], {
    cwd: BLOCKCHAIN_DIR,
    env: {
      ...process.env,
      NODE_ID,
      ASSETS_DIR,
      PEERS: "",
      REQUIRE_EVM: "true",
    },
  });
  const logLines = [];
  child.stdout.on("data", d => logLines.push(d.toString()));
  child.stderr.on("data", d => logLines.push(d.toString()));
  child.logLines = logLines;
  return child;
}

function killNode(child) {
  if (!child || child.killed || child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    child.once("exit", resolve);
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  });
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const { status } = await httpsRequest("GET", "/health");
      if (status === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`node did not become healthy within ${timeoutMs}ms: ${lastErr}`);
}

// ─── HTTP client (mTLS + admin RSA signing) ─────────────────────────────────────

let clientCert, clientKey, adminPrivateKeyPem;

function httpsRequest(method, urlPath, bodyStr, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const body = bodyStr !== undefined ? Buffer.from(bodyStr) : undefined;
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: urlPath,
        method,
        cert: clientCert,
        key: clientKey,
        rejectUnauthorized: false, // self-signed dev cert, acts as its own CA
        agent: false, // no keep-alive: an open socket would keep the event loop alive after main() finishes
        headers: {
          "Content-Type": "application/json",
          ...(body ? { "Content-Length": body.length } : {}),
          ...extraHeaders,
        },
      },
      res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// Matches internal/security's server-side rsa.VerifyPKCS1v15(pub, sha256(data), sig) —
// Node's createSign('RSA-SHA256').sign(pem) produces PKCS1v15 by default for RSA keys.
function signBody(bodyStr) {
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(bodyStr, "utf8");
  signer.end();
  return signer.sign(adminPrivateKeyPem).toString("base64");
}

async function adminPost(urlPath, bodyObj) {
  const bodyStr = JSON.stringify(bodyObj ?? {});
  return httpsRequest("POST", urlPath, bodyStr, { "X-Admin-Signature": signBody(bodyStr) });
}

async function publicPost(urlPath, bodyObj) {
  return httpsRequest("POST", urlPath, JSON.stringify(bodyObj ?? {}));
}

async function getJson(urlPath) {
  const { status, text } = await httpsRequest("GET", urlPath);
  return { status, text, json: text ? JSON.parse(text) : null };
}

// /voting-data's large field elements (root, etc.) are encoded as bare JSON
// numbers. Standard JSON.parse silently truncates integers beyond ~53 bits of
// precision, which `root` regularly exceeds. Extract precision-critical fields
// directly from the raw response text via regex instead of trusting the parsed
// JSON's number for them.
function bigField(text, name) {
  const m = text.match(new RegExp(`"${name}"\\s*:\\s*(-?\\d+)`));
  if (!m) throw new Error(`field "${name}" not found in response: ${text.slice(0, 300)}`);
  return BigInt(m[1]);
}

function toHex32(n) {
  return "0x" + n.toString(16);
}

// ─── Proof generation (ported from GenerateProof.tsx / CreateCommitment.tsx) ───

function generateCommitment() {
  // Matches CreateCommitment.tsx's generateCommitment(): Fr.random() produces a
  // proper random BN254 scalar field element (guaranteed < the field modulus).
  const nullifier = BigInt(Fr.random().toString());
  const secret = BigInt(Fr.random().toString());
  const commitment = poseidon2([nullifier, secret]);
  return { nullifier, secret, commitment };
}

async function generateProof({ root, candidateIndex, depth, nullifier, secret, leafIndex, allCommitments, circuitData }) {
  // Step 1: nullifier hash (matches circuit's hash_1([nullifier])).
  const nullifierHash = poseidon1([nullifier]);

  // Step 2: rebuild the Merkle tree from GET /commitments — already in insertion
  // order (unlike the browser's Solidity event path, no reversal needed).
  const tree = new LeanIMT((a, b) => poseidon2([a, b]));
  tree.insertMany(allCommitments.map(h => BigInt(h)));

  // Step 3: Merkle inclusion proof for our leaf.
  const proof = tree.generateProof(leafIndex);
  const siblings = proof.siblings.map(s => s.toString());

  // Step 4: LeanIMT-vs-binary_merkle_root circuit-index correction, ported
  // verbatim from GenerateProof.tsx — LeanIMT's own leaf index doesn't match the
  // bit-path convention the circuit's binary_merkle_root expects.
  const leaf = poseidon2([nullifier, secret]);
  const siblingsNum = proof.siblings.length;
  const maxIndex = 1 << siblingsNum;
  let circuitIndex = 0;
  let found = false;
  for (let cIndex = 0; cIndex < maxIndex; cIndex++) {
    let current = leaf;
    for (let i = 0; i < siblingsNum; i++) {
      const isRight = (cIndex >> i) & 1;
      const sibling = proof.siblings[i];
      current = isRight ? poseidon2([sibling, current]) : poseidon2([current, sibling]);
    }
    if (current === proof.root) {
      circuitIndex = cIndex;
      found = true;
      break;
    }
  }
  assertTrue(found, "could not find a valid circuit index for the Merkle path");

  // Step 5: pad siblings to the circuit's fixed length 16.
  while (siblings.length < 16) siblings.push("0");

  // Step 6: circuit inputs (exact order matching main.nr).
  const input = {
    nullifier_hash: nullifierHash.toString(),
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    root: root.toString(),
    vote: BigInt(candidateIndex).toString(),
    depth: depth.toString(),
    index: circuitIndex.toString(),
    siblings,
  };

  // Step 7: witness, then the UltraHonk proof (keccak: true — required for
  // Solidity-verifier compatibility, matches GenerateProof.tsx exactly).
  const noir = new Noir(circuitData);
  const { witness } = await noir.execute(input);

  const honk = new UltraHonkBackend(circuitData.bytecode, { threads: 1 });
  const { proof: proofBytes } = await honk.generateProof(witness, { keccak: true });

  return {
    proofHex: "0x" + Buffer.from(proofBytes).toString("hex"),
    nullifierHashHex: toHex32(nullifierHash),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  let node;
  try {
    // ── Step 1: start a Go node ──────────────────────────────────────────────
    log("1/6", "Starting Go node (embedded EVM)...");
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const creds = generateCertsAndKeys();
    clientCert = creds.cert;
    clientKey = creds.key;
    adminPrivateKeyPem = creds.adminPrivateKey;

    buildBinary();
    node = spawnNode();
    await waitForHealth();
    log("1/6", `Node healthy on ${BASE_URL}`);

    // ── Step 2: register voters via the REST API ────────────────────────────
    log("2/6", "Adding voters and opening registration...");
    const voter1 = "voter1@example.com";
    const voter2 = "voter2@example.com";

    let res = await adminPost("/add-voter", { voter_id: voter1 });
    assertEqual(res.status, 200, "add-voter voter1 failed: " + res.text);
    res = await adminPost("/add-voter", { voter_id: voter2 });
    assertEqual(res.status, 200, "add-voter voter2 failed: " + res.text);

    res = await adminPost("/start-registration", { duration_sec: 3600 });
    assertEqual(res.status, 200, "start-registration failed: " + res.text);

    let vd = await getJson("/voting-data");
    assertEqual(vd.json.phase_label, "Registration", "expected Registration phase");

    // ── Step 3: verify EVM state updates as voters register ─────────────────
    log("3/6", "Registering commitments and checking the Merkle root updates...");
    const treeSizeBefore = bigField(vd.text, "tree_size");
    assertEqual(treeSizeBefore, 0n, "expected empty tree before any registration");

    const { nullifier, secret, commitment } = generateCommitment();
    res = await publicPost("/register", { voter_id: voter1, commitment: toHex32(commitment) });
    assertEqual(res.status, 200, "register voter1 failed: " + res.text);
    const voter1LeafIndex = JSON.parse(res.text).transactions[0].payload.leaf_index;

    vd = await getJson("/voting-data");
    let treeSize = bigField(vd.text, "tree_size");
    assertEqual(treeSize, 1n, "expected tree_size 1 after first registration");
    const rootAfter1 = bigField(vd.text, "root");
    assertTrue(rootAfter1 !== 0n, "expected non-zero root after first registration");

    // Second voter, throwaway commitment — makes the tree non-trivial (depth > 0)
    // so the Merkle proof generated below actually exercises a real sibling path.
    res = await publicPost("/register", { voter_id: voter2, commitment: "0x2" });
    assertEqual(res.status, 200, "register voter2 failed: " + res.text);

    vd = await getJson("/voting-data");
    treeSize = bigField(vd.text, "tree_size");
    assertEqual(treeSize, 2n, "expected tree_size 2 after second registration");
    const rootAfter2 = bigField(vd.text, "root");
    assertTrue(rootAfter2 !== rootAfter1, "expected root to change after second registration");
    const depth = bigField(vd.text, "depth");
    assertTrue(depth > 0n, "expected non-zero tree depth with 2 leaves");
    log("3/6", `Merkle root updates correctly: tree_size=2 depth=${depth} root=0x${rootAfter2.toString(16)}`);

    res = await adminPost("/start-voting", { duration_sec: 3600 });
    assertEqual(res.status, 200, "start-voting failed: " + res.text);

    // ── Step 4: generate and submit a real, valid ZK proof ──────────────────
    log("4/6", "Generating a real ZK proof (this loads bb.js/noir_js and can take a while)...");
    const commitmentsRes = await getJson("/commitments");
    assertEqual(commitmentsRes.json.length, 2, "expected 2 commitments in the tree");

    const circuitData = JSON.parse(fs.readFileSync(CIRCUITS_PATH, "utf8"));
    const candidateIndex = 0; // "Yes" — default genesis candidates are ["Yes", "No"]
    const { proofHex, nullifierHashHex } = await generateProof({
      root: rootAfter2,
      candidateIndex,
      depth,
      nullifier,
      secret,
      leafIndex: voter1LeafIndex,
      allCommitments: commitmentsRes.json,
      circuitData,
    });
    log("4/6", `Proof generated (${(proofHex.length - 2) / 2} bytes)`);

    const voteBody = {
      proof: proofHex,
      nullifier_hash: nullifierHashHex,
      root: toHex32(rootAfter2),
      candidate_index: candidateIndex,
      depth: Number(depth),
    };
    res = await publicPost("/vote", voteBody);
    assertEqual(res.status, 200, "valid vote was rejected: " + res.text);
    log("4/6", "Valid proof accepted by the real HonkVerifier");

    const voteCounts = await getJson("/vote-counts");
    assertEqual(voteCounts.json[0].votes, 1, "expected candidate 0 (Yes) to have 1 vote");

    // ── Step 5: verify invalid-proof and double-vote rejection ──────────────
    log("5/6", "Verifying rejection of an invalid proof and a double-vote...");
    res = await publicPost("/vote", {
      proof: "0xdeadbeef",
      nullifier_hash: "0x01",
      root: toHex32(rootAfter2),
      candidate_index: candidateIndex,
      depth: Number(depth),
    });
    assertEqual(res.status, 400, "garbage proof should have been rejected");
    log("5/6", "Garbage proof correctly rejected (400)");

    res = await publicPost("/vote", voteBody); // exact same valid proof again
    assertEqual(res.status, 400, "double-vote (same nullifier) should have been rejected");
    assertTrue(res.text.includes("NullifierHashAlreadyUsed"), "expected NullifierHashAlreadyUsed, got: " + res.text);
    log("5/6", "Double-vote correctly rejected (400, NullifierHashAlreadyUsed)");

    // ── Step 6: restart and verify state reconstruction ─────────────────────
    log("6/6", "Stopping and restarting the node to verify state reconstruction...");
    const before = {
      votingData: (await getJson("/voting-data")).text,
      candidates: (await getJson("/candidates")).text,
      voteCounts: (await getJson("/vote-counts")).text,
      voter1: (await getJson(`/voter/${voter1}`)).text,
      voter2: (await getJson(`/voter/${voter2}`)).text,
    };

    await killNode(node);
    node = spawnNode();
    await waitForHealth();

    const after = {
      votingData: (await getJson("/voting-data")).text,
      candidates: (await getJson("/candidates")).text,
      voteCounts: (await getJson("/vote-counts")).text,
      voter1: (await getJson(`/voter/${voter1}`)).text,
      voter2: (await getJson(`/voter/${voter2}`)).text,
    };

    for (const key of Object.keys(before)) {
      assertEqual(after[key], before[key], `state mismatch after restart for ${key}`);
    }
    log("6/6", "State perfectly reconstructed from persisted blocks after restart");

    console.log("\n✅ Stage 6 integration test passed — all 6 steps verified.");
  } catch (err) {
    console.error("\n❌ Integration test failed:", err.message);
    if (node?.logLines?.length) {
      console.error("\n--- node output (last 40 lines) ---");
      console.error(node.logLines.join("").split("\n").slice(-40).join("\n"));
    }
    process.exitCode = 1;
  } finally {
    await killNode(node);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(BIN_PATH, { force: true });
  }
}

main();
