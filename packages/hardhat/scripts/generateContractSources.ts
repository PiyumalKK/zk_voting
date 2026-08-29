/**
 * Generates `packages/nextjs/contracts/contractSources.json` — the data behind
 * the block explorer's "Contract" tab (source code, ABI, bytecode, compiler
 * settings, creator + creation tx).
 *
 * Runs from the `deploy` task override in `hardhat.config.ts`, immediately after
 * `generateTsAbis`, so the explorer's source data and `deployedContracts.ts` are
 * always written from the same deployment.
 *
 * ## Why deployments/ and not artifacts/build-info/
 *
 * The block explorer's address page used to read `artifacts/build-info/*.json`
 * with `fs` at request time. That cannot work in production: `artifacts/` and
 * `deployments/custom/` are both gitignored, so neither exists in the EC2
 * checkout, and `output: "standalone"` traces no path to them anyway.
 *
 * Each hardhat-deploy deployment JSON, by contrast, is self-contained. Its
 * `metadata` is the solc metadata blob emitted with `useLiteralContent: true`
 * (see `hardhat.config.ts`), which carries:
 *   - the full text of every source file in the contract's import closure,
 *   - the exact compiler version, optimizer settings and evmVersion,
 *   - the SPDX licence per file,
 *   - `compilationTarget`, mapping the deployment to its source contract.
 *
 * It also carries the deployment receipt, which build-info has no notion of and
 * which the address header needs: creator address and creation tx hash.
 *
 * The generated JSON is committed alongside `deployedContracts.ts` and imported
 * statically, so it is baked into the bundle at build time and needs no
 * filesystem access at runtime.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { DeployFunction } from "hardhat-deploy/types";

const DEPLOYMENTS_DIR = "./deployments";
const TARGET_DIR = "../nextjs/contracts";
const TARGET_FILE = "contractSources.json";

/** One source file, stored once per chain and referenced by path. */
type SourceFile = {
  content: string;
  license?: string;
};

type ContractSourceEntry = {
  /** Deployment name, e.g. "Voting_Kaduwela". */
  deploymentName: string;
  /** Source contract name, e.g. "Voting". Divisions share one source contract. */
  contractName: string;
  /** Path of the file declaring `contractName`, e.g. "contracts/Voting.sol". */
  sourceName: string;
  address: string;
  /** Deployer EOA — `receipt.from`. Null if the receipt was not recorded. */
  creator: string | null;
  creationTxHash: string | null;
  creationBlock: number | null;
  /**
   * Keys into the chain-level `abis` / `bytecodes` maps. The three division
   * deployments are the same compiled `Voting`, so they share one ABI and one
   * pair of bytecode blobs rather than carrying four identical ~45KB copies.
   * Null when the deployment did not record that field.
   */
  abiRef: string;
  bytecodeRef: string | null;
  deployedBytecodeRef: string | null;
  /** Linked library addresses, when the contract uses libraries. */
  libraries: Record<string, string>;
  /**
   * Every file in this contract's import closure, main source first, then the
   * rest alphabetically. Keys into the chain-level `sources` map.
   */
  sourceFiles: string[];
  /** False when the deployment carried no metadata — source cannot be shown. */
  verified: boolean;
};

type CompilerInfo = {
  version: string;
  optimizer: { enabled: boolean; runs: number } | null;
  evmVersion: string | null;
  language: string;
};

type ChainSources = {
  chainId: number;
  network: string;
  compiler: CompilerInfo | null;
  sources: Record<string, SourceFile>;
  /** Content-addressed ABIs, referenced by `ContractSourceEntry.abiRef`. */
  abis: Record<string, unknown[]>;
  /** Content-addressed creation/runtime bytecode, referenced by the `*Ref` fields. */
  bytecodes: Record<string, string>;
  contracts: Record<string, ContractSourceEntry>;
};

type ContractSourcesFile = {
  generatedAt: string;
  chains: Record<string, ChainSources>;
};

function getDirectories(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
}

function getDeploymentFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(dirent => dirent.isFile() && dirent.name.endsWith(".json"))
    .map(dirent => dirent.name);
}

/** Normalises a hex blob to 0x-prefixed, or null when absent/empty. */
function normaliseBytecode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "0x") return null;
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

