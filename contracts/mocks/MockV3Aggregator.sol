// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @title MockV3Aggregator
/// @notice Chainlink-compatible feed for local tests and demos, with round
///         history so the 24-hour momentum lookup (getRoundData) works as on a
///         real feed. Anyone can push answers: TEST/DEMO ONLY.
contract MockV3Aggregator is AggregatorV3Interface {
    struct Round {
        int256 answer;
        uint256 updatedAt;
    }

    uint8 public immutable override decimals;
    string public override description;
    uint80 public latestRound;
    mapping(uint80 => Round) internal rounds;

    error NoDataPresent();

    constructor(uint8 _decimals, string memory _description, int256 initialAnswer) {
        decimals = _decimals;
        description = _description;
        updateAnswer(initialAnswer);
    }

    function version() external pure override returns (uint256) {
        return 4;
    }

    /// @notice New round with the current block time.
    function updateAnswer(int256 answer) public {
        latestRound += 1;
        rounds[latestRound] = Round(answer, block.timestamp);
    }

    /// @notice New round with an explicit timestamp (to build a history).
    function pushRound(int256 answer, uint256 updatedAt) external {
        latestRound += 1;
        rounds[latestRound] = Round(answer, updatedAt);
    }

    /// @notice DEMO ONLY: re-time an existing round (e.g. to seed a 24-hour
    ///         history at deployment without waiting a day).
    function setRoundTimestamp(uint80 roundId, uint256 updatedAt) external {
        if (rounds[roundId].updatedAt == 0) revert NoDataPresent();
        rounds[roundId].updatedAt = updatedAt;
    }

    function latestAnswer() external view returns (int256) {
        return rounds[latestRound].answer;
    }

    function getRoundData(uint80 roundId)
        public
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        Round memory r = rounds[roundId];
        if (r.updatedAt == 0) revert NoDataPresent();
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(latestRound);
    }
}
