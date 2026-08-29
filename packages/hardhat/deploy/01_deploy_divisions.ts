import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

/**
 * Deploy ElectionRegistry + 3 sample division Voting contracts.
 * This simulates a multi-constituency Sri Lankan election.
 *
 * **GN officers are assigned only in hardhat mode**, where an officer *is* a
 * wallet:
 *   - Account #0 (deployer): Election Authority (admin/owner)
 *   - Account #1: GN Officer — Kaduwela
 *   - Account #2: GN Officer — Colombo Central
 *   - Account #3: GN Officer — Gampaha
 *
 * On the custom chain an officer is a credential account whose signing key the
 * server holds (`01-AUTH-DESIGN.md` §2), and its address is not knowable at
 * deploy time. Writing Hardhat addresses there — which is what this script used
 * to do on every network, because `hardhat.config.ts` signs custom-network
 * deploys with the `test test … junk` mnemonic — left a freshly deployed chain
 * *looking* staffed while nobody could actually sign in: the admin panel showed
 * every division "Assigned" to a key that exists nowhere in the deployment.
 * Divisions are therefore left unassigned here, and the Election Authority binds
 * a real officer by creating their account in Admin → Divisions.
 */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const deployDivisions: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;
  const signers = await hre.ethers.getSigners();

  // The custom Go node holds no keys, so a wallet address means nothing to it as
  // an identity. Detected by network name rather than chain id so a re-pointed
  // `CUSTOM_CHAIN_ID` cannot silently reintroduce the wallet assumption.
  const isCustomChain = hre.network.name === "custom";

  // GN officers from Hardhat accounts.
  // Kaduwela is assigned to the deployer (account #0) so the admin can also drive
  // the GN portal from a single wallet during the demo. Colombo/Gampaha use #2/#3.
  const gnKaduwela = isCustomChain ? ZERO_ADDRESS : deployer;
  const gnColombo = isCustomChain ? ZERO_ADDRESS : signers[2].address;
  const gnGampaha = isCustomChain ? ZERO_ADDRESS : signers[3].address;

  // Get already-deployed shared contracts
  await hre.deployments.get("PoseidonT3"); // ensure deployed
  const leanIMT = await hre.deployments.get("LeanIMT");
  const verifier = await hre.deployments.get("HonkVerifier");
  // Deployed by 00, which must run first: a Voting contract's NicRegistry is a
  // constructor argument and immutable, and ElectionRegistry passes the same
  // address on to every division it creates at runtime.
  const nicRegistry = await hre.deployments.get("NicRegistry");

  const question = "2027 Presidential Election — Who should be the next President of Sri Lanka?";
  const candidates = ["Anura Kumara Dissanayake (NPP)", "Sajith Premadasa (SJB)", "Ranil Wickremesinghe (UNP)"];

  // Deploy ElectionRegistry — now linked against LeanIMT because it acts as a
  // factory that deploys Voting contracts (which use the LeanIMT library).
  const registry = await deploy("ElectionRegistry", {
    from: deployer,
    args: [deployer, verifier.address, nicRegistry.address],
    libraries: {
      LeanIMT: leanIMT.address,
    },
    log: true,
    autoMine: true,
  });

  const nicRegistryContract = await hre.ethers.getContractAt("NicRegistry", nicRegistry.address);

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
      args: [deployer, verifier.address, nicRegistry.address, question, candidates],
      libraries: {
        LeanIMT: leanIMT.address,
      },
      log: true,
      autoMine: true,
    });

    // Assign GN officer to this division's contract.
    //
    // Skipped entirely on the custom chain rather than written as the zero
    // address: re-running the deploy there must not clobber an officer the
    // Election Authority has already bound to a credential account. `deploy()`
    // is idempotent, but this call was not — it fired on every run.
    const votingContract = await hre.ethers.getContractAt("Voting", votingDeploy.address);
    if (isCustomChain) {
      const current = await votingContract.s_gnOfficer();
      console.log(
        current === ZERO_ADDRESS
          ? `  ⏭  ${div.name}: GN officer left unassigned — create the officer's account in Admin → Divisions`
          : `  ↺ ${div.name}: GN officer already bound to ${current}, left as-is`,
      );
    } else {
      await votingContract.setGNOfficer(div.gn);
      console.log(`  ✅ ${div.name}: GN officer set to ${div.gn}`);
    }

    // Authorisation now gates `register()` as well as enrolment — an
    // unauthorised division cannot accept a leaf from an enrolled device — so a
    // re-run must repair it rather than assume it.
    if (await nicRegistryContract.isVotingContractAuthorized(votingDeploy.address)) {
      console.log(`  ↺ ${div.name}: already allowlisted in NicRegistry`);
    } else {
      await nicRegistryContract.setVotingContract(votingDeploy.address, true);
      console.log(`  ✅ ${div.name}: allowlisted in NicRegistry`);
    }

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
  console.log(`   NicRegistry: ${nicRegistry.address}`);
  console.log(`   Divisions: ${divisions.length}`);
  console.log(`   Candidates: ${candidates.join(", ")}`);
  if (isCustomChain) {
    console.log("\n⚠️  No GN officers are assigned — this chain is not yet ready to enrol voters.");
    console.log("   Officers authenticate with credentials here, not wallets, so their addresses");
    console.log("   cannot be known at deploy time. Sign in as the Election Authority and create");
    console.log("   one account per division in Admin → Divisions → GN Officer Accounts; that");
    console.log("   generates the signing key and binds it on-chain via setGNOfficer.");
  } else {
    console.log(`   GN Kaduwela: ${gnKaduwela}`);
    console.log(`   GN Colombo:  ${gnColombo}`);
    console.log(`   GN Gampaha:  ${gnGampaha}`);
  }
};

export default deployDivisions;
deployDivisions.tags = ["Divisions"];
deployDivisions.dependencies = ["Voting"]; // Runs after base deploy (shared libs)
