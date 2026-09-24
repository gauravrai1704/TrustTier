// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ModelRegistry
/// @notice Registers hash-committed risk-model versions and tracks which are
///         currently authorized to back a liquidation decision.
/// @dev Security properties addressed:
///      - Authentication: only registered, hash-committed model versions can
///        be referenced by LiquidationEngine.
///      - Non-repudiation: registration and revocation are permanently logged
///        on-chain, so the deployer cannot later deny which model version was
///        live at a given time.
contract ModelRegistry is Ownable {
    /// @notice modelHash => currently authorized to back a liquidation.
    mapping(bytes32 => bool) public isAuthorized;

    /// @notice modelHash => block timestamp it was first registered.
    mapping(bytes32 => uint256) public registeredAt;

    /// @notice modelHash => arbitrary off-chain pointer (e.g. an IPFS CID for
    ///         the ONNX file or model card), for auditability. Optional.
    mapping(bytes32 => string) public modelURI;

    event ModelRegistered(bytes32 indexed modelHash, string modelURI, uint256 timestamp);
    event ModelRevoked(bytes32 indexed modelHash, uint256 timestamp);

    error ModelAlreadyRegistered(bytes32 modelHash);
    error ModelNotRegistered(bytes32 modelHash);

    constructor() Ownable(msg.sender) {}

    /// @notice Register a new authorized model version.
    /// @param modelHash keccak256 commitment to the model's weights/architecture
    ///        (in the full system, this is the hash EZKL commits to when the
    ///        ONNX model is compiled into a circuit).
    /// @param uri Optional off-chain pointer to the model artifact for audit
    ///        purposes (e.g. "ipfs://..."). Pass an empty string if unused.
    function registerModel(bytes32 modelHash, string calldata uri) external onlyOwner {
        if (registeredAt[modelHash] != 0) {
            revert ModelAlreadyRegistered(modelHash);
        }
        isAuthorized[modelHash] = true;
        registeredAt[modelHash] = block.timestamp;
        modelURI[modelHash] = uri;
        emit ModelRegistered(modelHash, uri, block.timestamp);
    }

    /// @notice Revoke a previously registered model version (e.g. found to be
    ///         compromised, or superseded by a retrained version).
    function revokeModel(bytes32 modelHash) external onlyOwner {
        if (registeredAt[modelHash] == 0) {
            revert ModelNotRegistered(modelHash);
        }
        isAuthorized[modelHash] = false;
        emit ModelRevoked(modelHash, block.timestamp);
    }

    /// @notice Convenience view combining registration + authorization checks.
    function isValidModel(bytes32 modelHash) external view returns (bool) {
        return isAuthorized[modelHash];
    }
}
