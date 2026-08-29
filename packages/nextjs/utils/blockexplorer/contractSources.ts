/**
 * Typed access to `contracts/contractSources.json`, generated after every deploy
 * by `packages/hardhat/scripts/generateContractSources.ts`.
 *
 * ## Server-only by convention
 *
 * The JSON is ~490KB — every contract's Solidity source, ABI and bytecode. It
 * must never reach the browser wholesale, so the *values* here are imported only
 * from server components, which resolve a single address and pass the hydrated
 * result down as props. Client components import from this module with
 * `import type`, which erases at compile time and pulls in nothing.
 *
 * This replaces the old `fs.readFileSync` on `hardhat/artifacts/build-info/`,
 * which broke in production: that directory is gitignored and absent from the
 * standalone server, so every contract page threw.
 */
import type { Abi } from "viem";
import contractSourcesJson from "~~/contracts/contractSources.json";

export type SourceFile = {
  content: string;
  license?: string;
};

export type CompilerInfo = {
  version: string;
  optimizer: { enabled: boolean; runs: number } | null;
  evmVersion: string | null;
  language: string;
};

export type ContractSourceEntry = {
  deploymentName: string;
  contractName: string;
  sourceName: string;
  address: string;
  creator: string | null;
  creationTxHash: string | null;
  creationBlock: number | null;
  abiRef: string;
  bytecodeRef: string | null;
  deployedBytecodeRef: string | null;
  libraries: Record<string, string>;
  sourceFiles: string[];
  verified: boolean;
};

export type ChainSources = {
  chainId: number;
  network: string;
  compiler: CompilerInfo | null;
  sources: Record<string, SourceFile>;
  abis: Record<string, unknown[]>;
  bytecodes: Record<string, string>;
  contracts: Record<string, ContractSourceEntry>;
};

export type ContractSourcesFile = {
  generatedAt: string;
  chains: Record<string, ChainSources>;
};

/** A named source file with its content, ready to render. */
export type ResolvedSource = {
  path: string;
  content: string;
  license?: string;
  /** True for the file declaring the contract itself, shown first. */
  isEntry: boolean;
};

/**
 * One contract, fully hydrated and serializable — the shape crossing the
 * server/client boundary. All refs are resolved so client components never need
 * the lookup maps (and therefore never need the full JSON).
 */
export type HydratedContract = {
  deploymentName: string;
  contractName: string;
  sourceName: string;
  address: string;
  creator: string | null;
  creationTxHash: string | null;
  creationBlock: number | null;
  abi: Abi;
  bytecode: string | null;
  deployedBytecode: string | null;
  libraries: Record<string, string>;
  verified: boolean;
  compiler: CompilerInfo | null;
  sources: ResolvedSource[];
};

const contractSources = contractSourcesJson as unknown as ContractSourcesFile;

/** When the JSON was generated — surfaced in the UI so staleness is visible. */
export const getGeneratedAt = (): string => contractSources.generatedAt;

const getChain = (chainId: number): ChainSources | null => contractSources.chains[String(chainId)] ?? null;

/**
 * Hydrates a deployment entry, resolving every content-addressed ref.
 *
 * Division deployments (Voting_Kaduwela, Voting_Colombo, Voting_Gampaha) all
 * point at the same `Voting` ABI/bytecode/source refs, so this naturally yields
 * identical source for each without special-casing them.
 */
const hydrate = (chain: ChainSources, entry: ContractSourceEntry): HydratedContract => ({
  deploymentName: entry.deploymentName,
  contractName: entry.contractName,
  sourceName: entry.sourceName,
  address: entry.address,
  creator: entry.creator,
  creationTxHash: entry.creationTxHash,
  creationBlock: entry.creationBlock,
  abi: (chain.abis[entry.abiRef] ?? []) as Abi,
  bytecode: entry.bytecodeRef ? (chain.bytecodes[entry.bytecodeRef] ?? null) : null,
  deployedBytecode: entry.deployedBytecodeRef ? (chain.bytecodes[entry.deployedBytecodeRef] ?? null) : null,
  libraries: entry.libraries,
  verified: entry.verified,
  compiler: chain.compiler,
  sources: entry.sourceFiles.flatMap(filePath => {
    const source = chain.sources[filePath];
    if (!source) return [];
    return [
      { path: filePath, content: source.content, license: source.license, isEntry: filePath === entry.sourceName },
    ];
  }),
});

/**
 * Finds the deployed contract at `address` on `chainId`, or null if the address
 * is not a contract this deployment produced (an EOA, or a contract deployed
 * outside hardhat-deploy).
 */
export const getContractByAddress = (address: string, chainId: number): HydratedContract | null => {
  const chain = getChain(chainId);
  if (!chain) return null;

  const target = address.toLowerCase();
  const entry = Object.values(chain.contracts).find(contract => contract.address.toLowerCase() === target);
  return entry ? hydrate(chain, entry) : null;
};

/** Every deployed contract on the chain, for index/listing views. */
export const getAllContracts = (chainId: number): HydratedContract[] => {
  const chain = getChain(chainId);
  if (!chain) return [];
  return Object.values(chain.contracts).map(entry => hydrate(chain, entry));
};

/**
 * Address -> deployment name for every known contract, used to label `to`/`from`
 * columns in transaction lists. Small enough to hand to client components.
 */
export const getAddressLabels = (chainId: number): Record<string, string> => {
  const chain = getChain(chainId);
  if (!chain) return {};
  return Object.fromEntries(
    Object.values(chain.contracts).map(entry => [entry.address.toLowerCase(), entry.deploymentName]),
  );
};
