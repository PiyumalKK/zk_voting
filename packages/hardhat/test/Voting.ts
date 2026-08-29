import { expect } from "chai";
import { ethers } from "hardhat";
import { NicRegistry, Voting } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Voting", function () {
  let voting: Voting;
  let owner: HardhatEthersSigner;
  let voter1: HardhatEthersSigner;
  let voter2: HardhatEthersSigner;
  let nonVoter: HardhatEthersSigner;
  let leanIMTAddr: string;
  let verifierAddr: string;
  let nicRegistryAddr: string;
  let nicRegistry: NicRegistry;

  const QUESTION = "Do you support this proposal?";
  const CANDIDATES = ["Yes", "No"];
  const REG_DURATION = 3600; // 1 hour
  const VOTE_DURATION = 3600; // 1 hour
  const COMMITMENT_1 = 12345678901234567890n;
  const COMMITMENT_2 = 98765432109876543210n;

  // Mirror of Voting.Phase enum
  const Phase = { Setup: 0, Registration: 1, Voting: 2, Ended: 3 } as const;

  /**
   * Bind an address to a NIC in the registry, the way a GN officer would.
   *
   * `register()` will not accept a device the registry has never seen, so a bare
   * `addVoters` no longer produces a voter who can register. The NIC hash is
   * derived from the address purely so that each test voter is a distinct
   * citizen; nothing here asserts on it.
   */
  async function enrol(device: string, voting_?: Voting): Promise<void> {
    const target = voting_ ?? voting;
    await nicRegistry.reserveNicHash(ethers.keccak256(device), await target.getAddress(), device);
  }

  async function deployFresh(): Promise<Voting> {
    const VotingFactory = await ethers.getContractFactory("Voting", {
      libraries: { LeanIMT: leanIMTAddr },
    });
    const v = (await VotingFactory.deploy(
      owner.address,
      verifierAddr,
      nicRegistryAddr,
      QUESTION,
      CANDIDATES,
    )) as Voting;
    await v.waitForDeployment();
    // Authorised here rather than at each call site: an unauthorised division
    // cannot call `commitDevice`, so `register()` would fail on every fresh
    // contract for a reason none of these tests is about.
    await nicRegistry.setVotingContract(await v.getAddress(), true);
    return v;
  }

  beforeEach(async function () {
    [owner, voter1, voter2, nonVoter] = await ethers.getSigners();

    const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
    const poseidonT3 = await PoseidonT3.deploy();
    await poseidonT3.waitForDeployment();

    const LeanIMT = await ethers.getContractFactory("LeanIMT", {
      libraries: { PoseidonT3: await poseidonT3.getAddress() },
    });
    const leanIMT = await LeanIMT.deploy();
    await leanIMT.waitForDeployment();
    leanIMTAddr = await leanIMT.getAddress();

    const Verifier = await ethers.getContractFactory("HonkVerifier");
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();
    verifierAddr = await verifier.getAddress();

    // Every division defers to a NicRegistry, and `register()` refuses any
    // device that was not enrolled against a NIC there — the allowlist alone is
    // no longer enough. So this fixture performs the *whole* enrolment a GN
    // officer performs, not just the allowlist half, and the tests below are
    // still about the address-level behaviour they were always about.
    const NicRegistryFactory = await ethers.getContractFactory("NicRegistry");
    nicRegistry = (await NicRegistryFactory.deploy(owner.address)) as NicRegistry;
    await nicRegistry.waitForDeployment();
    nicRegistryAddr = await nicRegistry.getAddress();

    voting = await deployFresh();
    await nicRegistry.setVotingContract(await voting.getAddress(), true);

    // Setup phase: enrol + allowlist voters, then open registration.
    await enrol(voter1.address);
    await enrol(voter2.address);
    await voting.addVoters([voter1.address, voter2.address], [true, true]);
    await voting.startRegistration(REG_DURATION);
  });

  describe("Setup", function () {
    it("starts in Setup phase before startRegistration is called", async function () {
      const fresh = await deployFresh();
      expect(await fresh.currentPhase()).to.equal(Phase.Setup);
    });

    it("exposes candidates via getCandidates", async function () {
      expect(await voting.getCandidates()).to.deep.equal(CANDIDATES);
    });

    it("rejects setQuestion outside Setup phase", async function () {
      await expect(voting.setQuestion("new?")).to.be.revertedWithCustomError(voting, "Voting__WrongPhase");
    });

    it("allows addVoters during Registration phase", async function () {
      // Current phase is Registration (from beforeEach)
      await expect(voting.addVoters([nonVoter.address], [true]))
        .to.emit(voting, "VoterAdded")
        .withArgs(nonVoter.address);
    });

    it("rejects addVoters during Voting and Ended phases", async function () {
      // Advance to Voting
      await voting.startVoting(3600);
      await expect(voting.addVoters([nonVoter.address], [true])).to.be.revertedWithCustomError(
        voting,
        "Voting__SetupOrRegistrationRequired",
      );

      // Advance to Ended
      await voting.endElection();
      await expect(voting.addVoters([nonVoter.address], [true])).to.be.revertedWithCustomError(
        voting,
        "Voting__SetupOrRegistrationRequired",
      );
    });

    it("rejects setCandidates with too many entries", async function () {
      const fresh = await deployFresh();
      const tooMany = Array.from({ length: 101 }, (_, i) => `c${i}`);
      await expect(fresh.setCandidates(tooMany)).to.be.revertedWithCustomError(fresh, "Voting__TooManyCandidates");
    });

    it("rejects setCandidates with empty list", async function () {
      const fresh = await deployFresh();
      await expect(fresh.setCandidates([])).to.be.revertedWithCustomError(fresh, "Voting__NoCandidates");
    });

    it("rejects startRegistration with zero duration", async function () {
      const fresh = await deployFresh();
      await expect(fresh.startRegistration(0)).to.be.revertedWithCustomError(fresh, "Voting__InvalidDuration");
    });
  });

  describe("Registration", function () {
    it("is in Registration phase", async function () {
      expect(await voting.currentPhase()).to.equal(Phase.Registration);
    });

    it("allows an allowlisted voter to register a commitment", async function () {
      await expect(voting.connect(voter1).register(COMMITMENT_1)).to.emit(voting, "NewLeaf").withArgs(0, COMMITMENT_1);
    });

    it("updates voter registration status", async function () {
      await voting.connect(voter1).register(COMMITMENT_1);
      const [voter, registered] = await voting.getVoterData(voter1.address);
      expect(voter).to.equal(true);
      expect(registered).to.equal(true);
    });

    it("updates tree root and depth", async function () {
      await voting.connect(voter1).register(COMMITMENT_1);
      const data = await voting.getVotingData();
      expect(data.root).to.not.equal(0n);
      expect(data.depth).to.equal(0n);
    });

    it("handles multiple registrations and increments depth", async function () {
      await voting.connect(voter1).register(COMMITMENT_1);
      await voting.connect(voter2).register(COMMITMENT_2);
      const data = await voting.getVotingData();
      expect(data.depth).to.equal(1n);
    });

    it("emits NewLeaf with sequential indices", async function () {
      await expect(voting.connect(voter1).register(COMMITMENT_1)).to.emit(voting, "NewLeaf").withArgs(0, COMMITMENT_1);
      await expect(voting.connect(voter2).register(COMMITMENT_2)).to.emit(voting, "NewLeaf").withArgs(1, COMMITMENT_2);
    });

    it("reverts if caller is not on the allowlist", async function () {
      await expect(voting.connect(nonVoter).register(COMMITMENT_1)).to.be.revertedWithCustomError(
        voting,
        "Voting__NotAllowedToVote",
      );
    });

    it("reverts if caller already registered", async function () {
      await voting.connect(voter1).register(COMMITMENT_1);
      await expect(voting.connect(voter1).register(COMMITMENT_2)).to.be.revertedWithCustomError(
        voting,
        "Voting__NotAllowedToVote",
      );
    });

    it("reverts if commitment was already used", async function () {
      await voting.connect(voter1).register(COMMITMENT_1);
      await expect(voting.connect(voter2).register(COMMITMENT_1))
        .to.be.revertedWithCustomError(voting, "Voting__CommitmentAlreadyAdded")
        .withArgs(COMMITMENT_1);
    });

    it("reverts register() once Voting phase has started", async function () {
      await voting.startVoting(VOTE_DURATION);
      await expect(voting.connect(voter1).register(COMMITMENT_1)).to.be.revertedWithCustomError(
        voting,
        "Voting__WrongPhase",
      );
    });
  });

  describe("Phase transitions", function () {
    it("advances Registration → Voting via startVoting", async function () {
      await voting.startVoting(VOTE_DURATION);
      expect(await voting.currentPhase()).to.equal(Phase.Voting);
    });

    it("auto-advances Registration → Ended after deadline", async function () {
      await ethers.provider.send("evm_increaseTime", [REG_DURATION + 1]);
      await ethers.provider.send("evm_mine", []);
      expect(await voting.currentPhase()).to.equal(Phase.Ended);
    });

    it("auto-advances Voting → Ended after deadline", async function () {
      await voting.startVoting(VOTE_DURATION);
      await ethers.provider.send("evm_increaseTime", [VOTE_DURATION + 1]);
      await ethers.provider.send("evm_mine", []);
      expect(await voting.currentPhase()).to.equal(Phase.Ended);
    });

    it("admin can endElection early during Voting", async function () {
      await voting.startVoting(VOTE_DURATION);
      await voting.endElection();
      expect(await voting.currentPhase()).to.equal(Phase.Ended);
    });

    it("non-owner cannot call startVoting", async function () {
      await expect(voting.connect(voter1).startVoting(VOTE_DURATION)).to.be.revertedWithCustomError(
        voting,
        "OwnableUnauthorizedAccount",
      );
    });

    it("non-owner cannot call endElection", async function () {
      await voting.startVoting(VOTE_DURATION);
      await expect(voting.connect(voter1).endElection()).to.be.revertedWithCustomError(
        voting,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  describe("View Functions", function () {
    it("returns correct voting data before any registration", async function () {
      const data = await voting.getVotingData();
      expect(data.question).to.equal(QUESTION);
      expect(data.contractOwner).to.equal(owner.address);
      expect(data.phase).to.equal(Phase.Registration);
      expect(data.candidateCount).to.equal(BigInt(CANDIDATES.length));
      expect(data.root).to.equal(0n);
      expect(data.depth).to.equal(0n);
      expect(data.size).to.equal(0n);
    });

    it("getVoteCounts returns zeros for a fresh election", async function () {
      const counts = await voting.getVoteCounts();
      expect(counts.length).to.equal(CANDIDATES.length);
      counts.forEach(c => expect(c).to.equal(0n));
    });

    it("returns correct voter data for non-allowlisted address", async function () {
      const [voter, registered] = await voting.getVoterData(nonVoter.address);
      expect(voter).to.equal(false);
      expect(registered).to.equal(false);
    });

    it("returns correct voter data for allowlisted but unregistered voter", async function () {
      const [voter, registered] = await voting.getVoterData(voter1.address);
      expect(voter).to.equal(true);
      expect(registered).to.equal(false);
    });
  });

  describe("Reset / multi-election", function () {
    it("starts at election id 0", async function () {
      expect(await voting.getCurrentElectionId()).to.equal(0n);
    });

    it("owner can reset from Registration and returns to Setup", async function () {
      await voting.resetElection();
      expect(await voting.currentPhase()).to.equal(Phase.Setup);
      expect(await voting.getCurrentElectionId()).to.equal(1n);
    });

    it("emits ElectionReset with the new id", async function () {
      await expect(voting.resetElection()).to.emit(voting, "ElectionReset").withArgs(1n);
    });

    it("non-owner cannot reset", async function () {
      await expect(voting.connect(voter1).resetElection()).to.be.revertedWithCustomError(
        voting,
        "OwnableUnauthorizedAccount",
      );
    });

    it("clears question and candidates after reset", async function () {
      await voting.resetElection();
      const data = await voting.getVotingData();
      expect(data.question).to.equal("");
      expect(data.candidateCount).to.equal(0n);
      expect((await voting.getCandidates()).length).to.equal(0);
    });

    it("clears voter allowlist and registrations after reset", async function () {
      await voting.connect(voter1).register(COMMITMENT_1);
      await voting.resetElection();
      const [voter, registered] = await voting.getVoterData(voter1.address);
      expect(voter).to.equal(false);
      expect(registered).to.equal(false);
    });

    it("resets the Merkle tree to empty after reset", async function () {
      await voting.connect(voter1).register(COMMITMENT_1);
      await voting.resetElection();
      const data = await voting.getVotingData();
      expect(data.size).to.equal(0n);
      expect(data.root).to.equal(0n);
    });

    it("supports a full second election after reset", async function () {
      await voting.resetElection();
      await voting.setQuestion("Round 2?");
      await voting.setCandidates(["A", "B", "C"]);
      await voting.addVoters([voter1.address], [true]);
      await voting.startRegistration(REG_DURATION);
      expect(await voting.currentPhase()).to.equal(Phase.Registration);

      // A commitment reused from election 0 is allowed again in election 1.
      await expect(voting.connect(voter1).register(COMMITMENT_1)).to.emit(voting, "NewLeaf").withArgs(0, COMMITMENT_1);

      const data = await voting.getVotingData();
      expect(data.question).to.equal("Round 2?");
      expect(data.candidateCount).to.equal(3n);
    });

    it("owner can reset from Ended phase", async function () {
      await voting.startVoting(VOTE_DURATION);
      await voting.endElection();
      expect(await voting.currentPhase()).to.equal(Phase.Ended);
      await voting.resetElection();
      expect(await voting.currentPhase()).to.equal(Phase.Setup);
    });
  });
});
