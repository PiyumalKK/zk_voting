import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";

const deployVotingContract: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  // The owner address for the Voting contract
  const ownerAddress = deployer;

  // The voting question
  const question = "Do you support this proposal?";

  // Deploy the Voting contract
  await deploy("Voting", {
    from: deployer,
    args: [ownerAddress, question],
    log: true,
    autoMine: true,
  });

  const voting = await hre.ethers.getContract<Contract>("Voting", deployer);
  console.log("🗳️  Voting question:", await voting.s_question());
};

export default deployVotingContract;
deployVotingContract.tags = ["Voting"];
