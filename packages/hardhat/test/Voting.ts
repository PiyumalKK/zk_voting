import { expect } from "chai";
import { ethers } from "hardhat";
import { Voting } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Voting", function () {
  let voting: Voting;
  let owner: HardhatEthersSigner;
  let voter1: HardhatEthersSigner;
  let voter2: HardhatEthersSigner;
  let nonVoter: HardhatEthersSigner;

  const QUESTION = "Do you support this proposal?";
  // Arbitrary test commitments (simulating poseidon hashes)
  const COMMITMENT_1 = 12345678901234567890n;
  const COMMITMENT_2 = 98765432109876543210n;

  beforeEach(async function () {
    [owner, voter1, voter2, nonVoter] = await ethers.getSigners();

    // Deploy PoseidonT3
    const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
    const poseidonT3 = await PoseidonT3.deploy();
    await poseidonT3.waitForDeployment();

    // Deploy LeanIMT linked to PoseidonT3
    const LeanIMT = await ethers.getContractFactory("LeanIMT", {
      libraries: {
        PoseidonT3: await poseidonT3.getAddress(),
      },
    });
    const leanIMT = await LeanIMT.deploy();
    await leanIMT.waitForDeployment();

    // Deploy placeholder verifier
    const Verifier = await ethers.getContractFactory("HonkVerifier");
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();

    // Deploy Voting linked to LeanIMT
    const VotingFactory = await ethers.getContractFactory("Voting", {
      libraries: {
        LeanIMT: await leanIMT.getAddress(),
      },
    });
    voting = (await VotingFactory.deploy(
      owner.address,
      await verifier.getAddress(),
      QUESTION,
    )) as Voting;
    await voting.waitForDeployment();

    // Add voter1 and voter2 to the allowlist
    await voting.addVoters([voter1.address, voter2.address], [true, true]);
  });

  describe("Registration", function () {
    it("should allow an allowlisted voter to register a commitment", async function () {
      const tx = await voting.connect(voter1).register(COMMITMENT_1);

      await expect(tx)
        .to.emit(voting, "NewLeaf")
        .withArgs(0, COMMITMENT_1);
    });

    it("should update voter registration status after registering", async function () {
      await voting.connect(voter1).register(COMMITMENT_1);

      const [voter, registered] = await voting.getVoterData(voter1.address);
      expect(voter).to.be.true;
      expect(registered).to.be.true;
    });

    it("should update tree root and depth after registration", async function () {
      await voting.connect(voter1).register(COMMITMENT_1);

      const data = await voting.getVotingData();
      // After one leaf, root equals the leaf itself and depth is 0
      expect(data.root).to.not.equal(0n);
      expect(data.depth).to.equal(0n);
    });

    it("should handle multiple registrations and increment tree depth", async function () {
      await voting.connect(voter1).register(COMMITMENT_1);
      await voting.connect(voter2).register(COMMITMENT_2);

      const data = await voting.getVotingData();
      expect(data.root).to.not.equal(0n);
      expect(data.depth).to.equal(1n);
    });

    it("should emit NewLeaf with correct sequential indices", async function () {
      await expect(voting.connect(voter1).register(COMMITMENT_1))
        .to.emit(voting, "NewLeaf")
        .withArgs(0, COMMITMENT_1);

      await expect(voting.connect(voter2).register(COMMITMENT_2))
        .to.emit(voting, "NewLeaf")
        .withArgs(1, COMMITMENT_2);
    });

    it("should revert if caller is not on the allowlist", async function () {
      await expect(voting.connect(nonVoter).register(COMMITMENT_1))
        .to.be.revertedWithCustomError(voting, "Voting__NotAllowedToVote");
    });

    it("should revert if caller already registered", async function () {
      await voting.connect(voter1).register(COMMITMENT_1);

      await expect(voting.connect(voter1).register(COMMITMENT_2))
        .to.be.revertedWithCustomError(voting, "Voting__NotAllowedToVote");
    });

    it("should revert if commitment was already used", async function () {
      await voting.connect(voter1).register(COMMITMENT_1);

      await expect(voting.connect(voter2).register(COMMITMENT_1))
        .to.be.revertedWithCustomError(voting, "Voting__CommitmentAlreadyAdded")
        .withArgs(COMMITMENT_1);
    });
  });

  describe("View Functions", function () {
    it("should return correct voting data before any registration", async function () {
      const data = await voting.getVotingData();
      expect(data.question).to.equal(QUESTION);
      expect(data.contractOwner).to.equal(owner.address);
      expect(data.yesVotes).to.equal(0n);
      expect(data.noVotes).to.equal(0n);
      expect(data.root).to.equal(0n);
      expect(data.depth).to.equal(0n);
      expect(data.size).to.equal(0n);
    });

    it("should return correct voter data for non-allowlisted address", async function () {
      const [voter, registered] = await voting.getVoterData(nonVoter.address);
      expect(voter).to.be.false;
      expect(registered).to.be.false;
    });

    it("should return correct voter data for allowlisted but unregistered voter", async function () {
      const [voter, registered] = await voting.getVoterData(voter1.address);
      expect(voter).to.be.true;
      expect(registered).to.be.false;
    });
  });
});
