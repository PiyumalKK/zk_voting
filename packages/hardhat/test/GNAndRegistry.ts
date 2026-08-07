import { expect } from "chai";
import { ethers } from "hardhat";
import { Voting, ElectionRegistry } from "../typechain-types";

describe("GN Officer & ElectionRegistry", function () {
  let voting: Voting;
  let registry: ElectionRegistry;
  let owner: any, gn: any, voter1: any, voter2: any, nonGN: any;

  beforeEach(async function () {
    [owner, gn, voter1, voter2, nonGN] = await ethers.getSigners();

    // Deploy shared libraries
    const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
    const poseidon = await PoseidonT3.deploy();

    const LeanIMT = await ethers.getContractFactory("LeanIMT", {
      libraries: { PoseidonT3: await poseidon.getAddress() },
    });
    const leanIMT = await LeanIMT.deploy();

    // Deploy verifier
    const Verifier = await ethers.getContractFactory("HonkVerifier");
    const verifier = await Verifier.deploy();

    // Deploy Voting
    const VotingFactory = await ethers.getContractFactory("Voting", {
      libraries: { LeanIMT: await leanIMT.getAddress() },
    });
    voting = (await VotingFactory.deploy(owner.address, await verifier.getAddress(), "Who should be president?", [
      "Candidate A",
      "Candidate B",
      "Candidate C",
    ])) as Voting;

    // Deploy ElectionRegistry (needs LeanIMT linked because it deploys Voting internally via createDivision)
    const RegistryFactory = await ethers.getContractFactory("ElectionRegistry", {
      libraries: { LeanIMT: await leanIMT.getAddress() },
    });
    registry = (await RegistryFactory.deploy(owner.address, await verifier.getAddress())) as ElectionRegistry;
  });

  describe("GN Officer Management", function () {
    it("owner can set GN officer", async function () {
      await expect(voting.setGNOfficer(gn.address)).to.emit(voting, "GNOfficerUpdated").withArgs(gn.address);
      expect(await voting.s_gnOfficer()).to.equal(gn.address);
    });

    it("non-owner cannot set GN officer", async function () {
      await expect(voting.connect(gn).setGNOfficer(gn.address)).to.be.revertedWithCustomError(
        voting,
        "OwnableUnauthorizedAccount",
      );
    });

    it("GN can add voters during Setup phase", async function () {
      await voting.setGNOfficer(gn.address);
      await expect(voting.connect(gn).addVoters([voter1.address], [true]))
        .to.emit(voting, "VoterAdded")
        .withArgs(voter1.address);
    });

    it("GN can add voters during Registration phase", async function () {
      await voting.setGNOfficer(gn.address);
      // Move to Registration
      await voting.startRegistration(3600);
      await expect(voting.connect(gn).addVoters([voter2.address], [true]))
        .to.emit(voting, "VoterAdded")
        .withArgs(voter2.address);
    });

    it("non-GN cannot add voters", async function () {
      await voting.setGNOfficer(gn.address);
      await expect(voting.connect(nonGN).addVoters([voter1.address], [true])).to.be.revertedWith("Not owner or GN");
    });

    it("GN cannot add voters during Voting phase", async function () {
      await voting.setGNOfficer(gn.address);
      await voting.addVoters([voter1.address], [true]);
      await voting.startRegistration(3600);
      await voting.startVoting(3600);
      await expect(voting.connect(gn).addVoters([voter2.address], [true])).to.be.revertedWithCustomError(
        voting,
        "Voting__SetupOrRegistrationRequired",
      );
    });

    it("owner can still add voters (backwards compatible)", async function () {
      await expect(voting.addVoters([voter1.address, voter2.address], [true, true])).to.emit(voting, "VoterAdded");
    });
  });

  describe("ElectionRegistry", function () {
    it("owner can add a division", async function () {
      await expect(registry.addDivision("Kaduwela", await voting.getAddress(), gn.address))
        .to.emit(registry, "DivisionAdded")
        .withArgs(0, "Kaduwela", await voting.getAddress(), gn.address);
    });

    it("non-owner cannot add division", async function () {
      await expect(
        registry.connect(gn).addDivision("Test", await voting.getAddress(), gn.address),
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("returns correct division count", async function () {
      await registry.addDivision("Kaduwela", await voting.getAddress(), gn.address);
      await registry.addDivision("Colombo", await voting.getAddress(), gn.address);
      expect(await registry.getDivisionCount()).to.equal(2);
    });

    it("returns all divisions", async function () {
      await registry.addDivision("Kaduwela", await voting.getAddress(), gn.address);
      await registry.addDivision("Colombo", await voting.getAddress(), gn.address);
      const divs = await registry.getAllDivisions();
      expect(divs.length).to.equal(2);
      expect(divs[0].name).to.equal("Kaduwela");
      expect(divs[1].name).to.equal("Colombo");
    });

    it("getNationalVoteCount aggregates across divisions", async function () {
      // Register the same voting contract as 2 "divisions" (for testing)
      await registry.addDivision("Div1", await voting.getAddress(), gn.address);
      await registry.addDivision("Div2", await voting.getAddress(), gn.address);

      // Before any votes, national count should be 0
      const count = await registry.getNationalVoteCount(0);
      expect(count).to.equal(0);
    });

    it("owner can update division", async function () {
      await registry.addDivision("Kaduwela", await voting.getAddress(), gn.address);
      await expect(registry.updateDivision(0, await voting.getAddress(), nonGN.address)).to.emit(
        registry,
        "DivisionUpdated",
      );
      const div = await registry.divisions(0);
      expect(div.gnOfficer).to.equal(nonGN.address);
    });

    it("owner can clear every division", async function () {
      await registry.addDivision("Kaduwela", await voting.getAddress(), gn.address);
      await registry.addDivision("Colombo", await voting.getAddress(), gn.address);

      await expect(registry.clearDivisions()).to.emit(registry, "DivisionsCleared").withArgs(2);

      expect(await registry.getDivisionCount()).to.equal(0);
      expect(await registry.getAllDivisions()).to.have.length(0);
    });

    it("restarts division ids at zero after clearing", async function () {
      await registry.addDivision("Kaduwela", await voting.getAddress(), gn.address);
      await registry.clearDivisions();

      await expect(registry.addDivision("Matara", await voting.getAddress(), gn.address))
        .to.emit(registry, "DivisionAdded")
        .withArgs(0, "Matara", await voting.getAddress(), gn.address);
    });

    it("non-owner cannot clear divisions", async function () {
      await registry.addDivision("Kaduwela", await voting.getAddress(), gn.address);
      await expect(registry.connect(gn).clearDivisions()).to.be.revertedWithCustomError(
        registry,
        "OwnableUnauthorizedAccount",
      );
      expect(await registry.getDivisionCount()).to.equal(1);
    });
  });
});