/** Short content hash used as the key in the `abis` / `bytecodes` maps. */
function contentKey(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function buildChainSources(chainName: string, chainId: number): ChainSources {
  const chainDir = path.join(DEPLOYMENTS_DIR, chainName);
  const sources: Record<string, SourceFile> = {};
  const abis: Record<string, unknown[]> = {};
  const bytecodes: Record<string, string> = {};
  const contracts: Record<string, ContractSourceEntry> = {};
  let compiler: CompilerInfo | null = null;

  /** Interns a blob and returns its key, or null when there is nothing to store. */
  const internBytecode = (value: unknown): string | null => {
    const normalised = normaliseBytecode(value);
    if (normalised === null) return null;
    const key = contentKey(normalised);
    bytecodes[key] = normalised;
    return key;
  };

  for (const fileName of getDeploymentFiles(chainDir)) {
    const deploymentName = fileName.replace(/\.json$/, "");
    const raw = JSON.parse(fs.readFileSync(path.join(chainDir, fileName), "utf8"));

    let contractName = deploymentName;
    let sourceName = "";
    let sourceFiles: string[] = [];
    let verified = false;

    if (raw.metadata) {
      const metadata = JSON.parse(raw.metadata);

      // `compilationTarget` is the authoritative deployment -> source mapping.
      // It is what tells us Voting_Kaduwela is compiled from contracts/Voting.sol's
      // `Voting`, which no filename convention would reveal.
      const target = metadata.settings?.compilationTarget ?? {};
      const [targetSource, targetContract] = Object.entries(target)[0] ?? [];
      if (targetSource && typeof targetContract === "string") {
        sourceName = targetSource;
        contractName = targetContract;
      }

      // Sources are deduplicated across the chain: Voting.sol is the source for
      // four deployments and Verifier.sol is ~80KB, so storing them per contract
      // would multiply the payload for no gain.
      const metadataSources: Record<string, { content?: string; license?: string }> = metadata.sources ?? {};
      for (const [filePath, entry] of Object.entries(metadataSources)) {
        if (typeof entry.content !== "string") continue;
        if (!sources[filePath]) {
          sources[filePath] = { content: entry.content, ...(entry.license ? { license: entry.license } : {}) };
        }
      }

      const closure = Object.keys(metadataSources).filter(filePath => sources[filePath]);
      // Main source first so the UI can open on it without a lookup.
      sourceFiles = [
        ...(sourceName && closure.includes(sourceName) ? [sourceName] : []),
        ...closure.filter(filePath => filePath !== sourceName).sort(),
      ];
      verified = sourceFiles.length > 0;

      if (!compiler && metadata.compiler?.version) {
        compiler = {
          version: metadata.compiler.version,
          optimizer: metadata.settings?.optimizer ?? null,
          evmVersion: metadata.settings?.evmVersion ?? null,
          language: metadata.language ?? "Solidity",
        };
      }
    }

    const abi: unknown[] = raw.abi ?? [];
    const abiRef = contentKey(JSON.stringify(abi));
    abis[abiRef] = abi;

    contracts[deploymentName] = {
      deploymentName,
      contractName,
      sourceName,
      address: raw.address,
      creator: raw.receipt?.from ?? null,
      creationTxHash: raw.transactionHash ?? raw.receipt?.transactionHash ?? null,
      creationBlock: typeof raw.receipt?.blockNumber === "number" ? raw.receipt.blockNumber : null,
      abiRef,
      bytecodeRef: internBytecode(raw.bytecode),
      deployedBytecodeRef: internBytecode(raw.deployedBytecode),
      libraries: raw.libraries ?? {},
      sourceFiles,
      verified,
    };
  }

  return { chainId, network: chainName, compiler, sources, abis, bytecodes, contracts };
}

const generateContractSources: DeployFunction = async function () {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    console.log("⏭  No deployments directory — skipping contract source generation.");
    return;
  }

  const output: ContractSourcesFile = { generatedAt: new Date().toISOString(), chains: {} };

  for (const chainName of getDirectories(DEPLOYMENTS_DIR)) {
    const chainIdPath = path.join(DEPLOYMENTS_DIR, chainName, ".chainId");
    if (!fs.existsSync(chainIdPath)) {
      console.log(`   No .chainId file found for ${chainName}, skipping`);
      continue;
    }
    const chainId = parseInt(fs.readFileSync(chainIdPath, "utf8").trim(), 10);
    if (!Number.isInteger(chainId)) {
      console.log(`   Unreadable .chainId for ${chainName}, skipping`);
      continue;
    }
    output.chains[String(chainId)] = buildChainSources(chainName, chainId);
  }

  if (!fs.existsSync(TARGET_DIR)) {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
  }

  const targetPath = path.join(TARGET_DIR, TARGET_FILE);
  fs.writeFileSync(targetPath, `${JSON.stringify(output, null, 2)}\n`);

  const summary = Object.values(output.chains).map(chain => {
    const total = Object.keys(chain.contracts).length;
    const verified = Object.values(chain.contracts).filter(c => c.verified).length;
    return `chain ${chain.chainId}: ${verified}/${total} with source, ${Object.keys(chain.sources).length} source files`;
  });
  const sizeKb = (fs.statSync(targetPath).size / 1024).toFixed(0);

  console.log(`📚 Updated contract source file at ${targetPath} (${sizeKb} KB)`);
  summary.forEach(line => console.log(`   ${line}`));
};

export default generateContractSources;

// Also runnable on its own — `yarn generate-sources` — to refresh the explorer
// data from the existing deployments without redeploying.
if (require.main === module) {
  generateContractSources({} as never).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
