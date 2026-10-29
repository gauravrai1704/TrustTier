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
///         liquidation boundary, and hands approved liquidations to the
///         lending protocol's executor.
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
///   - Tier 0 (heuristic, bonded):   a "safe" claim, allowed only if delta > 15%.
///   - Tier 1 (commitment, bonded):  a "safe" claim with a salted commitment
///     to the registered model's score, allowed only if delta > 5%. The
///     claimant must open the commitment inside the window; a score that
///     says high risk, or no opening at all, forfeits the bond.
///   - Tier 2 (zk-SNARK):            always allowed; APPROVES A LIQUIDATION
///     only if the proof's five public inputs equal the features read now
///     (or a recent anchor the position has not improved on) and its label
///     is HIGH_RISK. The approval is executed by `liquidator` within
///     APPROVAL_TTL, or expires.
///   A Tier 0/1 claim snapshots the features it was made on. During the
///   1-hour challenge window anyone may slash its bond with a Tier-2 proof
///   whose public inputs equal that snapshot and whose label is HIGH_RISK, so
///   an honest claimant is never punished for prices that moved afterwards.
///
/// INCENTIVES
///   - The bond scales with the base fee (`requiredBond`), so slashing a
///     false claim always pays for the challenge transaction.
///   - A protocol-funded reward pool pays `claimReward` for an honest
///     (unchallenged) claim, at most once per position per REWARD_COOLDOWN.
///   - Challenges can be committed first (`commitChallenge`): once a commit
///     exists for a claim, only committed challengers can slash it, so a
///     challenge seen in the mempool cannot be copied.
///
/// LIFECYCLE
///   - A Tier-2 approval blocks other decisions until it is executed by the
///     liquidator or APPROVAL_TTL passes.
///   - A Tier 0/1 claim blocks new cheap decisions while its window is open.
///   - A successful challenge re-opens the position at once.
///   - After an unchallenged window, the next decision re-opens the position
///     and settles the previous claimant's bond.
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

    /// @notice The only address that may execute (consume) Tier-2 approvals.
    address public liquidator;

    /// @notice Optional Chainlink L2 sequencer uptime feed (zero on L1).
    address public sequencerUptimeFeed;

    /// @notice Protocol-funded rewards for honest cheap claims.
    uint256 public rewardPool;
    uint256 public claimReward;

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
    /// @dev Gas the bond must cover at the claim's base fee: about twice a
    ///      measured challenge (676k gas), so a false claim is always worth
    ///      slashing even if the base fee doubles inside the window.
    uint256 public constant BOND_GAS_COVER = 1_500_000;
    uint256 public constant CHALLENGE_WINDOW = 1 hours;
    uint256 public constant APPROVAL_TTL = 30 minutes;
    uint256 public constant ANCHOR_TTL = 10 minutes;
    uint256 public constant REWARD_COOLDOWN = 1 days;
    uint256 public constant SEQUENCER_GRACE = 1 hours;
    /// @dev Tier-1 scores are committed as P(high) * 1e6 (router/commitment.py).
    int256 public constant HIGH_RISK_SCORE = 500_000;

    // --- per-position state (every key scoped to positionId or an account) --
    /// @dev Packed into three storage slots so a bonded claim writes three
    ///      fresh slots instead of nine.
    struct PositionState {
        address claimant;          // slot 0
        uint96 bond;               // slot 0
        uint64 challengeDeadline;  // slot 1
        uint64 approvedAt;         // slot 1: time of the open Tier-2 approval
        uint64 lastRewardAt;       // slot 1: last claimReward paid for this position
        bool decided;              // slot 1: a decision is on record
        bool liquidationFinal;     // slot 1: an open (unexecuted, unexpired) Tier-2 approval
        bool challenged;           // slot 1
        bool isCommitment;         // slot 1: the open claim is Tier 1
        bool revealed;             // slot 1: its commitment was opened
        bytes32 featureSnapshot;   // slot 2: keccak256 of the claim's five features
    }

    /// @dev Features fixed at a moment, so a proof that takes longer than a
    ///      feed update to generate is still usable while the position has
    ///      not become safer.
    struct Anchor {
        bytes32 featureHash;
        uint64 at;
        int64 deltaBps;
    }

    struct ChallengeCommit {
        bytes32 commitment;
        uint64 blockNumber;
    }

    mapping(uint256 => PositionState) internal _state;
    mapping(uint256 => bytes32) public tier1Commitments;
    mapping(address => uint256) public pendingWithdrawals;
    mapping(uint256 => Anchor) public anchors;
    mapping(uint256 => mapping(address => ChallengeCommit)) public challengeCommits;
    /// @notice Timestamp of the latest challenge commit per position.
    mapping(uint256 => uint256) public lastChallengeCommitAt;

    /// @notice A Tier 0/1 claim that the position is NOT liquidation-worthy.
    event SafeClaimRecorded(uint256 indexed positionId, Tier indexed tier, bytes32 modelHash, address indexed claimant, uint256 bond);
    /// @notice A Tier-2 proof approved liquidating the position.
    event LiquidationApproved(uint256 indexed positionId, Tier indexed tier, bytes32 modelHash);
    event ApprovalConsumed(uint256 indexed positionId, address indexed liquidator);
    event ApprovalExpired(uint256 indexed positionId);
    event FeaturesSnapshotted(uint256 indexed positionId, uint256[5] features, int256 deltaBps);
    event FeaturesAnchored(uint256 indexed positionId, uint256[5] features, int256 deltaBps);
    event PositionReopened(uint256 indexed positionId, uint256 bondCredited);
    event ClaimSuperseded(uint256 indexed positionId, address indexed claimant);
    event CommitmentRevealed(uint256 indexed positionId, int256 score);
    event CommitmentContradicted(uint256 indexed positionId, int256 score, uint256 bondForfeited);
    event BondForfeited(uint256 indexed positionId, address indexed claimant, uint256 bond);
    event ChallengeCommitted(uint256 indexed positionId, address indexed challenger);
    event Tier2VerifierUpdated(address indexed newVerifier, bytes32 indexed modelHash);
    event PositionSourceUpdated(address indexed newSource);
    event LiquidatorUpdated(address indexed newLiquidator);
    event SequencerFeedUpdated(address indexed feed);
    event MaxFeedAgesUpdated(uint256 maxPriceAge, uint256 maxVolatilityAge);
    event ClaimRewardUpdated(uint256 reward);
    event RewardsFunded(address indexed from, uint256 amount);
    event RewardPaid(uint256 indexed positionId, address indexed claimant, uint256 amount);
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
    error SequencerDown();
    error BadMomentumRound(uint80 roundId);
    error InsufficientBond(uint256 positionId, uint256 required, uint256 sent);
    error NotChallengeable(uint256 positionId);
    error ChallengeWindowClosed(uint256 positionId);
    error ChallengeWindowStillOpen(uint256 positionId);
    error AlreadyChallenged(uint256 positionId);
    error ChallengeDidNotContradictClaim(uint256 positionId);
    error ChallengeMustBeCommitted(uint256 positionId);
    error BadChallengeCommit(uint256 positionId);
    error NotACommitmentClaim(uint256 positionId);
    error AlreadyRevealed(uint256 positionId);
    error BadReveal(uint256 positionId);
    error NoBondToReclaim(uint256 positionId);
    error NothingToWithdraw();
    error BondTooLarge();
    error NotLiquidator();
    error NoOpenApproval(uint256 positionId);

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

    /// @notice Whether an unexecuted Tier-2 approval is open and unexpired.
    function approvalOpen(uint256 positionId) public view returns (bool) {
        PositionState storage st = _state[positionId];
        return st.liquidationFinal && block.timestamp <= uint256(st.approvedAt) + APPROVAL_TTL;
    }

    function approvedAt(uint256 positionId) external view returns (uint256) {
        return _state[positionId].approvedAt;
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

    function commitmentRevealed(uint256 positionId) external view returns (bool) {
        return _state[positionId].revealed;
    }

    /// @notice Bond a Tier 0/1 claim must post in this block.
    function requiredBond() public view returns (uint256) {
        uint256 gasCover = BOND_GAS_COVER * block.basefee;
        return gasCover > MIN_BOND ? gasCover : MIN_BOND;
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

    function setLiquidator(address _liquidator) external onlyOwner {
        liquidator = _liquidator;
        emit LiquidatorUpdated(_liquidator);
    }

    function setSequencerUptimeFeed(address feed) external onlyOwner {
        sequencerUptimeFeed = feed;
        emit SequencerFeedUpdated(feed);
    }

    function setMaxFeedAges(uint256 _maxPriceAge, uint256 _maxVolatilityAge) external onlyOwner {
        maxPriceAge = _maxPriceAge;
        maxVolatilityAge = _maxVolatilityAge;
        emit MaxFeedAgesUpdated(_maxPriceAge, _maxVolatilityAge);
    }

    function setClaimReward(uint256 reward) external onlyOwner {
        claimReward = reward;
        emit ClaimRewardUpdated(reward);
    }

    /// @notice Anyone (typically the lending protocol) can fund claim rewards.
    function fundRewards() external payable {
        rewardPool += msg.value;
        emit RewardsFunded(msg.sender, msg.value);
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
        _requireSequencerUp();
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

    /// @dev On an L2, prices are not trustworthy while the sequencer is down
    ///      or has just restarted (Chainlink's recommended grace period).
    function _requireSequencerUp() internal view {
        address feed = sequencerUptimeFeed;
        if (feed == address(0)) return;
        (, int256 status, uint256 startedAt, , ) = AggregatorV3Interface(feed).latestRoundData();
        if (status != 0 || block.timestamp < startedAt + SEQUENCER_GRACE) revert SequencerDown();
    }

    function _freshAnswer(address feed, uint256 maxAge) internal view returns (uint256 answer, uint8 decimals) {
        (, int256 a, , uint256 updatedAt, ) = AggregatorV3Interface(feed).latestRoundData();
        if (a <= 0) revert InvalidFeedAnswer(feed);
        if (updatedAt + maxAge < block.timestamp) revert StaleFeed(feed, updatedAt);
        return (uint256(a), AggregatorV3Interface(feed).decimals());
    }

    /// @dev The round in effect 24 hours ago: it was updated at or before that
    ///      moment, and the next round (if any) after it. Chainlink proxies
    ///      number rounds (phaseId << 64 | aggregatorRoundId), so the last
    ///      round of a phase has no `roundId + 1`; such a round is accepted
    ///      only if it was updated within one heartbeat (maxPriceAge) before
    ///      the target, which an older, superseded round cannot be.
    function _priceAt24hAgo(address feed, uint80 roundId) internal view returns (uint256) {
        uint256 target = block.timestamp - MOMENTUM_WINDOW;
        AggregatorV3Interface f = AggregatorV3Interface(feed);
        (, int256 answer, , uint256 updatedAt, ) = f.getRoundData(roundId);
        if (answer <= 0 || updatedAt == 0 || updatedAt > target) revert BadMomentumRound(roundId);
        (uint80 latestId, , , , ) = f.latestRoundData();
        if (roundId != latestId) {
            try f.getRoundData(roundId + 1) returns (uint80, int256, uint256, uint256 nextUpdatedAt, uint80) {
                if (nextUpdatedAt != 0) {
                    if (nextUpdatedAt <= target) revert BadMomentumRound(roundId);
                    return uint256(answer);
                }
            } catch {}
            if (updatedAt + maxPriceAge < target) revert BadMomentumRound(roundId);
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

    /// @notice Fix a position's current features for ANCHOR_TTL. A Tier-2
    ///         proof on anchored features is accepted while the position has
    ///         not become safer than at the anchor, so a feed update during
    ///         the ~16 s of proving does not force a re-proof in a crash.
    ///         Permissionless: it stores only on-chain data.
    function anchorFeatures(uint256 positionId, uint80 pastRoundId) external {
        (uint256[5] memory q, int256 deltaBps) = currentFeatures(positionId, pastRoundId);
        anchors[positionId] = Anchor(_featureHash(q), uint64(block.timestamp), int64(deltaBps));
        emit FeaturesAnchored(positionId, q, deltaBps);
    }

    // =====================================================================
    // Decision lifecycle helpers
    // =====================================================================

    /// @dev Admits a new decision for `positionId`. An open Tier-2 approval
    ///      blocks everything until it is executed or expires. A previous
    ///      Tier 0/1 claim whose window has closed is settled (its bond
    ///      credited, or forfeited if it was an unopened commitment). While a
    ///      claim's window is open, only a Tier-2 liquidation may proceed: a
    ///      proof that the position is high risk NOW supersedes a cheap claim,
    ///      so a claim cannot delay a needed liquidation. The superseded claim
    ///      keeps its bond, snapshot and window - it can still be challenged
    ///      (if it was false when made) or reclaimed (if not). Runs before
    ///      any external call.
    function _beginDecision(uint256 positionId, bool tier2) internal {
        PositionState storage st = _state[positionId];
        if (st.liquidationFinal) {
            if (block.timestamp <= uint256(st.approvedAt) + APPROVAL_TTL) revert PositionAlreadyFinalized(positionId);
            st.liquidationFinal = false;
            st.approvedAt = 0;
            emit ApprovalExpired(positionId);
        }
        if (st.decided) {
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
        uint256 credited = st.bond != 0 ? _settleBond(positionId, st) : 0;
        delete tier1Commitments[positionId];
        emit PositionReopened(positionId, credited);
    }

    /// @dev Settles an unchallenged claim after its window: an honest claim's
    ///      bond goes back to its claimant (plus `claimReward` when the pool
    ///      can pay it and the position's cooldown has passed); a Tier-1
    ///      claim whose commitment was never opened forfeits to the pool.
    ///      Returns the amount credited to the claimant.
    function _settleBond(uint256 positionId, PositionState storage st) internal returns (uint256 credited) {
        uint256 bond = st.bond;
        address who = st.claimant;
        st.bond = 0;
        if (st.isCommitment && !st.revealed) {
            rewardPool += bond;
            emit BondForfeited(positionId, who, bond);
            return 0;
        }
        credited = bond;
        uint256 reward = claimReward;
        if (reward != 0 && rewardPool >= reward && block.timestamp >= uint256(st.lastRewardAt) + REWARD_COOLDOWN) {
            rewardPool -= reward;
            st.lastRewardAt = uint64(block.timestamp);
            credited += reward;
            emit RewardPaid(positionId, who, reward);
        }
        pendingWithdrawals[who] += credited;
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
    function _openBondedClaim(uint256 positionId, uint256[5] memory q, int256 deltaBps, bool commitment)
        internal
        returns (bytes32 snap, uint256 bond)
    {
        uint256 required = requiredBond();
        bond = msg.value;
        if (bond == 0) {
            uint256 available = pendingWithdrawals[msg.sender];
            if (available < required) revert InsufficientBond(positionId, required, available);
            pendingWithdrawals[msg.sender] = available - required;
            bond = required;
        } else if (bond < required) {
            revert InsufficientBond(positionId, required, bond);
        }
        if (bond > type(uint96).max) revert BondTooLarge();
        PositionState storage st = _state[positionId];
        st.claimant = msg.sender;
        st.bond = uint96(bond);
        st.challengeDeadline = uint64(block.timestamp + CHALLENGE_WINDOW);
        st.challenged = false;
        st.isCommitment = commitment;
        st.revealed = false;
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
        (bytes32 snap, uint256 bond) = _openBondedClaim(positionId, q, deltaBps, false);
        auditLog.logDecision(positionId, TierAuditLog.Tier.Heuristic, bytes32(0), snap);
        emit SafeClaimRecorded(positionId, Tier.Heuristic, bytes32(0), msg.sender, bond);
    }

    /// @notice Tier 1: a bonded, salted commitment to the registered model's
    ///         score on the snapshotted features. Allowed only if delta > 5%
    ///         on-chain; the commitment must be opened (`revealCommitment`)
    ///         before the window closes or the bond is forfeited.
    /// @param commitmentHash keccak256(abi.encode(uint256[] q, int256 score1e6, bytes32 salt))
    function decideCommitment(uint256 positionId, uint80 pastRoundId, bytes32 modelHash, bytes32 commitmentHash)
        external
        payable
    {
        _beginDecision(positionId, false);
        if (!modelRegistry.isAuthorized(modelHash)) revert ModelNotAuthorized(modelHash);
        if (commitmentHash == bytes32(0)) revert CommitmentRequired();
        (uint256[5] memory q, int256 deltaBps) = currentFeatures(positionId, pastRoundId);
        if (deltaBps <= TIER1_MIN_DELTA_BPS) revert TierNotAllowed(positionId, Tier.Commitment, deltaBps);
        (, uint256 bond) = _openBondedClaim(positionId, q, deltaBps, true);
        tier1Commitments[positionId] = commitmentHash;
        auditLog.logDecision(positionId, TierAuditLog.Tier.Commitment, modelHash, commitmentHash);
        emit SafeClaimRecorded(positionId, Tier.Commitment, modelHash, msg.sender, bond);
    }

    /// @notice Open a Tier-1 commitment inside its window. The features must
    ///         be the snapshot the claim was made on. A committed score at or
    ///         above HIGH_RISK_SCORE contradicts the claim itself: the bond is
    ///         forfeited to the reward pool and the position re-opens.
    function revealCommitment(uint256 positionId, uint256[] calldata q, int256 score, bytes32 salt) external {
        PositionState storage st = _state[positionId];
        if (!st.isCommitment || st.bond == 0) revert NotACommitmentClaim(positionId);
        if (st.revealed) revert AlreadyRevealed(positionId);
        if (block.timestamp > st.challengeDeadline) revert ChallengeWindowClosed(positionId);
        if (q.length != N_FEATURES || keccak256(abi.encode(q, score, salt)) != tier1Commitments[positionId]) {
            revert BadReveal(positionId);
        }
        if (_proofFeatureHash(q) != st.featureSnapshot) revert BadReveal(positionId);
        st.revealed = true;
        if (score >= HIGH_RISK_SCORE) {
            uint256 bond = st.bond;
            st.bond = 0;
            st.challenged = true;
            if (!st.liquidationFinal) st.decided = false;
            rewardPool += bond;
            emit CommitmentContradicted(positionId, score, bond);
        } else {
            emit CommitmentRevealed(positionId, score);
        }
    }

    /// @notice Tier 2: approve the liquidation with a zk-SNARK showing that the
    ///         registered model, run on this position's on-chain features (as
    ///         they are now, or as anchored within ANCHOR_TTL if the position
    ///         has not become safer since), outputs HIGH_RISK.
    function decideZkProof(
        uint256 positionId,
        uint80 pastRoundId,
        bytes32 modelHash,
        bytes calldata proof,
        uint256[] calldata publicInputs
    ) external {
        _beginDecision(positionId, true);
        _requireTier2Model(modelHash);
        (uint256[5] memory q, int256 deltaBps) = currentFeatures(positionId, pastRoundId);
        if (publicInputs.length <= INSTANCE_LABEL) revert ProofNotForPosition(positionId);
        if (!_inputsMatch(publicInputs, q)) {
            Anchor storage a = anchors[positionId];
            if (
                a.at == 0 || block.timestamp > uint256(a.at) + ANCHOR_TTL || deltaBps > int256(a.deltaBps)
                    || _proofFeatureHash(publicInputs) != a.featureHash
            ) revert ProofNotForPosition(positionId);
        }
        if (publicInputs[INSTANCE_LABEL] != HIGH_RISK) revert ProofDoesNotShowHighRisk(positionId);
        if (!_verify(proof, publicInputs)) revert InvalidZkProof(positionId);
        PositionState storage st = _state[positionId];
        st.liquidationFinal = true;
        st.approvedAt = uint64(block.timestamp);

        bytes32 proofHash = keccak256(proof);
        auditLog.logDecision(positionId, TierAuditLog.Tier.ZkProof, modelHash, proofHash);
        emit LiquidationApproved(positionId, Tier.ZkProof, modelHash);
    }

    function _inputsMatch(uint256[] calldata publicInputs, uint256[5] memory q) internal pure returns (bool) {
        for (uint256 i = 0; i < N_FEATURES; i++) {
            if (publicInputs[i] != q[i]) return false;
        }
        return true;
    }

    /// @notice Called by the lending protocol's liquidator when it executes
    ///         an approved liquidation. Closes the approval, so the position
    ///         (now partly repaid) can be decided again.
    function consumeApproval(uint256 positionId) external {
        if (msg.sender != liquidator) revert NotLiquidator();
        if (!approvalOpen(positionId)) revert NoOpenApproval(positionId);
        PositionState storage st = _state[positionId];
        st.liquidationFinal = false;
        st.approvedAt = 0;
        emit ApprovalConsumed(positionId, msg.sender);
    }

    // =====================================================================
    // Bonded challenge window
    // =====================================================================

    /// @notice Commit to a challenge before revealing its proof:
    ///         commitment = keccak256(abi.encode(challenger, positionId,
    ///         featureSnapshot, keccak256(proof))). Once any commit exists for
    ///         a claim, `challengeDecision` is closed for that claim and only
    ///         `revealChallenge` (by a committer, a block later) can slash it,
    ///         so a proof copied from the mempool is worthless.
    function commitChallenge(uint256 positionId, bytes32 commitment) external {
        PositionState storage st = _state[positionId];
        if (st.bond == 0 || st.challenged) revert NotChallengeable(positionId);
        if (block.timestamp > st.challengeDeadline) revert ChallengeWindowClosed(positionId);
        challengeCommits[positionId][msg.sender] = ChallengeCommit(commitment, uint64(block.number));
        lastChallengeCommitAt[positionId] = block.timestamp;
        emit ChallengeCommitted(positionId, msg.sender);
    }

    /// @notice Slash a Tier 0/1 claim with a Tier-2 proof that the position,
    ///         with the features snapshotted at the claim, was HIGH_RISK.
    ///         Closed once someone has committed a challenge to this claim.
    function challengeDecision(
        uint256 positionId,
        bytes32 modelHash,
        bytes calldata proof,
        uint256[] calldata publicInputs
    ) external {
        PositionState storage st = _state[positionId];
        if (lastChallengeCommitAt[positionId] + CHALLENGE_WINDOW >= st.challengeDeadline && st.challengeDeadline != 0) {
            revert ChallengeMustBeCommitted(positionId);
        }
        _slash(positionId, st, modelHash, proof, publicInputs);
    }

    /// @notice Reveal a committed challenge (at least one block after the commit).
    function revealChallenge(
        uint256 positionId,
        bytes32 modelHash,
        bytes calldata proof,
        uint256[] calldata publicInputs
    ) external {
        PositionState storage st = _state[positionId];
        ChallengeCommit memory c = challengeCommits[positionId][msg.sender];
        bytes32 expected = keccak256(abi.encode(msg.sender, positionId, st.featureSnapshot, keccak256(proof)));
        if (c.blockNumber == 0 || c.blockNumber >= block.number || c.commitment != expected) {
            revert BadChallengeCommit(positionId);
        }
        delete challengeCommits[positionId][msg.sender];
        _slash(positionId, st, modelHash, proof, publicInputs);
    }

    function _slash(
        uint256 positionId,
        PositionState storage st,
        bytes32 modelHash,
        bytes calldata proof,
        uint256[] calldata publicInputs
    ) internal {
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

    /// @notice After an unchallenged window, settle the bond: credited to its
    ///         claimant (plus any claim reward), or forfeited to the reward
    ///         pool for a Tier-1 commitment that was never opened.
    function reclaimBond(uint256 positionId) external {
        PositionState storage st = _state[positionId];
        if (block.timestamp <= st.challengeDeadline) revert ChallengeWindowStillOpen(positionId);
        if (st.challenged) revert AlreadyChallenged(positionId);
        if (st.bond == 0) revert NoBondToReclaim(positionId);
        uint256 bond = st.bond;
        address originalClaimant = st.claimant;
        uint256 credited = _settleBond(positionId, st);
        if (credited != 0) emit BondReclaimed(positionId, originalClaimant, bond);
    }

    /// @notice Pre-fund bonds: later Tier 0/1 claims sent without ETH draw
    ///         `requiredBond()` each from this balance. Withdrawable at any time.
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
