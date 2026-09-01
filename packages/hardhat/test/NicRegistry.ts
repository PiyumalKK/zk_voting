import { expect } from "chai";
import { ethers } from "hardhat";
import { NicRegistry, Voting } from "../typechain-types";

/**
 * The identity ledger: one NIC, one division, one live device, one leaf.
 *
 * The second half of this file is about device re-issue, and the case it exists
 * to pin is the fraud rather than the accident: a voter who enrols, deliberately
 * does *not* register, claims a false loss, is issued a second device, and tries
 * to register both. Nothing downstream can catch that — Merkle leaves are
 * unlinkable and `vote()` only checks nullifier freshness — so if these tests
 * pass and that voter still gets two leaves, the system has no defence at all.
 */
describe("NicRegistry", function () {
  let registry: NicRegistry;
  let voting: Voting;
  let owner: any, gn: any, nonGN: any, device1: any, device2: any, device3: any;

  const NIC_HASH = "0x0db2a9ef1afe7008669f4d3e8bc24575a39c7e9a3eb4908f1b8f56214c9df5ef";
  const OTHER_NIC_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111";
  const COMMITMENT_1 = 12345678901234567890n;
  const COMMITMENT_2 = 98765432109876543210n;
  const REG_DURATION = 3600;

  const DeviceStatus = { Unbound: 0n, Live: 1n, Superseded: 2n } as const;

  /** Address of the division under test — used constantly below. */
  let votingAddr: string;

  beforeEach(async function () {
    [owner, gn, nonGN, device1, device2, device3] = await ethers.getSigners();

    const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
    const poseidon = await PoseidonT3.deploy();

    const LeanIMT = await ethers.getContractFactory("LeanIMT", {
      libraries: { PoseidonT3: await poseidon.getAddress() },
    });
    const leanIMT = await LeanIMT.deploy();

    const Verifier = await ethers.getContractFactory("HonkVerifier");
    const verifier = await Verifier.deploy();

    const NicRegistry = await ethers.getContractFactory("NicRegistry");
    registry = (await NicRegistry.deploy(owner.address)) as NicRegistry;

    const VotingFactory = await ethers.getContractFactory("Voting", {
      libraries: { LeanIMT: await leanIMT.getAddress() },
    });
    voting = (await VotingFactory.deploy(
      owner.address,
      await verifier.getAddress(),
      await registry.getAddress(),
      "Question",
      ["Yes", "No"],
    )) as Voting;
    votingAddr = await voting.getAddress();

    await registry.setVotingContract(votingAddr, true);
    await voting.setGNOfficer(gn.address, true);
  });

  /** The full enrolment a GN performs: reserve the NIC, allowlist the device. */
  const enrol = async (nicHash: string, device: any) => {
    await registry.connect(gn).reserveNicHash(nicHash, votingAddr, device.address);
    await voting.connect(gn).addVoters([device.address], [true]);
  };

  describe("first enrolment", function () {
    it("reserves a new NIC hash for the division's GN", async function () {
      await expect(registry.connect(gn).reserveNicHash(NIC_HASH, votingAddr, device1.address))
        .to.emit(registry, "NicHashReserved")
        .withArgs(NIC_HASH);
    });

    it("binds the scanned device to the NIC", async function () {
      await registry.connect(gn).reserveNicHash(NIC_HASH, votingAddr, device1.address);

      const [status, nicHash] = await registry.getDeviceStatus(device1.address);
      expect(status).to.equal(DeviceStatus.Live);
      expect(nicHash).to.equal(NIC_HASH);

      const enrolment = await registry.getEnrolment(NIC_HASH);
      expect(enrolment.votingContract).to.equal(votingAddr);
      expect(enrolment.device).to.equal(device1.address);
      expect(enrolment.committed).to.equal(false);
      expect(enrolment.issueCount).to.equal(0);
    });

    it("rejects a second reservation of the same hash regardless of caller", async function () {
      await registry.connect(gn).reserveNicHash(NIC_HASH, votingAddr, device1.address);

      await expect(registry.reserveNicHash(NIC_HASH, votingAddr, device2.address))
        .to.be.revertedWithCustomError(registry, "NicRegistry__AlreadyUsed")
        .withArgs(NIC_HASH);
    });

    it("rejects the same NIC hash when a different address attempts to reserve it", async function () {
      await registry.reserveNicHash(NIC_HASH, votingAddr, device1.address);

      await expect(registry.connect(gn).reserveNicHash(NIC_HASH, votingAddr, device2.address))
        .to.be.revertedWithCustomError(registry, "NicRegistry__AlreadyUsed")
        .withArgs(NIC_HASH);
    });

    it("refuses to bind one device to two different NICs", async function () {
      await registry.connect(gn).reserveNicHash(NIC_HASH, votingAddr, device1.address);

      await expect(registry.connect(gn).reserveNicHash(OTHER_NIC_HASH, votingAddr, device1.address))
        .to.be.revertedWithCustomError(registry, "NicRegistry__DeviceInUse")
        .withArgs(device1.address);
    });

    it("refuses the zero address as a device", async function () {
      await expect(
        registry.connect(gn).reserveNicHash(NIC_HASH, votingAddr, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(registry, "NicRegistry__ZeroDevice");
    });

    it("rejects a caller that is neither the owner nor the division's GN", async function () {
      await expect(registry.connect(nonGN).reserveNicHash(NIC_HASH, votingAddr, device1.address)).to.be.revertedWith(
        "Not owner or GN",
      );
    });

    it("emits a NIC reservation event with only the hash", async function () {
      // Routine enrolment must not publish a nicHash → device link in the logs.
      // The link exists in storage (re-issue cannot work without it) but the
      // event is what a log scraper sees cheaply, so it stays address-free.
      const event = registry.interface.getEvent("NicHashReserved");
      expect(event?.inputs).to.have.length(1);
      expect(event?.inputs[0].type).to.equal("bytes32");
      expect(event?.inputs.some(input => input.type === "address")).to.equal(false);
    });
  });

  describe("registering in the Merkle tree", function () {
    beforeEach(async function () {
      await enrol(NIC_HASH, device1);
      await voting.startRegistration(REG_DURATION);
    });

    it("lets the live device register, and marks the NIC committed", async function () {
      await expect(voting.connect(device1).register(COMMITMENT_1)).to.emit(voting, "NewLeaf");
      expect((await registry.getEnrolment(NIC_HASH)).committed).to.equal(true);
    });

    it("emits a commitment event carrying no device address", async function () {
      await expect(voting.connect(device1).register(COMMITMENT_1))
        .to.emit(registry, "NicHashCommitted")
        .withArgs(NIC_HASH, votingAddr);
    });

    it("refuses a device the allowlist added but no officer enrolled", async function () {
      // Being on the roll is necessary, not sufficient. `addVoters` alone means
      // nobody checked an identity document against this address, so it cannot
      // register — which is what stops a colluding officer allowlisting a second
      // address for someone they already enrolled properly.
      await voting.connect(gn).addVoters([nonGN.address], [true]);

      expect((await voting.getVoterData(nonGN.address)).voter).to.equal(true);
      await expect(voting.connect(nonGN).register(COMMITMENT_2))
        .to.be.revertedWithCustomError(registry, "NicRegistry__DeviceNotEnrolled")
        .withArgs(nonGN.address);
    });

    it("scopes the one-leaf rule to the NIC, not to the division", async function () {
      // A second, genuinely different citizen in the same division is unaffected
      // — the guard must be per-person, not a per-division registration cap.
      await voting.connect(device1).register(COMMITMENT_1);
      await registry.connect(gn).reserveNicHash(OTHER_NIC_HASH, votingAddr, device2.address);
      await voting.connect(gn).addVoters([device2.address], [true]);

      // device2 is a *different* NIC, so it may register — the guard is per-NIC,
      // not per-division.
      await expect(voting.connect(device2).register(COMMITMENT_2)).to.emit(voting, "NewLeaf");
    });
  });

  describe("re-issuing a device before registration", function () {
    beforeEach(async function () {
      await enrol(NIC_HASH, device1);
    });

    it("binds the new device and supersedes the old one in one call", async function () {
      await expect(registry.connect(gn).reissueDevice(NIC_HASH, votingAddr, device2.address))
        .to.emit(registry, "DeviceReissued")
        .withArgs(NIC_HASH, device1.address, device2.address, 1);

      expect((await registry.getDeviceStatus(device1.address)).status).to.equal(DeviceStatus.Superseded);
      expect((await registry.getDeviceStatus(device2.address)).status).to.equal(DeviceStatus.Live);

      const enrolment = await registry.getEnrolment(NIC_HASH);
      expect(enrolment.device).to.equal(device2.address);
      expect(enrolment.issueCount).to.equal(1);
    });

    it("lets the replacement device register", async function () {
      await registry.connect(gn).reissueDevice(NIC_HASH, votingAddr, device2.address);
      await voting.connect(gn).addVoters([device2.address], [true]);
      await voting.startRegistration(REG_DURATION);

      await expect(voting.connect(device2).register(COMMITMENT_2)).to.emit(voting, "NewLeaf");
    });

    it("kills the superseded device even while it is still allowlisted", async function () {
      // THE test. The GN allowlisted device1 at enrolment and nobody revoked it,
      // which is exactly what happens when a second transaction is forgotten,
      // dropped, or deliberately skipped. Supersession alone has to be enough.
      await registry.connect(gn).reissueDevice(NIC_HASH, votingAddr, device2.address);
      await voting.connect(gn).addVoters([device2.address], [true]);
      await voting.startRegistration(REG_DURATION);

      expect((await voting.getVoterData(device1.address)).voter).to.equal(true);
      await expect(voting.connect(device1).register(COMMITMENT_1))
        .to.be.revertedWithCustomError(registry, "NicRegistry__DeviceSuperseded")
        .withArgs(device1.address, NIC_HASH);
    });

    it("gives the person one leaf, not two, across the re-issue", async function () {
      // The fraud, end to end: enrol, sit on it, claim a loss, register both.
      await registry.connect(gn).reissueDevice(NIC_HASH, votingAddr, device2.address);
      await voting.connect(gn).addVoters([device2.address], [true]);
      await voting.startRegistration(REG_DURATION);

      await voting.connect(device2).register(COMMITMENT_2);
      await expect(voting.connect(device1).register(COMMITMENT_1)).to.be.revertedWithCustomError(
        registry,
        "NicRegistry__DeviceSuperseded",
      );

      expect((await voting.getVotingData()).size).to.equal(1);
    });

    it("refuses to re-issue once the citizen has registered", async function () {
      // The other half of the policy: losing the phone after registering loses
      // the vote. It also closes the race — a voter who sneaks a registration in
      // just before the officer acts cannot then be handed a second device.
      await voting.startRegistration(REG_DURATION);
      await voting.connect(device1).register(COMMITMENT_1);

      await expect(registry.connect(gn).reissueDevice(NIC_HASH, votingAddr, device2.address))
        .to.be.revertedWithCustomError(registry, "NicRegistry__AlreadyRegistered")
        .withArgs(NIC_HASH);
    });

    it("chains: a device re-issued twice leaves both predecessors dead", async function () {
      await registry.connect(gn).reissueDevice(NIC_HASH, votingAddr, device2.address);
      await registry.connect(gn).reissueDevice(NIC_HASH, votingAddr, device3.address);
      await voting.connect(gn).addVoters([device2.address, device3.address], [true, true]);
      await voting.startRegistration(REG_DURATION);

      await expect(voting.connect(device1).register(COMMITMENT_1)).to.be.revertedWithCustomError(
        registry,
        "NicRegistry__DeviceSuperseded",
      );
      await expect(voting.connect(device2).register(COMMITMENT_1)).to.be.revertedWithCustomError(
        registry,
        "NicRegistry__DeviceSuperseded",
      );
      await expect(voting.connect(device3).register(COMMITMENT_1)).to.emit(voting, "NewLeaf");
    });

    it("refuses a NIC that was never enrolled", async function () {
      await expect(registry.connect(gn).reissueDevice(OTHER_NIC_HASH, votingAddr, device2.address))
        .to.be.revertedWithCustomError(registry, "NicRegistry__NotEnrolled")
        .withArgs(OTHER_NIC_HASH);
    });

    it("refuses a re-issue naming the same device again", async function () {
      // Almost always the officer scanning the phone they were replacing. The
      // GN portal treats this as "already done" and moves on to the allowlist.
      await expect(registry.connect(gn).reissueDevice(NIC_HASH, votingAddr, device1.address))
        .to.be.revertedWithCustomError(registry, "NicRegistry__DeviceUnchanged")
        .withArgs(device1.address);
    });

    it("refuses a replacement device already bound to someone else", async function () {
      await registry.connect(gn).reserveNicHash(OTHER_NIC_HASH, votingAddr, device2.address);

      await expect(registry.connect(gn).reissueDevice(NIC_HASH, votingAddr, device2.address))
        .to.be.revertedWithCustomError(registry, "NicRegistry__DeviceInUse")
        .withArgs(device2.address);
    });

    it("refuses a superseded device as a replacement", async function () {
      await registry.connect(gn).reissueDevice(NIC_HASH, votingAddr, device2.address);

      await expect(registry.connect(gn).reissueDevice(NIC_HASH, votingAddr, device1.address))
        .to.be.revertedWithCustomError(registry, "NicRegistry__DeviceInUse")
        .withArgs(device1.address);
    });

    it("refuses a re-issue from a division that did not enrol the NIC", async function () {
      // Otherwise the old device stays live on its own division's allowlist
      // while the new one enrols elsewhere, and neither Voting sees a conflict.
      const other = await deploySecondDivision();
      await expect(registry.connect(owner).reissueDevice(NIC_HASH, other, device2.address))
        .to.be.revertedWithCustomError(registry, "NicRegistry__WrongDivision")
        .withArgs(NIC_HASH, votingAddr, other);
    });

    it("rejects a caller that is neither the owner nor the division's GN", async function () {
      await expect(registry.connect(nonGN).reissueDevice(NIC_HASH, votingAddr, device2.address)).to.be.revertedWith(
        "Not owner or GN",
      );
    });
  });

  describe("re-issue limit", function () {
    beforeEach(async function () {
      await enrol(NIC_HASH, device1);
    });

    it("stops a GN after MAX_REISSUES and lets the owner continue", async function () {
      const limit = Number(await registry.MAX_REISSUES());
      const spare = (await ethers.getSigners()).slice(6);
      expect(spare.length).to.be.greaterThan(limit);

      for (let i = 0; i < limit; i++) {
        await registry.connect(gn).reissueDevice(NIC_HASH, votingAddr, spare[i].address);
      }

      await expect(registry.connect(gn).reissueDevice(NIC_HASH, votingAddr, spare[limit].address))
        .to.be.revertedWithCustomError(registry, "NicRegistry__ReissueLimitReached")
        .withArgs(NIC_HASH, limit);

      // The Election Authority is the escalation path, not a dead end.
      await expect(registry.connect(owner).reissueDevice(NIC_HASH, votingAddr, spare[limit].address)).to.emit(
        registry,
        "DeviceReissued",
      );
    });
  });

  describe("clearing the enrolment epoch", function () {
    it("frees every reserved hash", async function () {
      await registry.connect(gn).reserveNicHash(NIC_HASH, votingAddr, device1.address);
      expect(await registry.isNicHashUsed(NIC_HASH)).to.equal(true);

      await expect(registry.clearNicHashes()).to.emit(registry, "NicHashesCleared").withArgs(1);

      // Without this a new election could not enrol anyone who took part in the
      // previous one — the reservation outlives the divisions themselves.
      expect(await registry.isNicHashUsed(NIC_HASH)).to.equal(false);
      await expect(registry.connect(gn).reserveNicHash(NIC_HASH, votingAddr, device1.address)).to.emit(
        registry,
        "NicHashReserved",
      );
    });

    it("frees superseded devices too, since the phone may resurface", async function () {
      await registry.connect(gn).reserveNicHash(NIC_HASH, votingAddr, device1.address);
      await registry.connect(gn).reissueDevice(NIC_HASH, votingAddr, device2.address);
      await registry.clearNicHashes();

      expect((await registry.getDeviceStatus(device1.address)).status).to.equal(DeviceStatus.Unbound);
      await expect(registry.connect(gn).reserveNicHash(NIC_HASH, votingAddr, device1.address)).to.emit(
        registry,
        "NicHashReserved",
      );
    });

    it("halts an open registration window rather than un-superseding devices", async function () {
      // The one ordering hazard in the design: clearing the epoch under a live
      // election would make every superseded device Unbound again, and an
      // allowlist entry that was never revoked would then be enough to register.
      // Registration fails closed instead, until the admin resets the division.
      await enrol(NIC_HASH, device1);
      await registry.connect(gn).reissueDevice(NIC_HASH, votingAddr, device2.address);
      await voting.startRegistration(REG_DURATION);

      await registry.clearNicHashes();

      await expect(voting.connect(device1).register(COMMITMENT_1))
        .to.be.revertedWithCustomError(registry, "NicRegistry__EpochChanged")
        .withArgs(0, 1);
    });

    it("blocks a re-registration after resetElection alone, and allows it once cleared", async function () {
      // `resetElection` clears the division; it does not clear the registry. A
      // citizen who registered in the previous election is still committed, so
      // the admin panel's reset must do both — and does. Pinned here because
      // getting the order or the pairing wrong now shows up as voters who
      // silently cannot register.
      await enrol(NIC_HASH, device1);
      await voting.startRegistration(REG_DURATION);
      await voting.connect(device1).register(COMMITMENT_1);

      await voting.resetElection();
      await voting.setCandidates(["Yes", "No"]);
      await voting.connect(gn).addVoters([device1.address], [true]);
      await voting.startRegistration(REG_DURATION);

      await expect(voting.connect(device1).register(COMMITMENT_1)).to.be.revertedWithCustomError(
        registry,
        "NicRegistry__AlreadyRegistered",
      );

      // The missing half of the reset.
      await registry.clearNicHashes();
      await voting.resetElection();
      await voting.setCandidates(["Yes", "No"]);
      await enrol(NIC_HASH, device1);
      await voting.startRegistration(REG_DURATION);

      await expect(voting.connect(device1).register(COMMITMENT_1)).to.emit(voting, "NewLeaf");
    });

    it("still rejects a repeat reservation within the new epoch", async function () {
      await registry.connect(gn).reserveNicHash(NIC_HASH, votingAddr, device1.address);
      await registry.clearNicHashes();
      await registry.connect(gn).reserveNicHash(NIC_HASH, votingAddr, device1.address);

      await expect(registry.connect(gn).reserveNicHash(NIC_HASH, votingAddr, device2.address))
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
  });

  describe("enrolment is mandatory", function () {
    /**
     * The rule with no exceptions: a leaf requires a GN officer's enrolment.
     *
     * There is no mode, flag or deployment option that relaxes this. The tests
     * here exist because the previous design *did* have one — permissive by
     * default — and the whole difference between "we prevent double
     * registration" and "we prevent it unless an officer works around us" lives
     * in these few cases.
     */
    it("refuses an allowlisted but unenrolled device", async function () {
      await voting.connect(gn).addVoters([device2.address], [true]);
      await voting.startRegistration(REG_DURATION);

      await expect(voting.connect(device2).register(COMMITMENT_1))
        .to.be.revertedWithCustomError(registry, "NicRegistry__DeviceNotEnrolled")
        .withArgs(device2.address);
    });

    it("closes the bypass a colluding officer would otherwise have", async function () {
      // Enrol the citizen properly, then allowlist a second address for them
      // without telling the registry. Supersession cannot invalidate a binding
      // that was never created, so this is the only route by which one person
      // could ever have obtained two leaves.
      await enrol(NIC_HASH, device1);
      await voting.connect(gn).addVoters([device2.address], [true]);
      await voting.startRegistration(REG_DURATION);

      await expect(voting.connect(device1).register(COMMITMENT_1)).to.emit(voting, "NewLeaf");
      await expect(voting.connect(device2).register(COMMITMENT_2)).to.be.revertedWithCustomError(
        registry,
        "NicRegistry__DeviceNotEnrolled",
      );
      expect((await voting.getVotingData()).size).to.equal(1);
    });

    it("exposes no way to relax the rule", async function () {
      // A toggle that exists can be left in the wrong position on election day.
      // Asserted against the ABI so that reintroducing one fails here first.
      const names = registry.interface.fragments
        .filter(f => f.type === "function")
        .map(f => (f as { name: string }).name);
      expect(names).to.not.include("setStrictEnrolment");
      expect(names).to.not.include("isStrictEnrolment");
      expect(names.some(n => /strict/i.test(n))).to.equal(false);
    });

    it("admits a properly enrolled device", async function () {
      // The other half: mandatory must not mean impossible.
      await enrol(NIC_HASH, device1);
      await voting.startRegistration(REG_DURATION);

      await expect(voting.connect(device1).register(COMMITMENT_1)).to.emit(voting, "NewLeaf");
    });

    it("still requires the allowlist as well as the enrolment", async function () {
      // Two gates, not one. Enrolment alone does not put an address on a
      // division's roll — `reserveNicHash` and `addVoters` are both needed.
      await registry.connect(gn).reserveNicHash(NIC_HASH, votingAddr, device1.address);
      await voting.startRegistration(REG_DURATION);

      await expect(voting.connect(device1).register(COMMITMENT_1)).to.be.revertedWithCustomError(
        voting,
        "Voting__NotAllowedToVote",
      );
    });
  });

  describe("commitDevice access control", function () {
    it("refuses a bound device presented by an unauthorised contract", async function () {
      // A division that was never passed to setVotingContract cannot spend a
      // citizen's one registration, so a rogue contract cannot grief an enrolled
      // voter by committing their NIC out from under them.
      await enrol(NIC_HASH, device1);
      await registry.setVotingContract(votingAddr, false);
      await voting.startRegistration(REG_DURATION);

      await expect(voting.connect(device1).register(COMMITMENT_1)).to.be.revertedWith("Unregistered division");
      expect((await registry.getEnrolment(NIC_HASH)).committed).to.equal(false);
    });
  });

  /** Deploy a second division through a real ElectionRegistry, linked correctly. */
  async function deploySecondDivision(): Promise<string> {
    const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
    const poseidon = await PoseidonT3.deploy();
    const LeanIMT = await ethers.getContractFactory("LeanIMT", {
      libraries: { PoseidonT3: await poseidon.getAddress() },
    });
    const leanIMT = await LeanIMT.deploy();
    const Verifier = await ethers.getContractFactory("HonkVerifier");
    const verifier = await Verifier.deploy();

    const RegistryFactory = await ethers.getContractFactory("ElectionRegistry", {
      libraries: { LeanIMT: await leanIMT.getAddress() },
    });
    const electionRegistry = await RegistryFactory.deploy(
      owner.address,
      await verifier.getAddress(),
      await registry.getAddress(),
    );
    await electionRegistry.createDivision("Elsewhere");
    const divisions = await electionRegistry.getAllDivisions();
    const address = divisions[0].votingContract;
    await registry.setVotingContract(address, true);
    return address;
  }
});
