// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPositionSource} from "../interfaces/IPositionSource.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";
import {ILiquidationTarget} from "../interfaces/ILiquidationTarget.sol";

/// @title MockLendingPool
/// @notice A minimal lending protocol that integrates TrustTier natively: it
///         records each position's collateral, debt, opening time and last
///         collateral top-up, and values collateral with the market's
///         Chainlink price feed. Positions are bookkeeping only (no tokens
///         move): this is a TEST/DEMO stand-in for a real protocol, and the
///         timestamp setter exists so demos can create aged positions.
///
///         Liquidations are SOFT: an approved liquidation closes CLOSE_FACTOR
///         of the debt and moves collateral worth the repaid debt plus a
///         LIQUIDATION_BONUS to the liquidator, which pulls the position back
///         from the boundary instead of closing it. Only the pool's
///         TrustTierLiquidator may liquidate, so every liquidation is backed
///         by a Tier-2 proof - including pre-emptive ones before LTV crosses
///         the threshold, which is what the model is for.
contract MockLendingPool is IPositionSource, ILiquidationTarget {
    struct Market {
        address priceFeed;
        address volatilityFeed;
        uint256 liquidationThresholdBps;
    }

    struct Account {
        uint256 market;
        uint256 collateralAmount; // collateral asset units, 18 decimals
        uint256 debtUsd;          // 8 decimals
        uint256 openedAt;
        uint256 lastTopUpAt;
        bool exists;
    }

    uint256 public constant CLOSE_FACTOR_BPS = 5000;     // repay 50% of the debt
    uint256 public constant LIQUIDATION_BONUS_BPS = 500; // +5% collateral to the liquidator

    Market[] public markets;
    mapping(uint256 => Account) public accounts;
    /// @notice Collateral credited to liquidators, per market (asset units).
    mapping(address => mapping(uint256 => uint256)) public seizedCollateral;
    address public owner;
    address public liquidator;

    event MarketAdded(uint256 indexed market, address priceFeed, address volatilityFeed, uint256 thresholdBps);
    event PositionOpened(uint256 indexed positionId, uint256 indexed market, uint256 collateralAmount, uint256 debtUsd);
    event CollateralAdded(uint256 indexed positionId, uint256 amount);
    event DebtChanged(uint256 indexed positionId, uint256 debtUsd);
    event LiquidatorSet(address indexed liquidator);
    event PositionLiquidated(
        uint256 indexed positionId, address indexed liquidator, uint256 debtRepaidUsd, uint256 collateralSeized
    );

    error UnknownPosition(uint256 positionId);
    error PositionExists(uint256 positionId);
    error UnknownMarket(uint256 market);
    error BadPrice(address feed);
    error NotOwner();
    error NotLiquidator();
    error NothingToLiquidate(uint256 positionId);

    constructor() {
        owner = msg.sender;
    }

    /// @notice Wire the TrustTierLiquidator once it is deployed.
    function setLiquidator(address _liquidator) external {
        if (msg.sender != owner) revert NotOwner();
        liquidator = _liquidator;
        emit LiquidatorSet(_liquidator);
    }

    function addMarket(address priceFeed, address volatilityFeed, uint256 thresholdBps) external returns (uint256 id) {
        id = markets.length;
        markets.push(Market(priceFeed, volatilityFeed, thresholdBps));
        emit MarketAdded(id, priceFeed, volatilityFeed, thresholdBps);
    }

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function openPosition(uint256 positionId, uint256 market, uint256 collateralAmount, uint256 debtUsd) external {
        if (accounts[positionId].exists) revert PositionExists(positionId);
        if (market >= markets.length) revert UnknownMarket(market);
        accounts[positionId] = Account(market, collateralAmount, debtUsd, block.timestamp, block.timestamp, true);
        emit PositionOpened(positionId, market, collateralAmount, debtUsd);
    }

    /// @notice Adding collateral is a top-up: it resets time-since-top-up.
    function addCollateral(uint256 positionId, uint256 amount) external {
        Account storage a = _account(positionId);
        a.collateralAmount += amount;
        a.lastTopUpAt = block.timestamp;
        emit CollateralAdded(positionId, amount);
    }

    function setDebt(uint256 positionId, uint256 debtUsd) external {
        _account(positionId).debtUsd = debtUsd;
        emit DebtChanged(positionId, debtUsd);
    }

    /// @notice DEMO ONLY: back-date a position's history.
    function setTimestamps(uint256 positionId, uint256 openedAt, uint256 lastTopUpAt) external {
        Account storage a = _account(positionId);
        a.openedAt = openedAt;
        a.lastTopUpAt = lastTopUpAt;
    }

    /// @inheritdoc ILiquidationTarget
    function executeLiquidation(uint256 positionId, address to)
        external
        override
        returns (uint256 debtRepaidUsd, uint256 collateralSeized)
    {
        if (msg.sender != liquidator) revert NotLiquidator();
        Account storage a = _account(positionId);
        if (a.debtUsd == 0 || a.collateralAmount == 0) revert NothingToLiquidate(positionId);
        Market storage m = markets[a.market];
        (, int256 price, , , ) = AggregatorV3Interface(m.priceFeed).latestRoundData();
        if (price <= 0) revert BadPrice(m.priceFeed);
        debtRepaidUsd = (a.debtUsd * CLOSE_FACTOR_BPS) / 10_000;
        collateralSeized = (debtRepaidUsd * (10_000 + LIQUIDATION_BONUS_BPS) * 1e18) / (10_000 * uint256(price));
        if (collateralSeized > a.collateralAmount) collateralSeized = a.collateralAmount;
        a.debtUsd -= debtRepaidUsd;
        a.collateralAmount -= collateralSeized;
        seizedCollateral[to][a.market] += collateralSeized;
        emit PositionLiquidated(positionId, to, debtRepaidUsd, collateralSeized);
    }

    /// @inheritdoc IPositionSource
    function getPosition(uint256 positionId) external view override returns (Position memory p) {
        Account storage a = _account(positionId);
        Market storage m = markets[a.market];
        (, int256 price, , , ) = AggregatorV3Interface(m.priceFeed).latestRoundData();
        if (price <= 0) revert BadPrice(m.priceFeed);
        p.collateralUsd = (a.collateralAmount * uint256(price)) / 1e18; // 8-decimal USD
        p.debtUsd = a.debtUsd;
        p.liquidationThresholdBps = m.liquidationThresholdBps;
        p.openedAt = a.openedAt;
        p.lastTopUpAt = a.lastTopUpAt;
        p.priceFeed = m.priceFeed;
        p.volatilityFeed = m.volatilityFeed;
    }

    function _account(uint256 positionId) internal view returns (Account storage a) {
        a = accounts[positionId];
        if (!a.exists) revert UnknownPosition(positionId);
    }
}
