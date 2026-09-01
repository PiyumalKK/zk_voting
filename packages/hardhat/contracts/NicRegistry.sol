// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IVotingGN {
    function s_isGnOfficer(address account) external view returns (bool);
}

/**
 * @title NicRegistry
 * @notice The identity ledger for enrolment: one NIC, one division, one live
 *         device, at most one Merkle-tree registration.
 *
 * The registry answers three questions the Voting contracts cannot answer for
 * themselves, because a `Voting` allowlist is keyed by *address* and a person is
 * not an address:
 *
 *   1. Has this citizen already been enrolled anywhere? (cross-division
 *      duplicate enrolment — the original purpose of this contract)
 *   2. Is the device asking to insert a leaf still the device this citizen was
 *      issued, and has this citizen already inserted one? (device re-issue)
 *   3. Did a GN officer enrol this device at all?
 *
 * ## Enrolment has exactly one route
 *
 * Every device that registers must have been bound to a NIC here by a GN
 * officer who checked a physical identity document. `commitDevice` refuses an
 * `Unbound` device outright, so `Voting.addVoters` on its own — the bulk
 * allowlist — puts an address on a roll but does not make it able to register.
 *
 * That is deliberate and not merely defensive. Without it, a *colluding*
 * officer could enrol a citizen properly once and then allowlist a second
 * address the registry was never told about: supersession cannot invalidate a
 * binding that does not exist, so that citizen would get two leaves. Refusing
 * unbound devices is what makes "one citizen, one leaf" hold against the
 * officers themselves, not just against the voters.
 *
 * ## Why re-issue lives here and not in the GN's workflow
 *
 * A voter who breaks their phone *before* registering has lost nothing
 * recoverable — the keystore key is gone, so the allowlisted address is dead —
 * and must be issued a new one. A voter who breaks it *after* registering has
 * lost their vote, permanently and by design: their commitment is already an
 * anonymous leaf in the tree, and nothing on chain can identify it to replace
 * it.
 *
 * The attack that separates those two cases is a voter who enrols, does *not*
 * register, falsely claims loss, gets a second device, and then registers both.
 * Two leaves, two nullifiers, two votes — and the ZK layer cannot catch it,
 * because leaves are unlinkable by design and `vote()` only checks that a
 * nullifier is fresh. Enforcement has to happen at enrolment or nowhere.
 *
 * So re-issue is a single state change *here* rather than a procedure the GN
 * carries out with two transactions: `reissueDevice` marks the old device
 * `Superseded` in the same write that binds the new one. `commitDevice`, which
 * every `register()` must pass through, then refuses the old device outright.
 * Nothing outside this contract has to remember to revoke anything, and a GN
 * who skips a step cannot leave two live devices behind.
 *
 * ## Privacy note
 *
 * `nicHash` is an HMAC under a server-held pepper (`services/nic/nicHash.ts`),
 * so it is not computable from a NIC by anyone reading the chain. Storage does
 * link a nicHash to its device address, which is what makes re-issue possible at
 * all — the officer has no other way to learn the address of a phone the voter
 * no longer has. The routine events are kept address-free (`NicHashReserved`,
 * `NicHashCommitted`) so that ordinary enrolment adds no public link beyond that
 * storage; `DeviceReissued` deliberately does carry both addresses, because a
 * re-issue is the exceptional event an auditor needs to see.
 */
