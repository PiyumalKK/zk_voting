import { Address } from "viem";
import { AddressComponent } from "~~/app/blockexplorer/_components/AddressComponent";
import scaffoldConfig from "~~/scaffold.config";
import { getContractByAddress } from "~~/utils/blockexplorer/contractSources";
import { isZeroAddress } from "~~/utils/scaffold-eth/common";

type PageProps = {
  params: Promise<{ address: Address }>;
};

// Force dynamic rendering so every real address works on the standalone server.
export const dynamic = "force-dynamic";

/**
 * Contract/address page.
 *
 * The contract lookup happens here, on the server, deliberately: it reads the
 * ~490KB `contractSources.json`, and resolving the single matching contract
 * before rendering means only that one contract's source and ABI cross into the
 * client bundle rather than the whole file.
 *
 * This replaces the previous `fs.readFileSync` on `hardhat/artifacts/build-info`,
 * which threw on the production standalone server because that directory is
 * gitignored and never deployed.
 */
const AddressPage = async (props: PageProps) => {
  const params = await props.params;
  const address = params?.address as Address;

  if (isZeroAddress(address)) return null;

  // Match against the chain the app is pointed at; the same contract has
  // different addresses on 31337 and 9494.
  const chainId = scaffoldConfig.targetNetworks[0].id;
  const contract = getContractByAddress(address, chainId);

  return <AddressComponent address={address} contract={contract} />;
};

export default AddressPage;
