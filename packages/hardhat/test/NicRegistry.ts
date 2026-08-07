import { expect } from "chai";
import { ethers } from "hardhat";
import { NicRegistry, Voting } from "../typechain-types";

describe("NicRegistry", function () {
  let registry: NicRegistry;
  let voting: Voting;
  let owner: any, gn: any, nonGN: any;

  const NIC_HASH = "0x0db2a9ef1afe7008669f4d3e8bc24575a39c7e9a3eb4908f1b8f56214c9df5ef";

  beforeEach(async function () {
    [owner, gn, nonGN] = await ethers.getSigners();

    const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
    const poseidon = await PoseidonT3.deploy();

    const LeanIMT = await ethers.getContractFactory("LeanIMT", {
      libraries: { PoseidonT3: await poseidon.getAddress() },
    });
    const leanIMT = await LeanIMT.deploy();

    const Verifier = await ethers.getContractFactory("HonkVerifier");
    const verifier = await Verifier.deploy();

    const VotingFactory = await ethers.getContractFactory("Voting", {
      libraries: { LeanIMT: await leanIMT.getAddress() },
    });
    voting = (await VotingFactory.deploy(owner.address, await verifier.getAddress(), "Question", [
      "Yes",
      "No",
    ])) as Voting;

    const NicRegistry = await ethers.getContractFactory("NicRegistry");
    registry = (await NicRegistry.deploy(owner.address)) as NicRegistry;

    await registry.setVotingContract(await voting.getAddress(), true);
    await voting.setGNOfficer(gn.address);
  });

  it("reserves a new NIC hash for the division's GN", async function () {
    await expect(registry.connect(gn).reserveNicHash(NIC_HASH, await voting.getAddress()))
      .to.emit(registry, "NicHashReserved")
      .withArgs(NIC_HASH);
  });

  it("rejects a second reservation of the same hash regardless of caller", async function () {
    await registry.connect(gn).reserveNicHash(NIC_HASH, await voting.getAddress());

    await expect(registry.reserveNicHash(NIC_HASH, await voting.getAddress()))
      .to.be.revertedWithCustomError(registry, "NicRegistry__AlreadyUsed")
      .withArgs(NIC_HASH);
  });

  it("rejects the same NIC hash when a different address attempts to reserve it", async function () {
    await registry.reserveNicHash(NIC_HASH, await voting.getAddress());

    await expect(registry.connect(gn).reserveNicHash(NIC_HASH, await voting.getAddress()))
      .to.be.revertedWithCustomError(registry, "NicRegistry__AlreadyUsed")
      .withArgs(NIC_HASH);
  });

  it("rejects a caller that is neither the owner nor the division's GN", async function () {
    await expect(registry.connect(nonGN).reserveNicHash(NIC_HASH, await voting.getAddress())).to.be.revertedWith(
      "Not owner or GN",
    );
  });

  it("frees every reserved hash when the enrolment epoch is cleared", async function () {
    await registry.connect(gn).reserveNicHash(NIC_HASH, await voting.getAddress());
    expect(await registry.isNicHashUsed(NIC_HASH)).to.equal(true);

    await expect(registry.clearNicHashes()).to.emit(registry, "NicHashesCleared").withArgs(1);

    // Without this a new election could not enrol anyone who took part in the
    // previous one — the reservation outlives the divisions themselves.
    expect(await registry.isNicHashUsed(NIC_HASH)).to.equal(false);
    await expect(registry.connect(gn).reserveNicHash(NIC_HASH, await voting.getAddress())).to.emit(
      registry,
      "NicHashReserved",
    );
  });

  it("still rejects a repeat reservation within the new epoch", async function () {
    await registry.connect(gn).reserveNicHash(NIC_HASH, await voting.getAddress());
    await registry.clearNicHashes();
    await registry.connect(gn).reserveNicHash(NIC_HASH, await voting.getAddress());

    await expect(registry.connect(gn).reserveNicHash(NIC_HASH, await voting.getAddress()))
      .to.be.revertedWithCustomError(registry, "NicRegistry__AlreadyUsed")
      .withArgs(NIC_HASH);
  });

  it("lets only the owner clear NIC hashes", async function () {
    await expect(registry.connect(gn).clearNicHashes()).to.be.revertedWithCustomError(
      registry,
      "OwnableUnauthorizedAccount",
    );
    expect(await registry.getCurrentEpoch()).to.equal(0);
  });

  it("emits a NIC reservation event with only the hash", async function () {
    const event = registry.interface.getEvent("NicHashReserved");
    expect(event?.inputs).to.have.length(1);
    expect(event?.inputs[0].type).to.equal("bytes32");
    expect(event?.inputs.some(input => input.type === "address")).to.equal(false);
  });
});
