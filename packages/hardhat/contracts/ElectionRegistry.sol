// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Voting} from "./Voting.sol";

interface IVotingView {
    function getVoteCount(uint256 candidateIdx) external view returns (uint256);
    function getCandidates() external view returns (string[] memory);
    function getVotingData() external view returns (
        string memory question,
        string[] memory candidates,
        uint8 phase,
        uint256 registrationEndTime,
        uint256 votingEndTime,
        uint256 treeSize,
        uint256 treeDepth,
        uint256 root
    );
}

/**
 * @title ElectionRegistry
 * @notice Maps polling divisions to their Voting contracts.
 *         Provides national result aggregation across all divisions.
 *         Acts as a factory to deploy new division Voting contracts on-chain.
 */
contract ElectionRegistry is Ownable {
    struct Division {
        string name;
        address votingContract;
        address gnOfficer;
        bool active;
    }

    Division[] public divisions;

    /// @notice The shared verifier contract used by all division Voting contracts.
    address public immutable i_verifier;

    event DivisionAdded(uint256 indexed divisionId, string name, address votingContract, address gnOfficer);
    event DivisionUpdated(uint256 indexed divisionId, address votingContract, address gnOfficer);
    event DivisionCreated(uint256 indexed divisionId, string name, address votingContract);

    constructor(address _owner, address _verifier) Ownable(_owner) {
        i_verifier = _verifier;
    }

    /// @notice Deploy a new Voting contract and register it as a division.
    ///         The new contract is owned by this registry's owner (admin).
    ///         GN officer can be assigned later via the Voting contract's setGNOfficer().
    function createDivision(
        string calldata _name
    ) external onlyOwner returns (uint256 divisionId, address votingContract) {
        // Deploy a fresh Voting contract with empty question and no candidates.
        // The admin can configure question + candidates via the admin UI later.
        string[] memory emptyCandidates = new string[](0);
        Voting newVoting = new Voting(owner(), i_verifier, "", emptyCandidates);
        votingContract = address(newVoting);

        divisionId = divisions.length;
        divisions.push(Division({
            name: _name,
            votingContract: votingContract,
            gnOfficer: address(0),
            active: true
        }));

        emit DivisionCreated(divisionId, _name, votingContract);
        emit DivisionAdded(divisionId, _name, votingContract, address(0));
    }

    /// @notice Register a new polling division (with an externally deployed contract).
    function addDivision(
        string calldata _name,
        address _votingContract,
        address _gnOfficer
    ) external onlyOwner returns (uint256 divisionId) {
        divisionId = divisions.length;
        divisions.push(Division({
            name: _name,
            votingContract: _votingContract,
            gnOfficer: _gnOfficer,
            active: true
        }));
        emit DivisionAdded(divisionId, _name, _votingContract, _gnOfficer);
    }

    /// @notice Update a division's contract or GN officer.
    function updateDivision(
        uint256 _divisionId,
        address _votingContract,
        address _gnOfficer
    ) external onlyOwner {
        require(_divisionId < divisions.length, "Invalid division");
        divisions[_divisionId].votingContract = _votingContract;
        divisions[_divisionId].gnOfficer = _gnOfficer;
        emit DivisionUpdated(_divisionId, _votingContract, _gnOfficer);
    }

    /// @notice Get the total number of divisions.
    function getDivisionCount() external view returns (uint256) {
        return divisions.length;
    }

    /// @notice Get all division info.
    function getAllDivisions() external view returns (Division[] memory) {
        return divisions;
    }

    /// @notice Aggregate national vote count for a specific candidate across all divisions.
    function getNationalVoteCount(uint256 _candidateIdx) external view returns (uint256 total) {
        for (uint256 i = 0; i < divisions.length; i++) {
            if (divisions[i].active) {
                total += IVotingView(divisions[i].votingContract).getVoteCount(_candidateIdx);
            }
        }
    }

    /// @notice Get national totals for ALL candidates.
    function getNationalResults() external view returns (uint256[] memory totals) {
        if (divisions.length == 0) return totals;

        // Get candidate count from first division
        string[] memory candidates = IVotingView(divisions[0].votingContract).getCandidates();
        totals = new uint256[](candidates.length);

        for (uint256 i = 0; i < divisions.length; i++) {
            if (divisions[i].active) {
                for (uint256 c = 0; c < candidates.length; c++) {
                    totals[c] += IVotingView(divisions[i].votingContract).getVoteCount(c);
                }
            }
        }
    }

    /// @notice Get per-division results for a specific candidate.
    function getDivisionResults(uint256 _candidateIdx) external view returns (uint256[] memory results) {
        results = new uint256[](divisions.length);
        for (uint256 i = 0; i < divisions.length; i++) {
            if (divisions[i].active) {
                results[i] = IVotingView(divisions[i].votingContract).getVoteCount(_candidateIdx);
            }
        }
    }
}
