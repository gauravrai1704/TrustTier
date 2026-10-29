// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TierAuditLog} from "../TierAuditLog.sol";

/// @notice ABLATION ONLY: the midsem-era audit log, which appended every
///         decision to one array (and so wrote the array's shared length
///         slot in every transaction). Same logDecision signature as
///         TierAuditLog, so LiquidationEngine can be pointed at it to measure
///         what the per-position mapping buys (scripts/concurrency_trace.js).
contract LegacyArrayAuditLog {
    struct DecisionRecord {
        uint256 positionId;
        TierAuditLog.Tier tier;
        bytes32 modelHash;
        bytes32 evidenceRef;
        uint256 timestamp;
    }

    DecisionRecord[] public decisions;
    mapping(address => bool) public authorizedLoggers;

    function authorizeLogger(address logger) external {
        authorizedLoggers[logger] = true;
    }

    function logDecision(uint256 positionId, TierAuditLog.Tier tier, bytes32 modelHash, bytes32 evidenceRef) external {
        require(authorizedLoggers[msg.sender], "not authorized");
        decisions.push(DecisionRecord(positionId, tier, modelHash, evidenceRef, block.timestamp));
    }

    function decisionCount() external view returns (uint256) {
        return decisions.length;
    }
}
