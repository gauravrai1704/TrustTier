// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAaveV3Pool, IScaledBalanceToken} from "../sources/AaveV3PositionSource.sol";

/// @notice TEST ONLY: returns the same tuple shape as Aave V3's
///         Pool.getUserAccountData, and doubles as the aToken's scaled balance.
contract MockAavePool is IAaveV3Pool, IScaledBalanceToken {
    struct Data {
        uint256 collateralBase;
        uint256 debtBase;
        uint256 thresholdBps;
        uint256 scaledBalance;
    }

    mapping(address => Data) public data;

    function set(address user, uint256 collateralBase, uint256 debtBase, uint256 thresholdBps, uint256 scaledBalance)
        external
    {
        data[user] = Data(collateralBase, debtBase, thresholdBps, scaledBalance);
    }

    function getUserAccountData(address user)
        external
        view
        override
        returns (uint256, uint256, uint256, uint256, uint256, uint256)
    {
        Data memory d = data[user];
        uint256 hf = d.debtBase == 0 ? type(uint256).max : (d.collateralBase * d.thresholdBps * 1e14) / d.debtBase;
        return (d.collateralBase, d.debtBase, 0, d.thresholdBps, d.thresholdBps, hf);
    }

    function scaledBalanceOf(address user) external view override returns (uint256) {
        return data[user].scaledBalance;
    }
}
