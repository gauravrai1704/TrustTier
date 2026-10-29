// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPositionSource
/// @notice Where LiquidationEngine reads a position's on-chain state from, so
///         that nobody has to be trusted to supply it. Implemented natively by
///         a lending protocol (MockLendingPool) or by an adapter over an
///         existing one (AaveV3PositionSource).
interface IPositionSource {
    struct Position {
        uint256 collateralUsd;           // collateral value, USD with 8 decimals
        uint256 debtUsd;                 // debt value, USD with 8 decimals
        uint256 liquidationThresholdBps; // e.g. 8000 = 0.80
        uint256 openedAt;                // unix seconds: account age
        uint256 lastTopUpAt;             // unix seconds: last collateral added
        address priceFeed;               // Chainlink price feed of the collateral asset
        address volatilityFeed;          // Chainlink 30-day realized-volatility feed (percent)
    }

    /// @dev Must revert for an unknown position.
    function getPosition(uint256 positionId) external view returns (Position memory);
}
