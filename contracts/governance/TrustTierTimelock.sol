// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title TrustTierTimelock
/// @notice OpenZeppelin's audited TimelockController, deployed as the owner of
///         ModelRegistry, TierAuditLog and LiquidationEngine. Every privileged
///         call - registering or revoking a model, swapping the Tier-2
///         verifier, changing the position source, authorizing a logger - must
///         be scheduled publicly and can only execute after `minDelay`.
///         Users therefore see, for example, a verifier swap coming and can
///         react before it takes effect.
/// @dev In TrustTier's deployment the only proposer and executor is a
///      TrustTierMultisig, so no single key can schedule anything either.
contract TrustTierTimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}
}
