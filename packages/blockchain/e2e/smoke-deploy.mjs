#!/usr/bin/env node
// Realistic dry-run for the custom chain's write path (MASTER blockchain-v2
// M05, "Realistic dry-run").
//
// Everything else in M05 is proven against hand-assembled bytecode or a tiny
// purpose-built fixture. This script proves the EVM handles the *actual*
// application stack — Poseidon's precompile-free field arithmetic, a 21.6 KB
// verifier, library linking, and a contract that writes to an incremental
// Merkle tree — before M08 makes `yarn deploy --network custom` the gate.
//
// It deploys, in order:
//   PoseidonT3  ->  LeanIMT (linked to PoseidonT3)
//               ->  HonkVerifier
//               ->  Voting (linked to LeanIMT, constructor args)
// then drives a real registration: setCandidates -> addVoters ->
// startRegistration -> register(commitment) -> getVotingData, and asserts the
// resulting Merkle root is non-zero.
//
// Artifacts are read at runtime from packages/hardhat/artifacts (compiled by
// `yarn compile` there) — never copied or vendored, so this script can never
// drift from the contracts the app actually deploys. Library linking is done
// here in-script, using each artifact's own linkReferences byte offsets, the
// same way hardhat-deploy does it.
//
// Usage:
//   node smoke-deploy.mjs                              # against our node on :9545
//   RPC_URL=http://127.0.0.1:8545 node smoke-deploy.mjs  # against hardhat, as a control
// or, from packages/blockchain: `make smoke`
//
// Start from a fresh chain (`make reset && make run`): the script assumes it
// is the owner of what it deploys, which it always is, but a fresh chain also
// keeps the log output readable.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(here, "..", "..", "hardhat", "artifacts");

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:9545";

// Hardhat test account #0 — genesis-prefunded on both backends, and the
// account the real deploy scripts use as deployer/owner. Not a secret.
const DEPLOYER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);

// Explicit, generous gas limits rather than eth_estimateGas. PoseidonT3 and
// HonkVerifier are large enough that their code-deposit cost dominates
// (200 gas per deployed byte: ~3.4M and ~4.3M respectively), and this script
// exists to test *execution*, not the estimator — M05's Go tests and
// e2e/diff/write.mjs cover estimateGas separately. BLOCK_GAS_LIMIT defaults
// to 60,000,000 (MASTER §7), so these fit comfortably.
const DEPLOY_GAS = 15_000_000n;
const CALL_GAS = 5_000_000n;

// EIP-170's deployed-code size cap. MASTER §2 records HonkVerifier at 21,635
// bytes; asserted here as an early warning (M08 makes it a deploy-time gate).
const EIP170_LIMIT = 24_576;

const REGISTRATION_SECONDS = 3600n;
// An arbitrary field element standing in for a real Poseidon commitment. The
// tree only needs a non-zero leaf for the root to become non-zero, and this
// script deliberately does not depend on the circuits package.
const COMMITMENT = 1234567890123456789012345678901234567890n;

const steps = [];

function ok(name, detail) {
  steps.push({ name, ok: true });
  console.log(`[PASS] ${name}${detail ? " — " + detail : ""}`);
}

function bad(name, detail) {
  steps.push({ name, ok: false, detail });
  console.log(`[FAIL] ${name}${detail ? " — " + detail : ""}`);
}

function loadArtifact(relativePath) {
  return JSON.parse(readFileSync(join(ARTIFACTS, relativePath), "utf8"));
}

/**
 * link resolves an artifact's library placeholders using the byte offsets
 * recorded in its own linkReferences, rather than by string-substituting the
 * `__$<hash>$__` placeholder text. Offsets are authoritative: they come from
 * the compiler, cannot be ambiguous, and do not depend on how a particular
 * solc version renders the placeholder.
 *
 * @param {string} bytecode 0x-prefixed creation bytecode with placeholders
 * @param {object} linkReferences artifact.linkReferences
 * @param {Record<string, string>} libraries library name -> deployed address
 */
function link(bytecode, linkReferences, libraries) {
  // Work on the hex body (no 0x) as a mutable array of characters: a byte at
  // offset n occupies hex characters [2n, 2n+2).
  const chars = bytecode.slice(2).split("");

  for (const [, contracts] of Object.entries(linkReferences ?? {})) {
    for (const [libName, positions] of Object.entries(contracts)) {
      const address = libraries[libName];
      if (!address) {
        throw new Error(`no deployed address supplied for library ${libName}`);
      }
      const addressHex = address.toLowerCase().replace(/^0x/, "");
      if (addressHex.length !== 40) {
        throw new Error(`library ${libName} address ${address} is not 20 bytes`);
      }
      for (const { start, length } of positions) {
        if (length !== 20) {
          throw new Error(`unexpected link reference length ${length} for ${libName}`);
        }
        for (let i = 0; i < 40; i++) {
          chars[start * 2 + i] = addressHex[i];
        }
      }
    }
  }

  const linked = "0x" + chars.join("");
  if (linked.includes("__$")) {
    throw new Error("bytecode still contains unresolved library placeholders after linking");
  }
  return linked;
}

