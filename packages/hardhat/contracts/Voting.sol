// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@zk-kit/lean-imt.sol/LeanIMT.sol";

/// @notice Interface for the ZK proof verifier contract
interface IVerifier {
    function verify(
        bytes calldata _proof,
        bytes32[] calldata _publicInputs
    ) external view returns (bool);
}

/// @title Voting - A ZK-powered anonymous voting contract
/// @notice Allows registered voters to cast votes anonymously using zero-knowledge proofs
contract Voting is Ownable {
    using LeanIMT for LeanIMTData;

    /////////////////
    /// Errors    ///
    /////////////////

    error Voting__NotAllowedToVote();
    error Voting__CommitmentAlreadyAdded(uint256 commitment);
    error Voting__EmptyTree();
    error Voting__InvalidRoot();
    error Voting__InvalidProof();
    error Voting__NullifierHashAlreadyUsed(bytes32 nullifierHash);

    /////////////////
    /// Events    ///
    /////////////////

    event VoterAdded(address indexed voter);
    event NewLeaf(uint256 indexed index, uint256 value);
    event VoteCast(
        bytes32 indexed nullifierHash,
        address voter,
        bool voteChoice,
        uint256 timestamp,
        uint256 totalYes,
        uint256 totalNo
    );

    ///////////////////////
    /// State Variables ///
    ///////////////////////

    /// @notice The voting question
    string public s_question;

    /// @notice Vote tallies
    uint256 public s_yesVotes;
    uint256 public s_noVotes;

    /// @notice Allowlist of addresses permitted to register
    mapping(address => bool) public s_voters;

    /// Registration state (activate when implementing register) ///
    // mapping(address => bool) private s_hasRegistered;
    // mapping(uint256 => bool) private s_commitments;
    // LeanIMTData private s_tree;

    /// Voting/Verifier state (activate when implementing vote) ///
    // IVerifier public immutable i_verifier;
    // mapping(bytes32 => bool) private s_nullifierHashes;

    //////////////////
    /// Constructor //
    //////////////////

    constructor(
        address _owner,
        string memory _question
    ) Ownable(_owner) {
        s_question = _question;
        /// TODO: initialize i_verifier here when verifier is ready
    }

    //////////////////
    /// Functions  ///
    //////////////////

    /// @notice Owner adds addresses to the voter allowlist
    /// @param _voters Array of addresses to allow
    function addVoters(address[] calldata _voters) external onlyOwner {
        for (uint256 i = 0; i < _voters.length; i++) {
            s_voters[_voters[i]] = true;
            emit VoterAdded(_voters[i]);
        }
    }

    /// @notice Register a commitment to the Merkle tree
    /// @param _commitment The voter's hashed commitment (nullifier + secret)
    function register(uint256 _commitment) public {
        /// TODO: implement registration logic
        revert("Not implemented yet");
    }

    /// @notice Cast an anonymous vote using a ZK proof
    /// @param _proof The ZK proof bytes
    /// @param _nullifierHash Hash of the nullifier to prevent double-voting
    /// @param _root The Merkle tree root the proof was generated against
    /// @param _vote The vote choice (bytes32(1) = yes, bytes32(0) = no)
    /// @param _depth The depth of the Merkle tree
    function vote(
        bytes memory _proof,
        bytes32 _nullifierHash,
        bytes32 _root,
        bytes32 _vote,
        bytes32 _depth
    ) public {
        /// TODO: implement voting logic
        revert("Not implemented yet");
    }

    //////////////////////
    /// View Functions ///
    //////////////////////

    /// @notice Get overall voting data
    function getVotingData()
        external
        view
        returns (
            string memory question,
            uint256 yesVotes,
            uint256 noVotes
        )
    {
        return (s_question, s_yesVotes, s_noVotes);

        /// TODO: also return tree root and tree depth when registration is implemented
    }

    /// @notice Get data about a specific voter
    /// @param _voter Address to query
    function getVoterData(
        address _voter
    ) external view returns (bool isAllowed) {
        isAllowed = s_voters[_voter];

        /// TODO: also return hasRegistered when registration is implemented
    }
}
