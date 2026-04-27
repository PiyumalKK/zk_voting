// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IVerifier {
    function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) external view returns (bool);
}

/// @title HonkVerifier - Placeholder for ZK proof verification
/// @notice This will be replaced with the real Barretenberg-generated verifier later
contract HonkVerifier is IVerifier {
    /// @notice Placeholder verify function - always returns true for now
    function verify(
        bytes calldata _proof,
        bytes32[] calldata _publicInputs
    ) external pure returns (bool) {
        _proof;
        _publicInputs;
        return true;
    }
}
