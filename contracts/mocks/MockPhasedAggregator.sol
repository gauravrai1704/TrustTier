// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @title MockPhasedAggregator
/// @notice TEST ONLY: a feed whose round IDs jump like a Chainlink proxy's
///         across an aggregator phase change (phaseId << 64 | roundId), so the
///         last round of a phase has no `roundId + 1`. Also serves as an L2
///         sequencer uptime feed (answer 0 = up, startedAt = since when).
contract MockPhasedAggregator is AggregatorV3Interface {
    struct Round {
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
    }

    uint8 public immutable override decimals;
    string public override description;
    uint80 public latestRound;
    mapping(uint80 => Round) internal rounds;

    error NoDataPresent();

    constructor(uint8 _decimals) {
        decimals = _decimals;
        description = "phased";
    }

    function version() external pure override returns (uint256) {
        return 4;
    }

    function setRound(uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, bool makeLatest) external {
        rounds[roundId] = Round(answer, startedAt, updatedAt);
        if (makeLatest) latestRound = roundId;
    }

    function getRoundData(uint80 roundId) public view override returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = rounds[roundId];
        if (r.updatedAt == 0) revert NoDataPresent();
        return (roundId, r.answer, r.startedAt, r.updatedAt, roundId);
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(latestRound);
    }
}
