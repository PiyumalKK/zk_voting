// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IVotingGN {
    function s_gnOfficer() external view returns (address);
}

contract NicRegistry is Ownable {
    error NicRegistry__AlreadyUsed(bytes32 nicHash);

    mapping(bytes32 => bool) private usedNicHashes;
    mapping(address => bool) private s_votingContracts;

    event VotingContractUpdated(address indexed votingContract, bool authorized);
    event NicHashReserved(bytes32 indexed nicHash);

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
        if (usedNicHashes[nicHash]) {
            revert NicRegistry__AlreadyUsed(nicHash);
        }

        usedNicHashes[nicHash] = true;
        emit NicHashReserved(nicHash);
        return true;
    }
}
