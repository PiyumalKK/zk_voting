import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

/**
 * Deploy ElectionRegistry + 3 sample division Voting contracts.
 * This simulates a multi-constituency Sri Lankan election.
 *
 * Accounts used:
 *   - Account #0 (deployer): Election Authority (admin/owner)
 *   - Account #1: GN Officer — Kaduwela
 *   - Account #2: GN Officer — Colombo Central
 *   - Account #3: GN Officer — Gampaha
 */
const deployDivisions: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;
  const signers = await hre.ethers.getSigners();

  // GN officers from Hardhat accounts.
  // Kaduwela is assigned to the deployer (account #0) so the admin can also drive
  // the GN portal from a single wallet during the demo. Colombo/Gampaha use #2/#3.
  const gnKaduwela = deployer;
  const gnColombo = signers[2].address;
  const gnGampaha = signers[3].address;

  // Get already-deployed shared contracts
  await hre.deployments.get("PoseidonT3"); // ensure deployed
  const leanIMT = await hre.deployments.get("LeanIMT");
  const verifier = await hre.deployments.get("HonkVerifier");

  const question = "2027 Presidential Election — Who should be the next President of Sri Lanka?";
  const candidates = ["Anura Kumara Dissanayake (NPP)", "Sajith Premadasa (SJB)", "Ranil Wickremesinghe (UNP)"];

  // Deploy ElectionRegistry
  const registry = await deploy("ElectionRegistry", {
    from: deployer,
    args: [deployer],
    log: true,
    autoMine: true,
  });

  // Deploy 3 division Voting contracts
  const divisions = [
    { name: "Kaduwela", gn: gnKaduwela, tag: "Voting_Kaduwela" },
    { name: "Colombo Central", gn: gnColombo, tag: "Voting_Colombo" },
    { name: "Gampaha", gn: gnGampaha, tag: "Voting_Gampaha" },
  ];

  for (const div of divisions) {
    const votingDeploy = await deploy(div.tag, {
      contract: "Voting",
      from: deployer,
      args: [deployer, verifier.address, question, candidates],
      libraries: {
        LeanIMT: leanIMT.address,
      },
      log: true,
      autoMine: true,
    });

    // Assign GN officer to this division's contract
    const votingContract = await hre.ethers.getContractAt("Voting", votingDeploy.address);
    await votingContract.setGNOfficer(div.gn);
    console.log(`  ✅ ${div.name}: GN officer set to ${div.gn}`);

    // Register division in the registry — skip if already registered (idempotent).
    const registryContract = await hre.ethers.getContractAt("ElectionRegistry", registry.address);
    const existing = await registryContract.getAllDivisions();
    const alreadyRegistered = existing.some(
      (d: { votingContract: string }) => d.votingContract.toLowerCase() === votingDeploy.address.toLowerCase(),
    );
    if (alreadyRegistered) {
      console.log(`  ↺ ${div.name}: already in ElectionRegistry, skipping`);
    } else {
      await registryContract.addDivision(div.name, votingDeploy.address, div.gn);
      console.log(`  ✅ ${div.name}: registered in ElectionRegistry`);
    }
  }

  console.log("\n🇱🇰 Multi-division election deployed:");
  console.log(`   Registry: ${registry.address}`);
  console.log(`   Divisions: ${divisions.length}`);
  console.log(`   Candidates: ${candidates.join(", ")}`);
  console.log(`   GN Kaduwela: ${gnKaduwela}`);
  console.log(`   GN Colombo:  ${gnColombo}`);
  console.log(`   GN Gampaha:  ${gnGampaha}`);
};

export default deployDivisions;
deployDivisions.tags = ["Divisions"];
deployDivisions.dependencies = ["Voting"]; // Runs after base deploy (shared libs)