contract NicRegistry is Ownable {
    //////////////////
    /// Errors ///////
    //////////////////

    error NicRegistry__AlreadyUsed(bytes32 nicHash);
    error NicRegistry__NotEnrolled(bytes32 nicHash);
    /// @dev The NIC already has a leaf in the tree — no re-issue, no second registration.
    error NicRegistry__AlreadyRegistered(bytes32 nicHash);
    /// @dev This device was replaced by a later re-issue and is permanently dead.
    error NicRegistry__DeviceSuperseded(address device, bytes32 nicHash);
    error NicRegistry__DeviceInUse(address device);
    error NicRegistry__DeviceUnchanged(address device);
    error NicRegistry__WrongDivision(bytes32 nicHash, address expected, address actual);
    error NicRegistry__ReissueLimitReached(bytes32 nicHash, uint32 limit);
    error NicRegistry__ZeroDevice();
    error NicRegistry__EpochChanged(uint256 expected, uint256 actual);
    /// @dev Allowlisted, but never enrolled against a NIC by a GN officer.
    ///      `Voting.addVoters` alone does not make a device able to register.
    error NicRegistry__DeviceNotEnrolled(address device);

    //////////////////
    /// Types ////////
    //////////////////

    enum DeviceStatus {
        /// Never bound to a NIC in this epoch. May not register: being on a
        /// division's allowlist is necessary but not sufficient.
        Unbound,
        /// The device currently issued to a citizen. May register once.
        Live,
        /// Replaced by a re-issue. May never register, in this epoch, ever.
        Superseded
    }

    struct Enrolment {
        /// The division the NIC was enrolled in. Non-zero means "enrolled".
        address votingContract;
        /// The device currently issued for this NIC.
        address device;
        /// True once a leaf for this NIC exists in that division's tree.
        bool committed;
        /// Number of re-issues so far. 0 = still on the originally issued device.
        uint32 issueCount;
    }

    struct DeviceBinding {
        bytes32 nicHash;
        DeviceStatus status;
    }

    //////////////////////////
    /// State Variables //////
    //////////////////////////

    /// @notice How many times a GN may re-issue one NIC before an admin must step in.
    ///         A re-issue is harmless (the previous device dies with it), but a
    ///         voter who keeps "losing" phones is worth a second pair of eyes.
    uint32 public constant MAX_REISSUES = 3;

    // Monotonic enrolment epoch. Every mapping below is keyed by it so that
    // clearNicHashes() can wipe the whole ledger by bumping the counter, the
    // same trick Voting.sol uses for its per-election state — a mapping cannot
    // be iterated, so this is the only way to clear one at bounded cost.
    uint256 private s_epoch;

    // epoch => nicHash => enrolment
    mapping(uint256 => mapping(bytes32 => Enrolment)) private s_enrolments;
    // epoch => device address => binding
    mapping(uint256 => mapping(address => DeviceBinding)) private s_devices;
    mapping(address => bool) private s_votingContracts;

    //////////////
    /// Events ///
    //////////////

    event VotingContractUpdated(address indexed votingContract, bool authorized);
    /// @dev Deliberately carries no address — see the privacy note above.
    event NicHashReserved(bytes32 indexed nicHash);
    /// @dev Also address-free: which device registered is exactly what the ZK
    ///      layer exists to keep unlinkable.
    event NicHashCommitted(bytes32 indexed nicHash, address indexed votingContract);
    event DeviceReissued(
        bytes32 indexed nicHash,
        address indexed previousDevice,
        address indexed newDevice,
        uint32 issueCount
    );
    event NicHashesCleared(uint256 epoch);

    //////////////////
    /// Modifiers ////
    //////////////////

    modifier onlyOwnerOrGN(address votingContract) {
        require(s_votingContracts[votingContract], "Unregistered division");
        require(
            msg.sender == owner() || IVotingGN(votingContract).s_isGnOfficer(msg.sender),
            "Not owner or GN"
        );
        _;
    }

    constructor(address _owner) Ownable(_owner) {}

    //////////////////
    /// Admin ////////
    //////////////////

    function setVotingContract(address _votingContract, bool _authorized) external onlyOwner {
        s_votingContracts[_votingContract] = _authorized;
        emit VotingContractUpdated(_votingContract, _authorized);
    }

    /// @notice Release every reservation, binding and registration, so the same
    ///         citizens can be enrolled again in a new election. Without this a
    ///         fresh election would reject every voter who took part in the
    ///         previous one.
    ///
    /// @dev MUST be paired with `Voting.resetElection()` on every division, and
    ///      the divisions must be reset *first*. Bumping the epoch here makes
    ///      every device Unbound again, so a division still holding a live
    ///      allowlist from the previous election would let a superseded phone
    ///      register after all. `Voting.register()` refuses to run when the
    ///      epoch has moved underneath an open registration window, which turns
    ///      that mistake into a halt rather than a double registration — but the
    ///      correct order is still reset-then-clear.
    function clearNicHashes() external onlyOwner {
        s_epoch++;
        emit NicHashesCleared(s_epoch);
    }

    //////////////////
    /// Enrolment ////
    //////////////////

    /// @notice First enrolment for a citizen: reserve their NIC and bind the
    ///         device the GN just scanned. Reverts if the NIC was already
    ///         enrolled anywhere — replacing a device is `reissueDevice`, which
    ///         is deliberately a separate call so the officer's intent is
    ///         explicit and separately auditable.
    function reserveNicHash(
        bytes32 nicHash,
        address votingContract,
        address device
    ) external onlyOwnerOrGN(votingContract) returns (bool) {
        if (device == address(0)) revert NicRegistry__ZeroDevice();

        uint256 epoch = s_epoch;
        if (s_enrolments[epoch][nicHash].votingContract != address(0)) {
            revert NicRegistry__AlreadyUsed(nicHash);
        }
        // A Superseded device is refused here too: an address is derived from a
        // keystore key that never leaves its phone, so a second citizen can
        // never legitimately present one that is already bound.
        if (s_devices[epoch][device].status != DeviceStatus.Unbound) {
            revert NicRegistry__DeviceInUse(device);
        }

        s_enrolments[epoch][nicHash] = Enrolment({
            votingContract: votingContract,
            device: device,
            committed: false,
            issueCount: 0
        });
        s_devices[epoch][device] = DeviceBinding({nicHash: nicHash, status: DeviceStatus.Live});

        emit NicHashReserved(nicHash);
        return true;
    }

    /// @notice Replace the device issued for an already-enrolled NIC — the
    ///         lost-or-broken-phone path.
    ///
    ///         Refused once the citizen has registered in the Merkle tree: at
    ///         that point their leaf is anonymous and irreplaceable, so losing
    ///         the phone means losing the vote. That single check is what stops
    ///         a voter enrolling, sitting on it, claiming a false loss and then
    ///         registering both devices.
    ///
    /// @return previousDevice The address this call just killed. The caller
    ///         should still drop it from the division allowlist for hygiene, but
    ///         nothing depends on that happening: `commitDevice` refuses it.
    function reissueDevice(
        bytes32 nicHash,
        address votingContract,
        address newDevice
    ) external onlyOwnerOrGN(votingContract) returns (address previousDevice) {
        if (newDevice == address(0)) revert NicRegistry__ZeroDevice();

        uint256 epoch = s_epoch;
        Enrolment storage enrolment = s_enrolments[epoch][nicHash];

        if (enrolment.votingContract == address(0)) revert NicRegistry__NotEnrolled(nicHash);
        // A NIC belongs to the division that enrolled it. Allowing a re-issue
        // from elsewhere would leave the old device live on the old division's
        // allowlist while the new one enrolled on another, and neither Voting
        // contract would see a conflict.
        if (enrolment.votingContract != votingContract) {
            revert NicRegistry__WrongDivision(nicHash, enrolment.votingContract, votingContract);
        }
        if (enrolment.committed) revert NicRegistry__AlreadyRegistered(nicHash);

        previousDevice = enrolment.device;
        if (newDevice == previousDevice) revert NicRegistry__DeviceUnchanged(newDevice);
        if (s_devices[epoch][newDevice].status != DeviceStatus.Unbound) {
            revert NicRegistry__DeviceInUse(newDevice);
        }
        // The owner is the Election Authority and is trusted to override; a GN
        // is not, so repeated "losses" from one division eventually need escalation.
        if (msg.sender != owner() && enrolment.issueCount >= MAX_REISSUES) {
            revert NicRegistry__ReissueLimitReached(nicHash, MAX_REISSUES);
        }

        // The invalidation and the replacement are the same state change. This
        // is the whole point of putting re-issue in the registry.
        s_devices[epoch][previousDevice].status = DeviceStatus.Superseded;
        s_devices[epoch][newDevice] = DeviceBinding({nicHash: nicHash, status: DeviceStatus.Live});

        enrolment.device = newDevice;
        enrolment.issueCount += 1;

        emit DeviceReissued(nicHash, previousDevice, newDevice, enrolment.issueCount);
    }

    //////////////////////////
    /// Voting contract API //
    //////////////////////////

    /// @notice Claim this citizen's one and only Merkle-tree registration.
    ///         Called by `Voting.register()`; reverts rather than returning
    ///         false, so a division cannot proceed past a refusal by ignoring a
    ///         return value.
    ///
    /// @param device        The address calling `register()`.
    /// @param expectedEpoch The enrolment epoch the division's registration
    ///                      window opened under. Mismatch means `clearNicHashes`
    ///                      ran mid-election; see the note on that function.
    /// @return nicHash      The NIC now committed, or zero for an unbound device.
    function commitDevice(address device, uint256 expectedEpoch) external returns (bytes32 nicHash) {
        uint256 epoch = s_epoch;
        if (epoch != expectedEpoch) revert NicRegistry__EpochChanged(expectedEpoch, epoch);

        DeviceBinding memory binding = s_devices[epoch][device];

        // No NIC was ever bound to this device, so no GN officer ever checked a
        // physical identity document against it. Refused: enrolment has exactly
        // one route, and an address that arrived by `Voting.addVoters` alone did
        // not take it.
        //
        // This is what closes the last way one citizen could obtain two
        // registrations — enrol properly once, then have a second address
        // allowlisted that the registry was never told about, which device
        // supersession therefore cannot see. Not reachable by a re-issued
        // device: supersession sets a status, it does not clear the binding.
        if (binding.status == DeviceStatus.Unbound) revert NicRegistry__DeviceNotEnrolled(device);

        require(s_votingContracts[msg.sender], "Unregistered division");

        if (binding.status == DeviceStatus.Superseded) {
            revert NicRegistry__DeviceSuperseded(device, binding.nicHash);
        }

        nicHash = binding.nicHash;
        Enrolment storage enrolment = s_enrolments[epoch][nicHash];
        if (enrolment.votingContract != msg.sender) {
            revert NicRegistry__WrongDivision(nicHash, enrolment.votingContract, msg.sender);
        }
        if (enrolment.committed) revert NicRegistry__AlreadyRegistered(nicHash);

        enrolment.committed = true;
        emit NicHashCommitted(nicHash, msg.sender);
    }

    /////////////////////////
    /// View Functions //////
    /////////////////////////

    /// @notice The current enrolment epoch. Bumped by every clearNicHashes().
    function getCurrentEpoch() external view returns (uint256) {
        return s_epoch;
    }

    /// @notice Whether `nicHash` is already enrolled in the current epoch.
    function isNicHashUsed(bytes32 nicHash) external view returns (bool) {
        return s_enrolments[s_epoch][nicHash].votingContract != address(0);
    }

    /// @notice Full enrolment record for a NIC. `votingContract == address(0)`
    ///         means it is not enrolled. This is how the GN portal decides
    ///         whether to offer "replace device" and whether that would be
    ///         refused for having already registered.
    function getEnrolment(
        bytes32 nicHash
    ) external view returns (address votingContract, address device, bool committed, uint32 issueCount) {
        Enrolment memory enrolment = s_enrolments[s_epoch][nicHash];
        return (enrolment.votingContract, enrolment.device, enrolment.committed, enrolment.issueCount);
    }

    /// @notice A device's binding. Lets the voter app tell "you were never
    ///         enrolled" apart from "your phone was replaced", which are very
    ///         different things to tell a voter.
    function getDeviceStatus(address device) external view returns (DeviceStatus status, bytes32 nicHash) {
        DeviceBinding memory binding = s_devices[s_epoch][device];
        return (binding.status, binding.nicHash);
    }

    /// @notice Whether `votingContract` may call `commitDevice`. `s_votingContracts`
    ///         is private and previously readable only by replaying
    ///         `VotingContractUpdated`; the admin panel's authorisation
    ///         indicator can use this instead.
    function isVotingContractAuthorized(address votingContract) external view returns (bool) {
        return s_votingContracts[votingContract];
    }
}