async function main() {
  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, transport: http(RPC_URL) });

  const chainId = await publicClient.getChainId();
  console.log(`smoke-deploy against ${RPC_URL} (chain id ${chainId}) as ${account.address}\n`);

  const poseidonArtifact = loadArtifact("poseidon-solidity/PoseidonT3.sol/PoseidonT3.json");
  const leanIMTArtifact = loadArtifact("@zk-kit/lean-imt.sol/LeanIMT.sol/LeanIMT.json");
  const verifierArtifact = loadArtifact("contracts/Verifier.sol/HonkVerifier.json");
  const votingArtifact = loadArtifact("contracts/Voting.sol/Voting.json");

  const deploy = async (label, abi, bytecode, args) => {
    const hash = await walletClient.deployContract({ abi, bytecode, args, gas: DEPLOY_GAS });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${label} deploy reverted (status ${receipt.status})`);
    }
    if (!receipt.contractAddress) {
      throw new Error(`${label} deploy receipt has no contractAddress`);
    }
    const code = await publicClient.getCode({ address: receipt.contractAddress });
    const size = code ? code.length / 2 - 1 : 0;

    // EIP-170 caps deployed runtime code at 24,576 bytes (MASTER §10.8).
    // Asserted for *every* contract (M08 deliverable 5), not just
    // HonkVerifier: the verifier is the one at risk today, but a future
    // Voting.sol that grows past the limit should fail here — named, with a
    // byte count — rather than as an opaque failed deployment later.
    if (size > EIP170_LIMIT) {
      bad(`${label} fits under EIP-170`, `${size} bytes > ${EIP170_LIMIT}`);
    }

    ok(
      `deploy ${label}`,
      `${receipt.contractAddress}, ${size} bytes of code (EIP-170 headroom ${EIP170_LIMIT - size}), gasUsed ${receipt.gasUsed}`,
    );
    return { address: receipt.contractAddress, size };
  };

  const send = async (label, address, abi, functionName, args) => {
    const hash = await walletClient.writeContract({ address, abi, functionName, args, gas: CALL_GAS });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${label} reverted`);
    }
    ok(label, `gasUsed ${receipt.gasUsed}, ${receipt.logs.length} log(s)`);
    return receipt;
  };

  // --- 1-2: Poseidon + LeanIMT (library linking) ---
  const poseidon = await deploy("PoseidonT3", poseidonArtifact.abi, poseidonArtifact.bytecode, []);

  const leanIMTBytecode = link(leanIMTArtifact.bytecode, leanIMTArtifact.linkReferences, {
    PoseidonT3: poseidon.address,
  });
  ok("link LeanIMT -> PoseidonT3", "all placeholders resolved");
  const leanIMT = await deploy("LeanIMT", leanIMTArtifact.abi, leanIMTBytecode, []);

  // --- 3: the real ZK verifier (the largest contract in the app) ---
  const verifier = await deploy("HonkVerifier", verifierArtifact.abi, verifierArtifact.bytecode, []);
  if (verifier.size > EIP170_LIMIT) {
    bad("HonkVerifier fits under EIP-170", `${verifier.size} bytes > ${EIP170_LIMIT}`);
  } else {
    ok("HonkVerifier fits under EIP-170", `${verifier.size} / ${EIP170_LIMIT} bytes`);
  }

  // --- 4: Voting, linked to LeanIMT ---
  const votingBytecode = link(votingArtifact.bytecode, votingArtifact.linkReferences, {
    LeanIMT: leanIMT.address,
  });
  ok("link Voting -> LeanIMT", "all placeholders resolved");
  const voting = await deploy("Voting", votingArtifact.abi, votingBytecode, [
    account.address,
    verifier.address,
    "Do you support this proposal?",
    ["Yes", "No"],
  ]);

  const abi = votingArtifact.abi;

  // --- 5: drive a real registration ---
  await send("setCandidates(['Yes','No','Abstain'])", voting.address, abi, "setCandidates", [
    ["Yes", "No", "Abstain"],
  ]);
  await send("addVoters([deployer], [true])", voting.address, abi, "addVoters", [[account.address], [true]]);
  await send("startRegistration(3600)", voting.address, abi, "startRegistration", [REGISTRATION_SECONDS]);

  const registerReceipt = await send("register(commitment)", voting.address, abi, "register", [COMMITMENT]);
  if (registerReceipt.logs.length !== 1) {
    bad("register emits exactly one NewLeaf log", `got ${registerReceipt.logs.length}`);
  } else {
    ok("register emits exactly one NewLeaf log");
  }

  // --- 6: read the tree back ---
  const data = await publicClient.readContract({ address: voting.address, abi, functionName: "getVotingData" });
  const [question, contractOwner, phase, , , size, depth, root, candidateCount] = data;

  console.log("\ngetVotingData():");
  console.log(`  question       ${question}`);
  console.log(`  owner          ${contractOwner}`);
  console.log(`  phase          ${phase} (1 = Registration)`);
  console.log(`  tree size      ${size}`);
  console.log(`  tree depth     ${depth}`);
  console.log(`  root           ${root}`);
  console.log(`  candidateCount ${candidateCount}\n`);

  check("owner is the deployer", contractOwner.toLowerCase() === account.address.toLowerCase(), String(contractOwner));
  check("phase is Registration", Number(phase) === 1, String(phase));
  check("tree size is 1", size === 1n, String(size));
  check("candidateCount is 3", candidateCount === 3n, String(candidateCount));
  check("merkle root is non-zero", root !== 0n, String(root));
}

function check(name, condition, detail) {
  if (condition) ok(name, detail);
  else bad(name, detail);
}

main()
  .then(() => {
    const failed = steps.filter((s) => !s.ok);
    console.log(`${steps.length} checks: ${steps.length - failed.length} passed, ${failed.length} failed.`);
    if (failed.length > 0) {
      for (const f of failed) console.log(`  - ${f.name}: ${f.detail ?? ""}`);
      process.exitCode = 1;
    }
  })
  .catch((err) => {
    console.error("\nsmoke-deploy failed:", err?.shortMessage ?? err?.details ?? err?.message ?? err);
    if (err?.cause) console.error("cause:", err.cause?.shortMessage ?? err.cause?.message ?? err.cause);
    process.exit(1);
  });
