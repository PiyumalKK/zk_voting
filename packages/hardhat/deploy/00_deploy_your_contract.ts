import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";

const deployVotingContract: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const ownerAddress = deployer;
  const question = "Do you support this proposal?";

  // 1. Deploy PoseidonT3 hash library (used internally by LeanIMT)
  const poseidonT3 = await deploy("PoseidonT3", {
    from: deployer,
    log: true,
    autoMine: true,
  });

  // 2. Deploy LeanIMT library, linked to PoseidonT3
  const leanIMT = await deploy("LeanIMT", {
    from: deployer,
    libraries: {
      PoseidonT3: poseidonT3.address,
    },
    log: true,
    autoMine: true,
  });

  // 3. Deploy the HonkVerifier (placeholder — replaced with real verifier later)
  const verifier = await deploy("HonkVerifier", {
    from: deployer,
    log: true,
    autoMine: true,
  });

  // 4. Deploy the Voting contract, linked to LeanIMT, with verifier address
  await deploy("Voting", {
    from: deployer,
    args: [ownerAddress, verifier.address, question],
    libraries: {
      LeanIMT: leanIMT.address,
    },
    log: true,
    autoMine: true,
  });

  const voting = await hre.ethers.getContract<Contract>("Voting", deployer);
  console.log("🗳️  Voting deployed with verifier at:", verifier.address);
};

export default deployVotingContract;
deployVotingContract.tags = ["Voting"];
