import fs from "fs";
import path from "path";
import { Address } from "viem";
import { AddressComponent } from "~~/app/blockexplorer/_components/AddressComponent";
import deployedContracts from "~~/contracts/deployedContracts";
import scaffoldConfig from "~~/scaffold.config";
import { isZeroAddress } from "~~/utils/scaffold-eth/common";
import { GenericContractsDeclaration } from "~~/utils/scaffold-eth/contract";

type PageProps = {
  params: Promise<{ address: Address }>;
};

async function fetchByteCodeAndAssembly(buildInfoDirectory: string, contractName: string) {
  const contractPath = `contracts/${contractName}.sol`;
  const buildInfoFiles = fs.readdirSync(buildInfoDirectory);
  let bytecode = "";
  let assembly = "";

  for (let i = 0; i < buildInfoFiles.length; i++) {
    const filePath = path.join(buildInfoDirectory, buildInfoFiles[i]);

    const buildInfo = JSON.parse(fs.readFileSync(filePath, "utf8"));

    if (buildInfo.output.contracts[contractPath]) {
      for (const contract in buildInfo.output.contracts[contractPath]) {
        bytecode = buildInfo.output.contracts[contractPath][contract].evm.bytecode.object;
        assembly = buildInfo.output.contracts[contractPath][contract].evm.bytecode.opcodes;
        break;
      }
    }

    if (bytecode && assembly) {
      break;
    }
  }

  return { bytecode, assembly };
}

const getContractData = async (address: Address) => {
  const contracts = deployedContracts as GenericContractsDeclaration | null;
  // Match the address against the chain the app is pointed at; the same contract
  // has different addresses on 31337 and 9494.
  const chainId = scaffoldConfig.targetNetworks[0].id;

  if (!contracts || !contracts[chainId] || Object.keys(contracts[chainId]).length === 0) {
    return null;
  }

  const artifactsDirectory = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "..",
    "..",
    "hardhat",
    "artifacts",
    "build-info",
  );

  if (!fs.existsSync(artifactsDirectory)) {
    throw new Error(`Directory ${artifactsDirectory} not found.`);
  }

  let matchedContractName = "";
  const deployedContractsOnChain = contracts[chainId];
  for (const [contractName, contractInfo] of Object.entries(deployedContractsOnChain)) {
    if (contractInfo.address.toLowerCase() === address.toLowerCase()) {
      matchedContractName = contractName;
      break;
    }
  }

  if (!matchedContractName) {
    // No contract found at this address
    return null;
  }

  const { bytecode, assembly } = await fetchByteCodeAndAssembly(artifactsDirectory, matchedContractName);

  return { bytecode, assembly };
};

// Force dynamic rendering so every real address works on the standalone server.
export const dynamic = "force-dynamic";

const AddressPage = async (props: PageProps) => {
  const params = await props.params;
  const address = params?.address as Address;

  if (isZeroAddress(address)) return null;

  const contractData: { bytecode: string; assembly: string } | null = await getContractData(address);
  return <AddressComponent address={address} contractData={contractData} />;
};

export default AddressPage;
