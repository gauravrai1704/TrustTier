// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ILiquidationTarget
/// @notice A lending protocol that lets TrustTierLiquidator execute a
///         liquidation the engine approved with a Tier-2 proof.
interface ILiquidationTarget {
    /// @dev Must only accept calls from the protocol's TrustTierLiquidator.
    /// @return debtRepaidUsd debt closed (USD, 8 decimals)
    /// @return collateralSeized collateral moved to `liquidator` (asset units, 18 decimals)
    function executeLiquidation(uint256 positionId, address liquidator)
        external
        returns (uint256 debtRepaidUsd, uint256 collateralSeized);
}
