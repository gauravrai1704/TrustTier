// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TierAuditLog
/// @notice Append-only on-chain audit trail recording which verification tier
///         backed every liquidation decision, and the reference needed to
///         re-check it later (commitment hash for Tier 1, proof hash for Tier 2).
/// @dev Security properties addressed:
///      - Non-repudiation: every decision is permanently, publicly logged
///        with the tier, model version, and proof/commitment reference.
///      - Provenance: lets any auditor reconstruct exactly how a given
///        liquidation was justified, without trusting an off-chain log.
///
///      CONCURRENCY DESIGN NOTE: decisions are stored in a mapping keyed by
///      positionId, NOT a dynamically-sized array. An earlier version of
///      this contract used `DecisionRecord[] public decisions` with
///      `decisions.push(...)` on every call - which meant every single
///      transaction, for every position, wrote to the same shared
///      array-length storage slot. Under any concurrency-aware execution
///      scheme (e.g. optimistic concurrency control / parallel EVM
///      execution along the lines of Block-STM), that shared write makes
///      EVERY transaction conflict with EVERY other transaction, forcing
///      full serialization even though transactions for different
///      positions have nothing to do with each other. Keying storage by
///      positionId instead means two transactions only conflict if they
///      target the SAME position - which is correct (they genuinely are
///      racing for the same resource) and is also now prevented outright
///      by LiquidationEngine's per-position finalization lock. Total
///      decision counts are intentionally no longer tracked on-chain (that
///      would reintroduce the exact same shared-write bottleneck via a
///      counter instead of an array); use the DecisionLogged event for
///      off-chain aggregation instead.
contract TierAuditLog is Ownable {
    enum Tier {
        Heuristic, // Tier 0: static on-chain rule, no model involved
        Commitment, // Tier 1: off-chain inference, hash-committed on-chain
        ZkProof // Tier 2: full zk-SNARK proof of correct inference verified on-chain
    }

    struct DecisionRecord {
        uint256 positionId;
        Tier tier;
        bytes32 modelHash;
        bytes32 evidenceRef; // commitment hash (Tier 1) or proof hash (Tier 2); zero for Tier 0
        uint256 timestamp;
    }

    /// @notice Contracts allowed to write to this log (in practice, just the
    ///         current LiquidationEngine, but kept as a mapping so the engine
    ///         can be upgraded/redeployed without redeploying the log).
    mapping(address => bool) public authorizedLoggers;

    /// @notice positionId => its decision record. One record per position,
    ///         ever - LiquidationEngine's finalization lock guarantees a
    ///         position can only be decided once, so this mapping (unlike
    ///         the array it replaces) never needs a second write to the
    ///         same key in correct operation.
    mapping(uint256 => DecisionRecord) public decisionByPosition;

    /// @notice positionId => whether a decision has been recorded for it.
    ///         Needed because a zeroed-out DecisionRecord (position never
    ///         decided) is indistinguishable from a real Tier-0 decision
    ///         (which also has modelHash=0, evidenceRef=0) without this flag.
    mapping(uint256 => bool) public hasDecision;

    event LoggerAuthorized(address indexed logger);
    event LoggerRevoked(address indexed logger);
    event DecisionLogged(
        uint256 indexed positionId,
        Tier indexed tier,
        bytes32 modelHash,
        bytes32 evidenceRef,
        uint256 timestamp
    );

    error NotAuthorizedLogger(address caller);

    constructor() Ownable(msg.sender) {}

    modifier onlyAuthorizedLogger() {
        if (!authorizedLoggers[msg.sender]) {
            revert NotAuthorizedLogger(msg.sender);
        }
        _;
    }

    /// @notice Authorize a contract (expected: LiquidationEngine) to write
    ///         decision records to this log.
    function authorizeLogger(address logger) external onlyOwner {
        authorizedLoggers[logger] = true;
        emit LoggerAuthorized(logger);
    }

    /// @notice Revoke a previously authorized logger.
    function revokeLogger(address logger) external onlyOwner {
        authorizedLoggers[logger] = false;
        emit LoggerRevoked(logger);
    }

    /// @notice Record a liquidation decision. Called by LiquidationEngine
    ///         immediately after a decision is made, for every tier.
    ///         Storage touched is scoped entirely to `positionId` - see the
    ///         contract-level concurrency design note above.
    function logDecision(
        uint256 positionId,
        Tier tier,
        bytes32 modelHash,
        bytes32 evidenceRef
    ) external onlyAuthorizedLogger {
        decisionByPosition[positionId] = DecisionRecord({
            positionId: positionId,
            tier: tier,
            modelHash: modelHash,
            evidenceRef: evidenceRef,
            timestamp: block.timestamp
        });
        hasDecision[positionId] = true;
        emit DecisionLogged(positionId, tier, modelHash, evidenceRef, block.timestamp);
    }
}
