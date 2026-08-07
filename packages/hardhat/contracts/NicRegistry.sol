// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IVotingGN {
    function s_gnOfficer() external view returns (address);
}

contract NicRegistry is Ownable {
    error NicRegistry__AlreadyUsed(bytes32 nicHash);

    // Monotonic enrolment epoch. Reserved NIC hashes are keyed by it so that
    // clearNicHashes() can wipe every reservation by bumping the counter, the
    // same trick Voting.sol uses for its per-election state — a mapping cannot
    // be iterated, so this is the only way to clear one at bounded cost.
    uint256 private s_epoch;

    // epoch => nicHash => reserved
    mapping(uint256 => mapping(bytes32 => bool)) private usedNicHashes;
    mapping(address => bool) private s_votingContracts;

    event VotingContractUpdated(address indexed votingContract, bool authorized);
    event NicHashReserved(bytes32 indexed nicHash);
    event NicHashesCleared(uint256 epoch);

    modifier onlyOwnerOrGN(address votingContract) {
        require(s_votingContracts[votingContract], "Unregistered division");
        require(msg.sender == owner() || msg.sender == IVotingGN(votingContract).s_gnOfficer(), "Not owner or GN");
        _;
    }

    constructor(address _owner) Ownable(_owner) {}

    function setVotingContract(address _votingContract, bool _authorized) external onlyOwner {
        s_votingContracts[_votingContract] = _authorized;
        emit VotingContractUpdated(_votingContract, _authorized);
    }

    function reserveNicHash(bytes32 nicHash, address votingContract) external onlyOwnerOrGN(votingContract) returns (bool) {
        uint256 epoch = s_epoch;
        if (usedNicHashes[epoch][nicHash]) {
            revert NicRegistry__AlreadyUsed(nicHash);
        }

        usedNicHashes[epoch][nicHash] = true;
        emit NicHashReserved(nicHash);
        return true;
    }

    /// @notice Release every reserved NIC hash, so the same citizens can be
    ///         enrolled again in a new election. Without this a fresh election
    ///         would reject every voter who took part in the previous one.
    function clearNicHashes() external onlyOwner {
        s_epoch++;
        emit NicHashesCleared(s_epoch);
    }

    /// @notice The current enrolment epoch. Bumped by every clearNicHashes().
    function getCurrentEpoch() external view returns (uint256) {
        return s_epoch;
    }

    /// @notice Whether `nicHash` is already reserved in the current epoch.
    function isNicHashUsed(bytes32 nicHash) external view returns (bool) {
        return usedNicHashes[s_epoch][nicHash];
    }
}
