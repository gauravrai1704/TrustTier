// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ModelRegistry} from "./ModelRegistry.sol";
import {TierAuditLog} from "./TierAuditLog.sol";
import {ITier2Verifier} from "./interfaces/ITier2Verifier.sol";
import {IPositionSource} from "./interfaces/IPositionSource.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @title LiquidationEngine
/// @notice Core of TrustTier: records one risk decision per position, with
///         verification strength that grows as the position nears its
///         liquidation boundary.
///
/// VERIFIED INPUTS, NOT TRUSTED INPUTS
///   The engine never takes a position's state from a caller. For every
///   decision it reads it from its on-chain sources:
///     - collateral, debt and liquidation threshold from the lending protocol
///       (IPositionSource: a native protocol, or an adapter such as Aave V3's),
///     - the collateral price now and 24 hours ago from a Chainlink price feed,
///     - 30-day realized volatility from a Chainlink volatility feed,
///     - account age and time since the last collateral top-up from the
///       protocol's (or adapter's) timestamps,
///   and turns them into the model's five features, min-max normalized and
///   quantized to integers q in [0, 1024] - exactly the values the Tier-2
///   circuit takes as PUBLIC inputs. From the same data it computes
///   delta = liquidation threshold - LTV.
///
/// TIERS (enforced on-chain from delta, not chosen by a trusted router)
///   - Tier 0 (heuristic, bonded):   allowed only if delta > 15%.
///   - Tier 1 (commitment, bonded):  allowed only if delta > 5%.
///   - Tier 2 (zk-SNARK):            always allowed; approves the liquidation
///     only if the proof's five public inputs equal the features read now and
///     its label is HIGH_RISK.
///   A Tier 0/1 claim snapshots the features it was made on. During the
///   1-hour challenge window anyone may slash its bond with a Tier-2 proof
///   whose public inputs equal that snapshot and whose label is HIGH_RISK, so
///   an honest claimant is never punished for prices that moved afterwards.
///
/// LIFECYCLE
///   - A Tier-2 liquidation is final.
///   - A Tier 0/1 claim blocks new decisions while its window is open.
///   - A successful challenge re-opens the position at once (the challenger's
///     proof is then generally valid for decideZkProof, if prices have not
///     moved since the claim).
///   - After an unchallenged window, the next decision re-opens the position
///     and credits the previous claimant's bond.
///
/// Public-instance layout produced by circuits/build_circuit.py:
///   [0..4] q_ltv, q_vol, q_mom, q_topup, q_age   (INSTANCE_LABEL = 5)
///   [5]    label, 1 = high risk
///   [6..7] P(low), P(high), scaled by 2^10
contract LiquidationEngine is Ownable {
    ModelRegistry public modelRegistry;
    TierAuditLog public auditLog;
    ITier2Verifier public tier2Verifier;
    IPositionSource public positionSource;

    /// @notice The registered model whose circuit `tier2Verifier` verifies.
    bytes32 public tier2ModelHash;

    /// @notice Oldest acceptable Chainlink answers (seconds).
    uint256 public maxPriceAge;
    uint256 public maxVolatilityAge;

    enum Tier {
        Heuristic,
        Commitment,
        ZkProof
    }

    // --- policy constants -------------------------------------------------
    int256 public constant TIER0_MIN_DELTA_BPS = 1500; // delta > 15%
    int256 public constant TIER1_MIN_DELTA_BPS = 500;  // delta > 5%
    uint256 public constant N_FEATURES = 5;
    uint256 public constant INSTANCE_LABEL = 5;
    uint256 public constant HIGH_RISK = 1;
    uint256 public constant SCALE = 1024;              // circuit input scale 2^10
    uint256 public constant MOMENTUM_WINDOW = 24 hours;
    uint256 public constant MAX_TOPUP_DAYS = 90;
    uint256 public constant MAX_AGE_DAYS = 2000;

    uint256 public constant MIN_BOND = 0.01 ether;
    uint256 public constant CHALLENGE_WINDOW = 1 hours;

    // --- per-position state (every key scoped to positionId or an account) --
    /// @dev Packed into three storage slots so a bonded claim writes three
    ///      fresh slots instead of six.
    struct PositionState {
        address claimant;          // slot 0
        uint96 bond;               // slot 0
        uint64 challengeDeadline;  // slot 1
        bool decided;              // slot 1: a decision is on record
        bool liquidationFinal;     // slot 1: a Tier-2 liquidation (terminal)
        bool challenged;           // slot 1
        bytes32 featureSnapshot;   // slot 2: keccak256 of the claim's five features
    }

    mapping(uint256 => PositionState) internal _state;
    mapping(uint256 => bytes32) public tier1Commitments;
    mapping(address => uint256) public pendingWithdrawals;

    event LiquidationApproved(uint256 indexed positionId, Tier indexed tier, bytes32 modelHash);
    event FeaturesSnapshotted(uint256 indexed positionId, uint256[5] features, int256 deltaBps);
    event PositionReopened(uint256 indexed positionId, uint256 bondCredited);
    event ClaimSuperseded(uint256 indexed positionId, address indexed claimant);
    event Tier2VerifierUpdated(address indexed newVerifier, bytes32 indexed modelHash);
    event PositionSourceUpdated(address indexed newSource);
    event MaxFeedAgesUpdated(uint256 maxPriceAge, uint256 maxVolatilityAge);
    event DecisionChallenged(uint256 indexed positionId, address indexed challenger, uint256 bond);
    event BondReclaimed(uint256 indexed positionId, address indexed claimant, uint256 bond);
    event Withdrawn(address indexed account, uint256 amount);
    event Deposited(address indexed account, uint256 amount);

    error ModelNotAuthorized(bytes32 modelHash);
    error ModelNotBoundToVerifier(bytes32 modelHash);
    error InvalidZkProof(uint256 positionId);
    error CommitmentRequired();
    error PositionAlreadyFinalized(uint256 positionId);
    error TierNotAllowed(uint256 positionId, Tier tier, int256 deltaBps);
    error ProofNotForPosition(uint256 positionId);
    error ProofDoesNotShowHighRisk(uint256 positionId);
    error UnknownPosition(uint256 positionId);
    error StaleFeed(address feed, uint256 updatedAt);
    error InvalidFeedAnswer(address feed);
    error BadMomentumRound(uint80 roundId);
    error InsufficientBond(uint256 positionId, uint256 required, uint256 sent);
    error NotChallengeable(uint256 positionId);
    error ChallengeWindowClosed(uint256 positionId);
    error ChallengeWindowStillOpen(uint256 positionId);
    error AlreadyChallenged(uint256 positionId);
    error ChallengeDidNotContradictClaim(uint256 positionId);
    error NoBondToReclaim(uint256 positionId);
    error NothingToWithdraw();
    error BondTooLarge();

    constructor(
        address _modelRegistry,
        address _auditLog,
        address _tier2Verifier,
        bytes32 _tier2ModelHash,
        address _positionSource,
        uint256 _maxPriceAge,
        uint256 _maxVolatilityAge
    ) Ownable(msg.sender) {
        modelRegistry = ModelRegistry(_modelRegistry);
        auditLog = TierAuditLog(_auditLog);
        tier2Verifier = ITier2Verifier(_tier2Verifier);
        tier2ModelHash = _tier2ModelHash;
        positionSource = IPositionSource(_positionSource);
        maxPriceAge = _maxPriceAge;
        maxVolatilityAge = _maxVolatilityAge;
    }

    // =====================================================================
    // Per-position views
    // =====================================================================

    function positionFinalized(uint256 positionId) external view returns (bool) {
        return _state[positionId].decided;
    }

    function liquidationFinal(uint256 positionId) external view returns (bool) {
        return _state[positionId].liquidationFinal;
    }

    function featureSnapshot(uint256 positionId) external view returns (bytes32) {
        return _state[positionId].featureSnapshot;
    }

    function bondOf(uint256 positionId) external view returns (uint256) {
        return _state[positionId].bond;
    }

    function claimant(uint256 positionId) external view returns (address) {
        return _state[positionId].claimant;
    }

    function challengeDeadline(uint256 positionId) external view returns (uint256) {
        return _state[positionId].challengeDeadline;
    }

    function challenged(uint256 positionId) external view returns (bool) {
        return _state[positionId].challenged;
    }

    // =====================================================================
    // Owner configuration (behind the multisig + timelock when governed)
    // =====================================================================

    function setTier2Verifier(address _tier2Verifier, bytes32 _tier2ModelHash) external onlyOwner {
        tier2Verifier = ITier2Verifier(_tier2Verifier);
        tier2ModelHash = _tier2ModelHash;
        emit Tier2VerifierUpdated(_tier2Verifier, _tier2ModelHash);
    }

    function setPositionSource(address _positionSource) external onlyOwner {
        positionSource = IPositionSource(_positionSource);
        emit PositionSourceUpdated(_positionSource);
    }

    function setMaxFeedAges(uint256 _maxPriceAge, uint256 _maxVolatilityAge) external onlyOwner {
        maxPriceAge = _maxPriceAge;
        maxVolatilityAge = _maxVolatilityAge;
        emit MaxFeedAgesUpdated(_maxPriceAge, _maxVolatilityAge);
    }

    // =====================================================================
    // On-chain features
    // =====================================================================

    /// @notice The five quantized features and delta of a position, computed
    ///         from on-chain data only.
    /// @param pastRoundId The price feed round that was current 24 hours ago
    ///        (found off-chain by walking back from the latest round; checked
    ///        here). Needed for the momentum feature.
    /// @return q [ltv, volatility, momentum, topup, age], each in [0, 1024]
    /// @return deltaBps liquidation threshold minus LTV, in basis points
    function currentFeatures(uint256 positionId, uint80 pastRoundId)
        public
        view
        returns (uint256[5] memory q, int256 deltaBps)
    {
        IPositionSource.Position memory p = positionSource.getPosition(positionId);
        if (p.collateralUsd == 0) revert UnknownPosition(positionId);

        // LTV: ltv / 1.5 * 1024 == debt * 2048 / (3 * collateral)
        q[0] = _min(p.debtUsd * 2048 / (3 * p.collateralUsd), SCALE);
        deltaBps = int256(p.liquidationThresholdBps) - int256(p.debtUsd * 10_000 / p.collateralUsd);

        // Volatility: the feed answers in percent; normalized range [0, 1]
        (uint256 vol, uint8 volDecimals) = _freshAnswer(p.volatilityFeed, maxVolatilityAge);
        q[1] = _min(vol * SCALE / (100 * 10 ** volDecimals), SCALE);

        // Momentum: (p_now / p_past - 1 + 1) / 2 * 1024 == p_now * 512 / p_past
        (uint256 priceNow, ) = _freshAnswer(p.priceFeed, maxPriceAge);
        uint256 pricePast = _priceAt24hAgo(p.priceFeed, pastRoundId);
        q[2] = _min(priceNow * 512 / pricePast, SCALE);

        // Whole days since the last top-up and since the account opened
        uint256 topupDays = _min(_daysSince(p.lastTopUpAt), MAX_TOPUP_DAYS);
        q[3] = topupDays * SCALE / MAX_TOPUP_DAYS;
        uint256 ageDays = _min(_daysSince(p.openedAt), MAX_AGE_DAYS);
        q[4] = ageDays * SCALE / MAX_AGE_DAYS;
    }

    function _freshAnswer(address feed, uint256 maxAge) internal view returns (uint256 answer, uint8 decimals) {
        (, int256 a, , uint256 updatedAt, ) = AggregatorV3Interface(feed).latestRoundData();
        if (a <= 0) revert InvalidFeedAnswer(feed);
        if (updatedAt + maxAge < block.timestamp) revert StaleFeed(feed, updatedAt);
        return (uint256(a), AggregatorV3Interface(feed).decimals());
    }

    /// @dev The round in effect 24 hours ago: it was updated at or before that
    ///      moment, and the next round (if any) after it.
    function _priceAt24hAgo(address feed, uint80 roundId) internal view returns (uint256) {
        uint256 target = block.timestamp - MOMENTUM_WINDOW;
        AggregatorV3Interface f = AggregatorV3Interface(feed);
        (, int256 answer, , uint256 updatedAt, ) = f.getRoundData(roundId);
        if (answer <= 0 || updatedAt == 0 || updatedAt > target) revert BadMomentumRound(roundId);
        (uint80 latestId, , , , ) = f.latestRoundData();
        if (roundId != latestId) {
            (, , , uint256 nextUpdatedAt, ) = f.getRoundData(roundId + 1);
            if (nextUpdatedAt <= target) revert BadMomentumRound(roundId);
        }
        return uint256(answer);
    }

    /// @dev Whole days since `t`; a timestamp in the future counts as 0 days,
    ///      so a misreporting source cannot make the position undecidable.
    function _daysSince(uint256 t) internal view returns (uint256) {
        return t >= block.timestamp ? 0 : (block.timestamp - t) / 1 days;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _featureHash(uint256[5] memory q) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(q));
    }

    function _proofFeatureHash(uint256[] calldata publicInputs) internal pure returns (bytes32) {
        uint256[5] memory q;
        for (uint256 i = 0; i < N_FEATURES; i++) {
            q[i] = publicInputs[i];
        }
        return _featureHash(q);
    }

    // =====================================================================
    // Decision lifecycle helpers
    // =====================================================================

    /// @dev Admits a new decision for `positionId`. A previous Tier 0/1 claim
    ///      whose window has closed is re-opened (its bond credited). While a
    ///      claim's window is open, only a Tier-2 liquidation may proceed: a
    ///      proof that the position is high risk NOW supersedes a cheap claim,
    ///      so a claim cannot delay a needed liquidation. The superseded claim
    ///      keeps its bond, snapshot and window - it can still be challenged
    ///      (if it was false when made) or reclaimed (if not). A Tier-2
    ///      liquidation is final. Runs before any external call.
    function _beginDecision(uint256 positionId, bool tier2) internal {
        PositionState storage st = _state[positionId];
        if (st.decided) {
            if (st.liquidationFinal) revert PositionAlreadyFinalized(positionId);
            if (block.timestamp <= st.challengeDeadline) {
                if (!tier2) revert PositionAlreadyFinalized(positionId);
                emit ClaimSuperseded(positionId, st.claimant);
                return;
            }
            _reopen(positionId, st);
        }
        st.decided = true;
    }

    function _reopen(uint256 positionId, PositionState storage st) internal {
        uint256 bond = st.bond;
        if (bond != 0) {
            st.bond = 0;
            pendingWithdrawals[st.claimant] += bond;
        }
        delete tier1Commitments[positionId];
        emit PositionReopened(positionId, bond);
    }

    /// @dev Tier 0/1 bookkeeping: bond, claimant, challenge window, snapshot.
    /// @dev The bond is either sent with the call (msg.value), or - when the
    ///      call carries no ETH - drawn from the claimant's own balance in
    ///      `pendingWithdrawals` (pre-funded with `deposit`, or recycled from
    ///      reclaimed and slashed bonds). The second way never touches the
    ///      engine's ETH balance, which every msg.value bond writes: on an
    ///      execution engine that treats balance updates as read-modify-
    ///      writes, msg.value bonds make all cheap claims in a block conflict
    ///      with each other, while deposit-funded bonds only touch the
    ///      claimant's own slot.
    function _openBondedClaim(uint256 positionId, uint256[5] memory q, int256 deltaBps) internal returns (bytes32 snap) {
        uint256 bond = msg.value;
        if (bond == 0) {
            uint256 available = pendingWithdrawals[msg.sender];
            if (available < MIN_BOND) revert InsufficientBond(positionId, MIN_BOND, available);
            pendingWithdrawals[msg.sender] = available - MIN_BOND;
            bond = MIN_BOND;
        } else if (bond < MIN_BOND) {
            revert InsufficientBond(positionId, MIN_BOND, bond);
        }
        if (bond > type(uint96).max) revert BondTooLarge();
        PositionState storage st = _state[positionId];
        st.claimant = msg.sender;
        st.bond = uint96(bond);
        st.challengeDeadline = uint64(block.timestamp + CHALLENGE_WINDOW);
        st.challenged = false;
        snap = _featureHash(q);
        st.featureSnapshot = snap;
        emit FeaturesSnapshotted(positionId, q, deltaBps);
    }

    function _requireTier2Model(bytes32 modelHash) internal view {
        if (!modelRegistry.isAuthorized(modelHash)) revert ModelNotAuthorized(modelHash);
        if (modelHash != tier2ModelHash) revert ModelNotBoundToVerifier(modelHash);
    }

    /// @dev EZKL's verifier reverts on a bad proof instead of returning false.
    function _verify(bytes calldata proof, uint256[] calldata publicInputs) internal returns (bool) {
        try tier2Verifier.verifyProof(proof, publicInputs) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    // =====================================================================
    // Decisions
    // =====================================================================

    /// @notice Tier 0: a bonded claim that the position is far from its
    ///         liquidation boundary. Allowed only if delta > 15% on-chain.
    function decideHeuristic(uint256 positionId, uint80 pastRoundId) external payable {
        _beginDecision(positionId, false);
        (uint256[5] memory q, int256 deltaBps) = currentFeatures(positionId, pastRoundId);
        if (deltaBps <= TIER0_MIN_DELTA_BPS) revert TierNotAllowed(positionId, Tier.Heuristic, deltaBps);
        bytes32 snap = _openBondedClaim(positionId, q, deltaBps);
        auditLog.logDecision(positionId, TierAuditLog.Tier.Heuristic, bytes32(0), snap);
        emit LiquidationApproved(positionId, Tier.Heuristic, bytes32(0));
    }

    /// @notice Tier 1: a bonded, salted commitment to an off-chain model
    ///         score. Allowed only if delta > 5% on-chain.
    /// @param commitmentHash keccak256(features, score, 32-byte salt); revealing
    ///        the salt later lets an auditor check the claim.
    function decideCommitment(uint256 positionId, uint80 pastRoundId, bytes32 modelHash, bytes32 commitmentHash)
        external
        payable
    {
        _beginDecision(positionId, false);
        if (!modelRegistry.isAuthorized(modelHash)) revert ModelNotAuthorized(modelHash);
        if (commitmentHash == bytes32(0)) revert CommitmentRequired();
        (uint256[5] memory q, int256 deltaBps) = currentFeatures(positionId, pastRoundId);
        if (deltaBps <= TIER1_MIN_DELTA_BPS) revert TierNotAllowed(positionId, Tier.Commitment, deltaBps);
        _openBondedClaim(positionId, q, deltaBps);
        tier1Commitments[positionId] = commitmentHash;
        auditLog.logDecision(positionId, TierAuditLog.Tier.Commitment, modelHash, commitmentHash);
        emit LiquidationApproved(positionId, Tier.Commitment, modelHash);
    }

    /// @notice Tier 2: approve the liquidation with a zk-SNARK showing that the
    ///         registered model, run on this position's on-chain features as
    ///         they are now, outputs HIGH_RISK.
    function decideZkProof(
        uint256 positionId,
        uint80 pastRoundId,
        bytes32 modelHash,
        bytes calldata proof,
        uint256[] calldata publicInputs
    ) external {
        _beginDecision(positionId, true);
        _requireTier2Model(modelHash);
        (uint256[5] memory q, ) = currentFeatures(positionId, pastRoundId);
        if (publicInputs.length <= INSTANCE_LABEL) revert ProofNotForPosition(positionId);
        for (uint256 i = 0; i < N_FEATURES; i++) {
            if (publicInputs[i] != q[i]) revert ProofNotForPosition(positionId);
        }
        if (publicInputs[INSTANCE_LABEL] != HIGH_RISK) revert ProofDoesNotShowHighRisk(positionId);
        if (!_verify(proof, publicInputs)) revert InvalidZkProof(positionId);
        _state[positionId].liquidationFinal = true;

        bytes32 proofHash = keccak256(proof);
        auditLog.logDecision(positionId, TierAuditLog.Tier.ZkProof, modelHash, proofHash);
        emit LiquidationApproved(positionId, Tier.ZkProof, modelHash);
    }

    // =====================================================================
    // Bonded challenge window
    // =====================================================================

    /// @notice Slash a Tier 0/1 claim with a Tier-2 proof that the position,
    ///         with the features snapshotted at the claim, was HIGH_RISK.
    function challengeDecision(
        uint256 positionId,
        bytes32 modelHash,
        bytes calldata proof,
        uint256[] calldata publicInputs
    ) external {
        PositionState storage st = _state[positionId];
        if (st.challenged) revert AlreadyChallenged(positionId);
        uint256 bond = st.bond;
        if (bond == 0) revert NotChallengeable(positionId);
        if (block.timestamp > st.challengeDeadline) revert ChallengeWindowClosed(positionId);
        _requireTier2Model(modelHash);
        if (publicInputs.length <= INSTANCE_LABEL || _proofFeatureHash(publicInputs) != st.featureSnapshot) {
            revert ProofNotForPosition(positionId);
        }
        if (publicInputs[INSTANCE_LABEL] != HIGH_RISK) revert ChallengeDidNotContradictClaim(positionId);
        if (!_verify(proof, publicInputs)) revert InvalidZkProof(positionId);

        st.challenged = true;
        st.bond = 0;
        if (!st.liquidationFinal) st.decided = false; // the claim was false: re-open for Tier 2
        pendingWithdrawals[msg.sender] += bond;

        emit DecisionChallenged(positionId, msg.sender, bond);
    }

    /// @notice After an unchallenged window, credit the bond to its claimant.
    function reclaimBond(uint256 positionId) external {
        PositionState storage st = _state[positionId];
        if (block.timestamp <= st.challengeDeadline) revert ChallengeWindowStillOpen(positionId);
        if (st.challenged) revert AlreadyChallenged(positionId);
        uint256 bond = st.bond;
        if (bond == 0) revert NoBondToReclaim(positionId);
        st.bond = 0;
        address originalClaimant = st.claimant;
        pendingWithdrawals[originalClaimant] += bond;
        emit BondReclaimed(positionId, originalClaimant, bond);
    }

    /// @notice Pre-fund bonds: later Tier 0/1 claims sent without ETH draw
    ///         MIN_BOND each from this balance. Withdrawable at any time.
    function deposit() external payable {
        pendingWithdrawals[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Pull payment: a hostile recipient can only strand its own funds.
    function withdraw() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[msg.sender] = 0;
        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "withdrawal transfer failed");
        emit Withdrawn(msg.sender, amount);
    }
}
