// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITier2Verifier} from "../interfaces/ITier2Verifier.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockTier2Verifier
/// @notice Stand-in for the real EZKL-generated zk-SNARK verifier.
/// @dev This exists purely to de-risk contract/testing work in Weeks 1-2
///      before the EZKL proving pipeline (Weeks 3-5) is built. It lets the
///      test suite exercise both the "proof accepted" and "proof rejected"
///      paths in LiquidationEngine without a real circuit.
///      DO NOT deploy this to any real network - it is a testing fixture only.
contract MockTier2Verifier is ITier2Verifier, Ownable {
    /// @notice When true, every call to verifyProof returns true.
    ///         When false, every call returns false.
    ///         Defaults to true so happy-path tests work out of the box.
    bool public shouldVerify = true;

    /// @notice Per-call override, keyed by keccak256(proof), so a single test
    ///         can simulate a mix of valid and invalid proofs in one run.
    mapping(bytes32 => bool) public proofOverrides;
    mapping(bytes32 => bool) public hasOverride;

    event MockVerificationResult(bytes32 indexed proofHash, bool result);

    constructor() Ownable(msg.sender) {}

    /// @notice Flip the global mock outcome. Useful for a test that wants to
    ///         simulate "the model server generated a bad proof".
    function setShouldVerify(bool _shouldVerify) external onlyOwner {
        shouldVerify = _shouldVerify;
    }

    /// @notice Force a specific proof (identified by its hash) to verify as
    ///         true or false, overriding the global default.
    function setOverrideForProof(bytes calldata proof, bool result) external onlyOwner {
        bytes32 proofHash = keccak256(proof);
        proofOverrides[proofHash] = result;
        hasOverride[proofHash] = true;
    }

    /// @inheritdoc ITier2Verifier
    function verifyProof(bytes calldata proof, uint256[] calldata /* publicInputs */)
        external
        view
        override
        returns (bool valid)
    {
        bytes32 proofHash = keccak256(proof);
        if (hasOverride[proofHash]) {
            return proofOverrides[proofHash];
        }
        return shouldVerify;
    }
}
