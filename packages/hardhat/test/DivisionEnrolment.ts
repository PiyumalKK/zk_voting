import { expect } from "chai";
import { ethers } from "hardhat";
import { ElectionRegistry, NicRegistry, Voting } from "../typechain-types";

/**
 * What a division created at runtime can and cannot do, and what a client must
 * do to finish setting one up.
 *
 * This file exists because of a real defect. `ElectionRegistry.createDivision()`
 * deploys a `Voting` contract and registers it, and the admin panel's "Add New
 * Division" button called exactly that and reported success. But GN enrolment
 * goes through `NicRegistry.reserveNicHash`, which refuses any division that
 * was never passed to `NicRegistry.setVotingContract` — and nothing called it.
 * The three divisions in `deploy/01_deploy_divisions.ts` are authorised there
 * explicitly, so the sample data hid the gap, and the existing NicRegistry
 * tests authorise their division in `beforeEach`, so the suite hid it too.
 *
 * The contracts are not wrong. `setVotingContract` is `onlyOwner` and the owner
 * is the deployer, not the registry, so `createDivision` *cannot* authorise a
 * division without an ownership change to `NicRegistry`. The requirement is
 * therefore real and permanent, and belongs to whoever creates a division. The
 * fix lives in the admin panel; these tests pin the contract behaviour that fix
 * depends on, so that a later contract change cannot invalidate it silently.
 */
describe("Runtime division enrolment", function () {
  let registry: ElectionRegistry;
  let nicRegistry: NicRegistry;
  let owner: any, gn: any, stranger: any;

  const NIC_HASH = ethers.keccak256(ethers.toUtf8Bytes("199512345678"));

  /** Creates a division through the registry and returns its Voting contract. */
  const createDivision = async (name: string): Promise<Voting> => {
    const before = await registry.getDivisionCount();
    await registry.createDivision(name);
    const divisions = await registry.getAllDivisions();
    expect(await registry.getDivisionCount()).to.equal(before + 1n);
    return (await ethers.getContractAt("Voting", divisions[Number(before)].votingContract)) as unknown as Voting;
  };

  beforeEach(async function () {
    [owner, gn, stranger] = await ethers.getSigners();

    const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
    const poseidon = await PoseidonT3.deploy();

    const LeanIMT = await ethers.getContractFactory("LeanIMT", {
      libraries: { PoseidonT3: await poseidon.getAddress() },
    });
    const leanIMT = await LeanIMT.deploy();

    const Verifier = await ethers.getContractFactory("HonkVerifier");
    const verifier = await Verifier.deploy();

    // NicRegistry first: ElectionRegistry takes it as a constructor argument and
    // hands it to every division it creates, so the factory cannot be built
    // before the registry exists.
    const NicRegistryFactory = await ethers.getContractFactory("NicRegistry");
    nicRegistry = (await NicRegistryFactory.deploy(owner.address)) as NicRegistry;

    const RegistryFactory = await ethers.getContractFactory("ElectionRegistry", {
      libraries: { LeanIMT: await leanIMT.getAddress() },
    });
    registry = (await RegistryFactory.deploy(
      owner.address,
      await verifier.getAddress(),
      await nicRegistry.getAddress(),
    )) as ElectionRegistry;
  });

  describe("a division created at runtime", function () {
    it("is registered in ElectionRegistry and owned by the election authority", async function () {
      const voting = await createDivision("Kandy");
      expect(await voting.owner()).to.equal(owner.address);
      const divisions = await registry.getAllDivisions();
      expect(divisions[0].name).to.equal("Kandy");
      expect(divisions[0].active).to.equal(true);
    });

    it("starts with NO GN officer assigned", async function () {
      const voting = await createDivision("Kandy");
      expect(await voting.getGNOfficers()).to.have.length(0);
    });

    it("is NOT authorised in NicRegistry, so enrolment reverts", async function () {
      // The defect, stated as a test. Note the revert reason is a plain string,
      // not a custom error, so a client cannot match it by error name.
      const voting = await createDivision("Kandy");
      await expect(
        nicRegistry.reserveNicHash(NIC_HASH, await voting.getAddress(), stranger.address),
      ).to.be.revertedWith("Unregistered division");
    });

    it("refuses enrolment even for the contract owner", async function () {
      // The authorisation check runs before the owner/GN check, so being the
      // election authority is no help. Worth pinning: it means the admin cannot
      // work around a missing authorisation by enrolling the voter themselves.
      const voting = await createDivision("Kandy");
      await voting.setGNOfficer(gn.address, true);
      await expect(
        nicRegistry.connect(owner).reserveNicHash(NIC_HASH, await voting.getAddress(), stranger.address),
      ).to.be.revertedWith("Unregistered division");
    });
  });

  describe("once the admin finishes setting the division up", function () {
    it("authorising it in NicRegistry lets the assigned GN enrol a voter", async function () {
      // The two calls the admin panel must make after createDivision. Both are
      // owner-only, and both are needed: authorisation alone leaves the officer
      // list empty, and a GN alone leaves the division unauthorised.
      const voting = await createDivision("Kandy");
      await nicRegistry.setVotingContract(await voting.getAddress(), true);
      await voting.setGNOfficer(gn.address, true);

      await expect(
        nicRegistry.connect(gn).reserveNicHash(NIC_HASH, await voting.getAddress(), stranger.address),
      ).to.emit(nicRegistry, "NicHashReserved");
      await expect(voting.connect(gn).addVoters([stranger.address], [true]))
        .to.emit(voting, "VoterAdded")
        .withArgs(stranger.address);
    });

    it("authorising without assigning a GN still refuses that GN", async function () {
      const voting = await createDivision("Kandy");
      await nicRegistry.setVotingContract(await voting.getAddress(), true);

      await expect(
        nicRegistry.connect(gn).reserveNicHash(NIC_HASH, await voting.getAddress(), stranger.address),
      ).to.be.revertedWith("Not owner or GN");
    });

    it("emits VotingContractUpdated, which is how a client can tell", async function () {
      // `s_votingContracts` is private and has no getter, so the only way for a
      // UI to show whether a division is authorised is to read this event. The
      // admin panel does exactly that; if this event ever changes shape, the
      // authorisation indicator there goes blind.
      const voting = await createDivision("Kandy");
      await expect(nicRegistry.setVotingContract(await voting.getAddress(), true))
        .to.emit(nicRegistry, "VotingContractUpdated")
        .withArgs(await voting.getAddress(), true);
    });

    it("authorisation can be revoked again", async function () {
      const voting = await createDivision("Kandy");
      await nicRegistry.setVotingContract(await voting.getAddress(), true);
      await voting.setGNOfficer(gn.address, true);
      await nicRegistry.setVotingContract(await voting.getAddress(), false);

      await expect(
        nicRegistry.connect(gn).reserveNicHash(NIC_HASH, await voting.getAddress(), stranger.address),
      ).to.be.revertedWith("Unregistered division");
    });

    it("only the owner may authorise a division", async function () {
      const voting = await createDivision("Kandy");
      await expect(
        nicRegistry.connect(stranger).setVotingContract(await voting.getAddress(), true),
      ).to.be.revertedWithCustomError(nicRegistry, "OwnableUnauthorizedAccount");
    });
  });
});
