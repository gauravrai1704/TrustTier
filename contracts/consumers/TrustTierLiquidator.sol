// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LiquidationEngine} from "../LiquidationEngine.sol";
import {ILiquidationTarget} from "../interfaces/ILiquidationTarget.sol";

/// @title TrustTierLiquidator
/// @notice The consumer of TrustTier decisions: the only path by which the
///         lending protocol liquidates a position. A liquidation runs only on
///         an open Tier-2 approval (a verified proof that the registered
///         model, on the position's on-chain features, says HIGH RISK), and
///         consumes it, so one proof buys exactly one liquidation within
///         LiquidationEngine.APPROVAL_TTL. Permissionless: whoever executes
///         receives the protocol's liquidation bonus, which is what pays the
///         keeper for the proof.
contract TrustTierLiquidator {
    LiquidationEngine public immutable engine;
    ILiquidationTarget public immutable target;

    event LiquidationExecuted(
        uint256 indexed positionId, address indexed liquidator, uint256 debtRepaidUsd, uint256 collateralSeized
    );

    constructor(address _engine, address _target) {
        engine = LiquidationEngine(_engine);
        target = ILiquidationTarget(_target);
    }

    /// @notice Execute the approved liquidation of `positionId`.
    function liquidate(uint256 positionId) external returns (uint256 debtRepaidUsd, uint256 collateralSeized) {
        engine.consumeApproval(positionId); // reverts unless an approval is open
        (debtRepaidUsd, collateralSeized) = target.executeLiquidation(positionId, msg.sender);
        emit LiquidationExecuted(positionId, msg.sender, debtRepaidUsd, collateralSeized);
    }
}
