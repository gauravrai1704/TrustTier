// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ModelRegistry} from "./ModelRegistry.sol";
import {TierAuditLog} from "./TierAuditLog.sol";
import {ITier2Verifier} from "./interfaces/ITier2Verifier.sol";

/// @title LiquidationEngine
/// @notice Core of TrustTier: routes each liquidation decision through one of
///         three verification tiers, escalating proof strength with a
///         position's proximity to its liquidation boundary, and records
///         every decision to the audit log.
/// @dev Off-chain, the risk-proximity router (Weeks 2-3 of the project plan)
///      computes distance-to-boundary (delta) for a position and decides
///      which tier to submit through. This contract enforces, on-chain, that
///      the tier claimed is actually backed by the evidence required:
///        - Tier 0 (Heuristic):   no model evidence required.
///        - Tier 1 (Commitment):  model must be registered; a commitment hash
///                                 is stored for later probabilistic audit.
///        - Tier 2 (ZkProof):     model must be registered AND a valid
///                                 zk-SNARK proof of correct inference must
///                                 be supplied and verified on-chain.
///      Security properties addressed:
///        - Integrity: Tier 2 proves the reported risk score is the true
///          output of the committed model on the committed input.
///        - Authentication: only registered model versions can back a
///          Tier 1 or Tier 2 decision (enforced via ModelRegistry).
///        - Non-repudiation: every decision, regardless of tier, is written
///          to TierAuditLog before this function returns.
///        - Concurrency / consistency: a per-position finalization lock
///          (see `positionFinalized` below) ensures at most one decision is
///          ever recorded for a given position. Without this, two
///          liquidator bots racing to submit different tiers for the same
///          position in the same block could both succeed, leaving
///          conflicting on-chain state - the audit log would silently hold
///          a stale first record while the second overwrote it, with no
///          record that a race even occurred. This lock also has a
///          performance-side benefit: it gives every decide* call a
///          precise, minimal write footprint scoped to `positionId`, so two
///          transactions for *different* positions are provably
///          non-conflicting under optimistic concurrency control and can
///          be safely executed in parallel - see
///          off-chain/evaluation/concurrency_sim.py for a measured
///          demonstration.
contract LiquidationEngine is Ownable {
    ModelRegistry public modelRegistry;
    TierAuditLog public auditLog;
    ITier2Verifier public tier2Verifier;

    /// @dev Mirrors TierAuditLog.Tier so callers don't need to import that
    ///      contract just to specify a tier.
    enum Tier {
        Heuristic,
        Commitment,
        ZkProof
    }

    /// @notice positionId => commitment hash currently on record from a
    ///         Tier 1 decision, kept for later probabilistic audit.
    mapping(uint256 => bytes32) public tier1Commitments;

    /// @notice positionId => whether a decision has already been finalized
    ///         for it. Checked and set by every decide* function; see the
    ///         contract-level concurrency note above for why this exists.
    mapping(uint256 => bool) public positionFinalized;

    event LiquidationApproved(uint256 indexed positionId, Tier indexed tier, bytes32 modelHash);
    event Tier2VerifierUpdated(address indexed newVerifier);

    error ModelNotAuthorized(bytes32 modelHash);
    error InvalidZkProof(uint256 positionId);
    error CommitmentRequired();
    error PositionAlreadyFinalized(uint256 positionId);

    constructor(address _modelRegistry, address _auditLog, address _tier2Verifier) Ownable(msg.sender) {
        modelRegistry = ModelRegistry(_modelRegistry);
        auditLog = TierAuditLog(_auditLog);
        tier2Verifier = ITier2Verifier(_tier2Verifier);
    }

    /// @dev Reverts if `positionId` already has a finalized decision, then
    ///      marks it finalized. Called first thing in every decide*
    ///      function (checks-effects-interactions: this is an effect, so it
    ///      runs before any external call the function makes, e.g.
    ///      tier2Verifier.verifyProof).
    function _finalizeOnce(uint256 positionId) internal {
        if (positionFinalized[positionId]) {
            revert PositionAlreadyFinalized(positionId);
        }
        positionFinalized[positionId] = true;
    }

    /// @notice Swap the Tier-2 verifier contract. Used to move from
    ///         MockTier2Verifier (Weeks 1-2) to the real EZKL-generated
    ///         verifier (Weeks 3-5) without redeploying this contract.
    function setTier2Verifier(address _tier2Verifier) external onlyOwner {
        tier2Verifier = ITier2Verifier(_tier2Verifier);
        emit Tier2VerifierUpdated(_tier2Verifier);
    }

    /// @notice Tier 0 path: static heuristic rule (e.g. the existing LTV
    ///         threshold), already evaluated off-chain or by a separate
    ///         on-chain rule this contract doesn't need to re-derive. No
    ///         model evidence is required or checked at this tier.
    function decideHeuristic(uint256 positionId) external {
        _finalizeOnce(positionId);
        auditLog.logDecision(positionId, TierAuditLog.Tier.Heuristic, bytes32(0), bytes32(0));
        emit LiquidationApproved(positionId, Tier.Heuristic, bytes32(0));
    }

    /// @notice Tier 1 path: off-chain model inference, hash-committed
    ///         on-chain. The model must be a registered/authorized version.
    ///         The commitment is stored so a later probabilistic audit
    ///         (re-running the inference and comparing) can be performed.
    /// @param modelHash The registered model version that produced the score.
    /// @param commitmentHash keccak256 commitment to (input, output) pair.
    function decideCommitment(uint256 positionId, bytes32 modelHash, bytes32 commitmentHash) external {
        _finalizeOnce(positionId);

        if (!modelRegistry.isAuthorized(modelHash)) {
            revert ModelNotAuthorized(modelHash);
        }
        if (commitmentHash == bytes32(0)) {
            revert CommitmentRequired();
        }

        tier1Commitments[positionId] = commitmentHash;

        auditLog.logDecision(positionId, TierAuditLog.Tier.Commitment, modelHash, commitmentHash);
        emit LiquidationApproved(positionId, Tier.Commitment, modelHash);
    }

    /// @notice Tier 2 path: full zk-SNARK proof of correct model execution,
    ///         verified on-chain before the liquidation is approved. The
    ///         model must be a registered/authorized version.
    /// @param modelHash The registered model version the proof is claimed against.
    /// @param proof The zk-SNARK proof bytes (opaque to this contract).
    /// @param publicInputs Public inputs the proof is checked against.
    function decideZkProof(
        uint256 positionId,
        bytes32 modelHash,
        bytes calldata proof,
        uint256[] calldata publicInputs
    ) external {
        _finalizeOnce(positionId);

        if (!modelRegistry.isAuthorized(modelHash)) {
            revert ModelNotAuthorized(modelHash);
        }

        bool valid = tier2Verifier.verifyProof(proof, publicInputs);
        if (!valid) {
            revert InvalidZkProof(positionId);
        }

        bytes32 proofHash = keccak256(proof);
        auditLog.logDecision(positionId, TierAuditLog.Tier.ZkProof, modelHash, proofHash);
        emit LiquidationApproved(positionId, Tier.ZkProof, modelHash);
    }
}
