// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Probe — differential-test fixture for the custom chain's write path.
/// @notice Deliberately small and dependency-free. Its only job is to give
///         `e2e/diff/write.mjs` one contract that exercises every shape the
///         real app's contracts rely on, so a Hardhat-vs-custom-chain diff
///         can be made on identical bytecode:
///
///           - a state-changing write that emits an indexed event
///             (receipt.logs field-by-field diff, logsBloom, logIndex);
///           - a revert with a *custom error* carrying arguments — the exact
///             shape `Voting__NullifierHashAlreadyUsed(bytes32)` and friends
///             use, and the reason MASTER §10 pitfall 1 exists: viem must
///             decode the same error name from the JSON-RPC error's `data`
///             on both backends;
///           - a revert with a plain reason string (`require`), which decodes
///             into the error *message* instead;
///           - a pure view function, for eth_call parity.
///
///         Compiled once with solc-js; the artifact is committed as
///         `Probe.json` so running the harness needs no Solidity toolchain.
///         Recompile with `make probe-build` after editing this file.
contract Probe {
    /// @dev Mirrors the argument-carrying custom errors in Voting.sol.
    error Probe__ValueTooLarge(uint256 provided, uint256 max);
    error Probe__NoArgs();

    event ValueSet(address indexed setter, uint256 indexed value, string note);

    uint256 public constant MAX_VALUE = 1000;

    uint256 private s_value;
    uint256 private s_writeCount;

    /// @notice Stores `value` and emits ValueSet. Reverts with a custom error
    ///         carrying arguments when `value` exceeds MAX_VALUE.
    function setValue(uint256 newValue) external {
        if (newValue > MAX_VALUE) {
            revert Probe__ValueTooLarge(newValue, MAX_VALUE);
        }
        s_value = newValue;
        s_writeCount += 1;
        emit ValueSet(msg.sender, newValue, "set");
    }

    /// @notice Always reverts with a zero-argument custom error.
    function revertWithCustomError() external pure {
        revert Probe__NoArgs();
    }

    /// @notice Always reverts with a plain reason string.
    function revertWithReason() external pure {
        require(false, "Probe: nope");
    }

    /// @notice Emits `count` events in one transaction, so a receipt with
    ///         multiple logs can be diffed for sequential logIndex values.
    function emitMany(uint256 count) external {
        for (uint256 i = 0; i < count; i++) {
            s_writeCount += 1;
            emit ValueSet(msg.sender, i, "many");
        }
    }

    function value() external view returns (uint256) {
        return s_value;
    }

    function writeCount() external view returns (uint256) {
        return s_writeCount;
    }
}
