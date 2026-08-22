import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";

const deployVotingContract: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const ownerAddress = deployer;
  const question = "Do you support this proposal?";
  // Default candidates — preserve the "Yes/No" feel of the original demo
  // while exercising the multi-candidate path. Admin can replace these
  // during the Setup phase via setCandidates(...).
  const initialCandidates: string[] = ["Yes", "No"];

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

  // 4. Deploy the NicRegistry.
  //
  //     It has to exist before any Voting contract, not after: a division's
  //     registry address is immutable and `register()` calls into it, so a
  //     Voting deployed without one could never enforce the one-citizen-one-leaf
  //     rule. `01_deploy_divisions.ts` reuses this same deployment.
  const nicRegistry = await deploy("NicRegistry", {
    from: deployer,
    args: [ownerAddress],
    log: true,
    autoMine: true,
  });

  // 5. Deploy the Voting contract, linked to LeanIMT, with verifier address
  const voting = await deploy("Voting", {
    from: deployer,
    args: [ownerAddress, verifier.address, nicRegistry.address, question, initialCandidates],
    libraries: {
      LeanIMT: leanIMT.address,
    },
    log: true,
    autoMine: true,
  });

  // 6. Authorise it, so `register()` can call `commitDevice`. Idempotent, unlike
  //    the deploy above, so it is re-sent on every run — cheap, and it repairs a
  //    chain where the registry was replaced.
  const nicRegistryContract = await hre.ethers.getContractAt("NicRegistry", nicRegistry.address);
  if (!(await nicRegistryContract.isVotingContractAuthorized(voting.address))) {
    await nicRegistryContract.setVotingContract(voting.address, true);
  }

  await hre.ethers.getContract<Contract>("Voting", deployer);
  console.log("🗳️  Voting deployed with verifier at:", verifier.address);
  console.log("🪪  NicRegistry at:", nicRegistry.address);
};

export default deployVotingContract;
deployVotingContract.tags = ["Voting"];
