// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Voting} from "./Voting.sol";

interface IVotingView {
    function getVoteCount(uint256 candidateIdx) external view returns (uint256);
    function getCandidates() external view returns (string[] memory);
    function getVotingData() external view returns (
        string memory question,
        address contractOwner,
        uint8 phase,
        uint256 registrationEndTime,
        uint256 votingEndTime,
        uint256 size,
        uint256 depth,
        uint256 root,
        uint256 candidateCount
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

    /// @notice The shared NicRegistry every division Voting contract defers to for
    ///         person-level enrolment rules. Threaded through the constructor
    ///         rather than set afterwards: `createDivision` deploys a `Voting`
    ///         whose registry is immutable, so a division that could be created
    ///         without one would be permanently unenforceable.
    address public immutable i_nicRegistry;

    event DivisionAdded(uint256 indexed divisionId, string name, address votingContract, address gnOfficer);
    event DivisionUpdated(uint256 indexed divisionId, address votingContract, address gnOfficer);
    event DivisionCreated(uint256 indexed divisionId, string name, address votingContract);
    event DivisionsCleared(uint256 count);

    constructor(address _owner, address _verifier, address _nicRegistry) Ownable(_owner) {
        require(_nicRegistry != address(0), "NicRegistry required");
        i_verifier = _verifier;
        i_nicRegistry = _nicRegistry;
    }

    /// @notice Deploy a new Voting contract and register it as a division.
    ///         The new contract is owned by this registry's owner (admin).
    ///         GN officer can be assigned later via the Voting contract's setGNOfficer().
    ///
    ///         The admin must still call `NicRegistry.setVotingContract(voting, true)`:
    ///         that call is `onlyOwner` on a contract this registry does not own,
    ///         so the factory cannot make it. Until it happens the division can
    ///         neither enrol voters nor accept a registration from an enrolled
    ///         device. See `test/DivisionEnrolment.ts`.
    function createDivision(
        string calldata _name
    ) external onlyOwner returns (uint256 divisionId, address votingContract) {
        // Deploy a fresh Voting contract with empty question and no candidates.
        // The admin can configure question + candidates via the admin UI later.
        string[] memory emptyCandidates = new string[](0);
        Voting newVoting = new Voting(owner(), i_verifier, i_nicRegistry, "", emptyCandidates);
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

    /// @notice Remove every registered division, so a new election starts from an
    ///         empty registry.
    ///
    ///         The Voting contracts themselves stay deployed — this contract did
    ///         not necessarily create them and cannot destroy them — but nothing
    ///         in the system reaches a division that is not listed here, so the
    ///         previous election's names, officers, allowlists and tallies all
    ///         disappear from every read path at once. Division ids are indices
    ///         into this array, so they restart at 0 and any GN account still
    ///         holding an old id must be recreated.
    function clearDivisions() external onlyOwner {
        uint256 count = divisions.length;
        delete divisions;
        emit DivisionsCleared(count);
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
