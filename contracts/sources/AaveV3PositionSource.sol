// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPositionSource} from "../interfaces/IPositionSource.sol";

/// @notice The subset of Aave V3's IPool that the adapter reads.
interface IAaveV3Pool {
    /// @dev Base-currency values are USD with 8 decimals; threshold and ltv in bps.
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

/// @notice Aave aTokens expose the balance without accrued interest.
interface IScaledBalanceToken {
    function scaledBalanceOf(address user) external view returns (uint256);
}

/// @title AaveV3PositionSource
/// @notice Reads TrustTier features for an Aave V3 account directly from Aave:
///         collateral, debt and liquidation threshold from
///         Pool.getUserAccountData. Aave does not store when an account opened
///         or last added collateral, so the adapter observes it: `register`
///         records the account (opening time = registration), and anyone can
///         `poke` it to record a top-up whenever the aToken's *scaled* balance
///         (deposits, excluding accrued interest) has grown. Both are derived
///         from on-chain state only, so the adapter adds no trusted party.
/// @dev Features use one reference collateral asset (its aToken, price and
///      volatility feeds), which is exact for single-collateral accounts.
contract AaveV3PositionSource is IPositionSource {
    IAaveV3Pool public immutable pool;
    IScaledBalanceToken public immutable aToken;
    address public immutable priceFeed;
    address public immutable volatilityFeed;

    struct Tracked {
        address user;
        uint256 registeredAt;
        uint256 lastTopUpAt;
        uint256 lastScaledBalance;
    }

    Tracked[] internal tracked;
    mapping(address => uint256) public positionIdOf; // 1-based: 0 = not registered

    event Registered(uint256 indexed positionId, address indexed user);
    event TopUpObserved(uint256 indexed positionId, uint256 scaledBalance);

    error UnknownPosition(uint256 positionId);
    error AlreadyRegistered(address user);
    error NoCollateral(address user);

    constructor(address _pool, address _aToken, address _priceFeed, address _volatilityFeed) {
        pool = IAaveV3Pool(_pool);
        aToken = IScaledBalanceToken(_aToken);
        priceFeed = _priceFeed;
        volatilityFeed = _volatilityFeed;
    }

    /// @notice Start tracking an Aave account; returns its TrustTier position ID.
    function register(address user) external returns (uint256 positionId) {
        if (positionIdOf[user] != 0) revert AlreadyRegistered(user);
        (uint256 collateral, , , , , ) = pool.getUserAccountData(user);
        if (collateral == 0) revert NoCollateral(user);
        tracked.push(Tracked(user, block.timestamp, block.timestamp, aToken.scaledBalanceOf(user)));
        positionId = tracked.length - 1;
        positionIdOf[user] = positionId + 1;
        emit Registered(positionId, user);
    }

    /// @notice Record a top-up if the account's scaled aToken balance grew.
    ///         Permissionless: it only reads Aave state.
    function poke(uint256 positionId) external {
        Tracked storage t = _tracked(positionId);
        uint256 scaled = aToken.scaledBalanceOf(t.user);
        if (scaled > t.lastScaledBalance) {
            t.lastTopUpAt = block.timestamp;
            emit TopUpObserved(positionId, scaled);
        }
        t.lastScaledBalance = scaled;
    }

    function userOf(uint256 positionId) external view returns (address) {
        return _tracked(positionId).user;
    }

    /// @inheritdoc IPositionSource
    function getPosition(uint256 positionId) external view override returns (Position memory p) {
        Tracked storage t = _tracked(positionId);
        (uint256 collateral, uint256 debt, , uint256 threshold, , ) = pool.getUserAccountData(t.user);
        p.collateralUsd = collateral;
        p.debtUsd = debt;
        p.liquidationThresholdBps = threshold;
        p.openedAt = t.registeredAt;
        p.lastTopUpAt = t.lastTopUpAt;
        p.priceFeed = priceFeed;
        p.volatilityFeed = volatilityFeed;
    }

    function _tracked(uint256 positionId) internal view returns (Tracked storage) {
        if (positionId >= tracked.length) revert UnknownPosition(positionId);
        return tracked[positionId];
    }
}
