import deployedContracts from "~~/contracts/deployedContracts";

/**
 * Resolves a deployed contract's address for a given chain.
 *
 * Contract addresses are **per chain** — the same contract has a different
 * address on 31337 and on 9494. Anything that hardcodes one, or reads one from a
 * single environment variable, is guaranteed to be wrong in one of the two
 * modes. `deployedContracts.ts` holds both, keyed by chain id; this is the one
 * place the lookup happens.
 *
 * An `override` is honoured when supplied, for pointing at a contract deployed
 * outside `yarn deploy`.
 */

type DeployedRecord = Record<number, Record<string, { address: string }>>;

/**
 * Normalises an environment override.
 *
 * `FOO=` in a `.env` file yields the **empty string**, not `undefined` — so
 * `process.env.FOO ?? fallback` returns `""` and the fallback never runs. That
 * mistake shipped once here and silently disabled GN registration, because `""`
 * is falsy and every downstream guard read it as "not configured". Treat blank
 * as absent.
 */
export const normalizeAddressOverride = (raw: string | undefined): `0x${string}` | undefined => {
  const trimmed = raw?.trim();
  return trimmed ? (trimmed as `0x${string}`) : undefined;
};

/** Looks a contract up in an explicit deployment record. Pure — unit tested. */
export const lookupDeployedAddress = (
  record: DeployedRecord,
  chainId: number,
  contractName: string,
  override?: string,
): `0x${string}` | undefined =>
  normalizeAddressOverride(override) ?? (record[chainId]?.[contractName]?.address as `0x${string}` | undefined);

/** Looks a contract up in the generated `deployedContracts.ts`. */
export const getDeployedAddress = (
  chainId: number,
  contractName: string,
  override?: string,
): `0x${string}` | undefined =>
  lookupDeployedAddress(deployedContracts as unknown as DeployedRecord, chainId, contractName, override);
