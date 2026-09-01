// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

import {LeanIMT, LeanIMTData} from "@zk-kit/lean-imt.sol/LeanIMT.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IVerifier} from "./Verifier.sol";

interface INicRegistry {
    function commitDevice(address device, uint256 expectedEpoch) external returns (bytes32 nicHash);
    function getCurrentEpoch() external view returns (uint256);
}

/**
 * @title Voting
 * @notice Phased ZK voting contract supporting up to MAX_CANDIDATES candidates.
 *
 * Phases:
 *   Setup        - admin configures question, candidates, and allowlist.
 *   Registration - allowlisted voters submit commitment leaves. Config locked.
 *   Voting       - registered voters submit ZK proofs to cast a vote.
 *   Ended        - results frozen.
 *
 * Phase transitions are admin-driven (startRegistration / startVoting /
 * endElection) with deadline-based auto-advancement enforced on every
 * state-changing call and reflected by the `currentPhase()` view.
 */
contract Voting is Ownable {
    using LeanIMT for LeanIMTData;

    //////////////////
    /// Errors ///////
    //////////////////

    error Voting__CommitmentAlreadyAdded(uint256 commitment);
    error Voting__NullifierHashAlreadyUsed(bytes32 nullifierHash);
    error Voting__InvalidProof();
    error Voting__NotAllowedToVote();
    error Voting__EmptyTree();
    error Voting__InvalidRoot();
    error Voting__WrongPhase(Phase expected, Phase actual);
    error Voting__InvalidCandidate(uint256 candidateIndex);
    error Voting__InvalidDuration();
    error Voting__TooManyCandidates(uint256 provided, uint256 max);
    error Voting__NoCandidates();
    error Voting__SetupOrRegistrationRequired(Phase actual);
    error Voting__NoNicRegistry();

    //////////////////
    /// Types ////////
    //////////////////

    enum Phase {
        Setup,
        Registration,
        Voting,
        Ended
    }

    //////////////////////////
    /// State Variables //////
    //////////////////////////

    uint256 public constant MAX_CANDIDATES = 100;

    IVerifier public immutable i_verifier;

    /// @notice The shared identity ledger. `register()` cannot be reached without
    ///         its consent, which is what makes "one citizen, one leaf" a
    ///         property of the contracts rather than of the GN's diligence.
    INicRegistry public immutable i_nicRegistry;

    // GN officers for this division — can call addVoters(). A division may
    // have more than one (shift coverage, backup officers), so membership is
    // tracked by mapping rather than a single slot; s_gnOfficerList exists
    // only because a mapping cannot be enumerated for the admin UI.
    mapping(address => bool) public s_isGnOfficer;
    address[] private s_gnOfficerList;

    // Monotonic election counter. All per-election state is keyed by this id so
    // that resetElection() can start a brand-new election by simply bumping it,
    // which cheaply "clears" every mapping below without costly iteration.
    uint256 private s_electionId;

    string private s_question;
    string[] private s_candidates;
    // electionId => candidateIndex => count
    mapping(uint256 => mapping(uint256 => uint256)) private s_voteCounts;

    Phase private s_phase;
    uint256 private s_registrationEndTime;
    uint256 private s_votingEndTime;

    // The NicRegistry epoch this election's registration window opened under.
    // Pinned so that a clearNicHashes() landing mid-registration halts this
    // division instead of silently un-superseding every replaced device.
    uint256 private s_nicEpoch;

    // electionId => voter => allowlisted / hasRegistered
    mapping(uint256 => mapping(address => bool)) private s_voters;
    mapping(uint256 => mapping(address => bool)) private s_hasRegistered;
    // electionId => commitment => used
    mapping(uint256 => mapping(uint256 => bool)) private s_commitments;
    // electionId => nullifierHash => used
    mapping(uint256 => mapping(bytes32 => bool)) private s_nullifierHashes;

    // electionId => Merkle tree
    mapping(uint256 => LeanIMTData) private s_trees;

    //////////////
    /// Events ///
    //////////////

    event VoterAdded(address indexed voter);
    event GNOfficerUpdated(address indexed gnOfficer, bool isOfficer);
    event NewLeaf(uint256 index, uint256 value);
    event QuestionUpdated(string question);
    event CandidatesUpdated(string[] candidates);
    event PhaseChanged(Phase indexed phase, uint256 deadline);
    event ElectionReset(uint256 indexed electionId);
    event VoteCast(
        bytes32 indexed nullifierHash,
        address indexed voter,
        uint256 indexed candidate,
        uint256 timestamp,
        uint256 newCount
    );

    //////////////////
    /// Modifiers ////
    //////////////////

    /// @dev Auto-advances phase from Registration→Voting and Voting→Ended when
    ///      their respective deadlines have passed, then requires `expected`.
    modifier inPhase(Phase expected) {
        _maybeAdvancePhase();
        if (s_phase != expected) {
            revert Voting__WrongPhase(expected, s_phase);
        }
        _;
    }

    /// @dev Allows both owner and any assigned GN officer.
    modifier onlyOwnerOrGN() {
        require(msg.sender == owner() || s_isGnOfficer[msg.sender], "Not owner or GN");
        _;
    }

    //////////////////
    /// Constructor //
    //////////////////

    constructor(
        address _owner,
        address _verifier,
        address _nicRegistry,
        string memory _question,
        string[] memory _initialCandidates
    ) Ownable(_owner) {
        // Required, not optional. A zero address here would silently downgrade
        // every division to address-level enrolment, which is exactly the state
        // this contract stopped relying on.
        if (_nicRegistry == address(0)) revert Voting__NoNicRegistry();
        i_verifier = IVerifier(_verifier);
        i_nicRegistry = INicRegistry(_nicRegistry);
        s_question = _question;
        s_phase = Phase.Setup;
        if (_initialCandidates.length > 0) {
            _setCandidates(_initialCandidates);
        }
    }

    //////////////////////////
    /// Admin: Setup phase ///
    //////////////////////////

    /// @notice Sets the ballot question. Allowed only during Setup.
    function setQuestion(string calldata _question) external onlyOwner inPhase(Phase.Setup) {
        s_question = _question;
        emit QuestionUpdated(_question);
    }

    /// @notice Sets the candidate list. Allowed only during Setup.
    function setCandidates(string[] calldata _candidates) external onlyOwner inPhase(Phase.Setup) {
        _setCandidates(_candidates);
    }

    function _setCandidates(string[] memory _candidates) internal {
        if (_candidates.length == 0) {
            revert Voting__NoCandidates();
        }
        if (_candidates.length > MAX_CANDIDATES) {
            revert Voting__TooManyCandidates(_candidates.length, MAX_CANDIDATES);
        }
        delete s_candidates;
        for (uint256 i = 0; i < _candidates.length; i++) {
            s_candidates.push(_candidates[i]);
        }
        emit CandidatesUpdated(_candidates);
    }

    /// @notice Adds or removes a GN officer who can add voters. Only owner.
    ///         A division may have more than one officer at once; this does
    ///         not replace whoever is already assigned.
    function setGNOfficer(address _gnOfficer, bool _isOfficer) external onlyOwner {
        if (s_isGnOfficer[_gnOfficer] == _isOfficer) return;
        s_isGnOfficer[_gnOfficer] = _isOfficer;
        if (_isOfficer) {
            s_gnOfficerList.push(_gnOfficer);
        } else {
            uint256 len = s_gnOfficerList.length;
            for (uint256 i = 0; i < len; i++) {
                if (s_gnOfficerList[i] == _gnOfficer) {
                    s_gnOfficerList[i] = s_gnOfficerList[len - 1];
                    s_gnOfficerList.pop();
                    break;
                }
            }
        }
        emit GNOfficerUpdated(_gnOfficer, _isOfficer);
    }

    /// @notice All addresses currently authorised as GN officers for this division.
    function getGNOfficers() external view returns (address[] memory) {
        return s_gnOfficerList;
    }

    /// @notice Batch updates the allowlist of voter EOAs. Allowed during Setup and Registration.
    function addVoters(address[] calldata voters, bool[] calldata statuses)
        external
        onlyOwnerOrGN
    {
        _maybeAdvancePhase();
        if (s_phase != Phase.Setup && s_phase != Phase.Registration) {
            revert Voting__SetupOrRegistrationRequired(s_phase);
        }
        require(voters.length == statuses.length, "Voters and statuses length mismatch");
        for (uint256 i = 0; i < voters.length; i++) {
            s_voters[s_electionId][voters[i]] = statuses[i];
            emit VoterAdded(voters[i]);
        }
    }

    /////////////////////////////////
    /// Admin: Phase transitions ////
    /////////////////////////////////

    /// @notice Move Setup → Registration. `_durationSec` is the registration
    ///         window length (seconds). Must be > 0. Candidates must be set.
    function startRegistration(uint256 _durationSec) external onlyOwner inPhase(Phase.Setup) {
        if (_durationSec == 0) revert Voting__InvalidDuration();
        if (s_candidates.length == 0) revert Voting__NoCandidates();
        s_phase = Phase.Registration;
        s_registrationEndTime = block.timestamp + _durationSec;
        // Pin the enrolment epoch the window opens under — see s_nicEpoch.
        s_nicEpoch = i_nicRegistry.getCurrentEpoch();
        emit PhaseChanged(Phase.Registration, s_registrationEndTime);
    }

    /// @notice Move Registration → Voting early (or right at the deadline).
    ///         `_durationSec` is the voting window length (seconds), > 0.
    function startVoting(uint256 _durationSec) external onlyOwner {
        _maybeAdvancePhase();
        if (s_phase != Phase.Registration) {
            revert Voting__WrongPhase(Phase.Registration, s_phase);
        }
        if (_durationSec == 0) revert Voting__InvalidDuration();
        s_phase = Phase.Voting;
        s_votingEndTime = block.timestamp + _durationSec;
        emit PhaseChanged(Phase.Voting, s_votingEndTime);
    }

    /// @notice End the election early. Allowed from Registration or Voting.
    function endElection() external onlyOwner {
        _maybeAdvancePhase();
        if (s_phase == Phase.Setup || s_phase == Phase.Ended) {
            revert Voting__WrongPhase(Phase.Voting, s_phase);
        }
        s_phase = Phase.Ended;
        emit PhaseChanged(Phase.Ended, block.timestamp);
    }

    /// @notice Stop the current election and start a brand-new one from scratch.
    ///         Callable by the owner from ANY phase (recovery + restart button).
    ///         Bumps the electionId, which cheaply clears all per-election state
    ///         (voters, registrations, commitments, nullifiers, votes, tree),
    ///         clears the question/candidates, and returns to Setup.
    function resetElection() external onlyOwner {
        s_electionId++;
        delete s_candidates;
        s_question = "";
        s_registrationEndTime = 0;
        s_votingEndTime = 0;
        s_nicEpoch = 0;
        s_phase = Phase.Setup;
        emit ElectionReset(s_electionId);
        emit PhaseChanged(Phase.Setup, 0);
    }

    //////////////////
    /// Voter API ////
    //////////////////

    /// @notice Registers a commitment leaf for an enrolled, allowlisted address.
    ///
    ///         Two gates, and both are load-bearing. The allowlist below answers
    ///         "may this *address* insert a leaf". `commitDevice` answers "may
    ///         this *citizen*" — it refuses a device no GN officer ever enrolled,
    ///         refuses one that a later re-issue superseded, and refuses a NIC
    ///         that already has a leaf, in this or any other division. The
    ///         allowlist cannot express any of those, because it is keyed by
    ///         address and a person is not an address.
    ///
    ///         So `addVoters` alone is not enough to make an address able to
    ///         register: enrolment through a GN officer is mandatory.
    function register(uint256 _commitment) external inPhase(Phase.Registration) {
        uint256 electionId = s_electionId;
        if (!s_voters[electionId][msg.sender] || s_hasRegistered[electionId][msg.sender]) {
            revert Voting__NotAllowedToVote();
        }
        if (s_commitments[electionId][_commitment]) {
            revert Voting__CommitmentAlreadyAdded(_commitment);
        }

        s_commitments[electionId][_commitment] = true;
        s_hasRegistered[electionId][msg.sender] = true;
        s_trees[electionId].insert(_commitment);

        // Last, after every local effect: checks-effects-interactions. The
        // registry is immutable and admin-deployed rather than attacker-supplied,
        // and a reentrant call would arrive with the registry as `msg.sender` and
        // fail the allowlist anyway — but ordering it this way costs nothing and
        // removes the question. A revert here (superseded device, NIC already
        // registered, epoch cleared mid-window) unwinds the writes above with it,
        // and carries the reason the voter needs to be told.
        i_nicRegistry.commitDevice(msg.sender, s_nicEpoch);

        emit NewLeaf(s_trees[electionId].size - 1, _commitment);
    }

    /// @notice Casts a vote using a ZK proof. `_vote` is the candidate index
    ///         (as bytes32 to match circuit public-input encoding).
    function vote(
        bytes memory _proof,
        bytes32 _nullifierHash,
        bytes32 _root,
        bytes32 _vote,
        bytes32 _depth
    ) external inPhase(Phase.Voting) {
        uint256 electionId = s_electionId;
        if (_root == bytes32(0)) {
            revert Voting__EmptyTree();
        }
        if (_root != bytes32(s_trees[electionId].root())) {
            revert Voting__InvalidRoot();
        }

        uint256 candidateIdx = uint256(_vote);
        if (candidateIdx >= s_candidates.length) {
            revert Voting__InvalidCandidate(candidateIdx);
        }

        bytes32[] memory publicInputs = new bytes32[](4);
        publicInputs[0] = _nullifierHash;
        publicInputs[1] = _root;
        publicInputs[2] = _vote;
        publicInputs[3] = _depth;

        if (!i_verifier.verify(_proof, publicInputs)) {
            revert Voting__InvalidProof();
        }

        if (s_nullifierHashes[electionId][_nullifierHash]) {
            revert Voting__NullifierHashAlreadyUsed(_nullifierHash);
        }
        s_nullifierHashes[electionId][_nullifierHash] = true;

        uint256 newCount = ++s_voteCounts[electionId][candidateIdx];
        emit VoteCast(_nullifierHash, msg.sender, candidateIdx, block.timestamp, newCount);
    }

    //////////////////
    /// Internals ////
    //////////////////

    /// @dev Apply automatic time-based phase advancement.
    function _maybeAdvancePhase() internal {
        if (s_phase == Phase.Registration && block.timestamp >= s_registrationEndTime) {
            // Registration window expired without admin calling startVoting:
            // the election is considered closed (no voting window opened).
            s_phase = Phase.Ended;
            emit PhaseChanged(Phase.Ended, block.timestamp);
        } else if (s_phase == Phase.Voting && block.timestamp >= s_votingEndTime) {
            s_phase = Phase.Ended;
            emit PhaseChanged(Phase.Ended, block.timestamp);
        }
    }

    /////////////////////////
    /// View Functions //////
    /////////////////////////

    /// @notice Returns the effective phase (accounting for elapsed deadlines)
    ///         without writing to storage.
    function currentPhase() public view returns (Phase) {
        if (s_phase == Phase.Registration && block.timestamp >= s_registrationEndTime) {
            return Phase.Ended;
        }
        if (s_phase == Phase.Voting && block.timestamp >= s_votingEndTime) {
            return Phase.Ended;
        }
        return s_phase;
    }

    function getCandidates() external view returns (string[] memory) {
        return s_candidates;
    }

    function getCandidate(uint256 index) external view returns (string memory) {
        if (index >= s_candidates.length) revert Voting__InvalidCandidate(index);
        return s_candidates[index];
    }

    function getVoteCounts() external view returns (uint256[] memory counts) {
        counts = new uint256[](s_candidates.length);
        for (uint256 i = 0; i < s_candidates.length; i++) {
            counts[i] = s_voteCounts[s_electionId][i];
        }
    }

    function getVoteCount(uint256 index) external view returns (uint256) {
        if (index >= s_candidates.length) revert Voting__InvalidCandidate(index);
        return s_voteCounts[s_electionId][index];
    }

    function getVotingData()
        external
        view
        returns (
            string memory question,
            address contractOwner,
            Phase phase,
            uint256 registrationEndTime,
            uint256 votingEndTime,
            uint256 size,
            uint256 depth,
            uint256 root,
            uint256 candidateCount
        )
    {
        question = s_question;
        contractOwner = owner();
        phase = currentPhase();
        registrationEndTime = s_registrationEndTime;
        votingEndTime = s_votingEndTime;
        size = s_trees[s_electionId].size;
        depth = s_trees[s_electionId].depth;
        root = s_trees[s_electionId].root();
        candidateCount = s_candidates.length;
    }

    /// @notice The NicRegistry epoch this registration window was opened under.
    ///         Registration halts if the registry moves past it; a client seeing
    ///         Voting__* / NicRegistry__EpochChanged can compare the two to say
    ///         so plainly.
    function getNicEpoch() external view returns (uint256) {
        return s_nicEpoch;
    }

    /// @notice Returns the current election id. Bumped on every resetElection().
    function getCurrentElectionId() external view returns (uint256) {
        return s_electionId;
    }

    function getVoterData(address _voter) external view returns (bool voter, bool registered) {
        voter = s_voters[s_electionId][_voter];
        registered = s_hasRegistered[s_electionId][_voter];
    }

    /// @notice Returns true if the given nullifier hash was used in the current election.
    ///         Voters can use this to verify their vote was counted without revealing their identity.
    function isNullifierUsed(bytes32 _nullifierHash) external view returns (bool) {
        return s_nullifierHashes[s_electionId][_nullifierHash];
    }
}
