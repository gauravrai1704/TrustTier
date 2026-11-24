// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LiquidationEngine} from "../LiquidationEngine.sol";
import {ModelRegistry} from "../ModelRegistry.sol";
import {TierAuditLog} from "../TierAuditLog.sol";
import {MockLendingPool} from "../sources/MockLendingPool.sol";
import {MockV3Aggregator} from "../mocks/MockV3Aggregator.sol";
import {MockTier2Verifier} from "../mocks/MockTier2Verifier.sol";
import {TrustTierLiquidator} from "../consumers/TrustTierLiquidator.sol";

/// @notice A participant: forwards calls (and ETH) so the engine sees
///         several distinct claimants, challengers and liquidators.
contract Actor {
    address internal immutable owner;

    constructor() payable {
        owner = msg.sender;
    }

    function exec(address target, uint256 value, bytes calldata data) external returns (bool ok, bytes memory ret) {
        require(msg.sender == owner, "not the harness");
        (ok, ret) = target.call{value: value}(data);
    }

    receive() external payable {}
}

/// @title EngineInvariants
/// @notice Echidna property harness for LiquidationEngine + TrustTierLiquidator
///         + MockLendingPool. Echidna calls the `act_*` functions in random
///         order with random arguments (and random time jumps); after every
///         call it checks the `echidna_*` properties, which must stay true.
///
///         echidna . --contract EngineInvariants --config echidna.yaml
contract EngineInvariants {
    uint256 internal constant N_ACTORS = 3;
    uint256 internal constant MAX_POSITIONS = 4;
    int256 internal constant P0 = 2000e8;
    bytes32 internal constant MODEL = keccak256("risk-model");
    uint256 internal constant WEIGHTS = 0x09c7c71239aa21b78a852b05f2a8a1cba3c955f0cfab2221e6263b04a9c6d609;
    bytes internal constant PROOF = hex"01";

    MockV3Aggregator public priceFeed;
    MockV3Aggregator public volFeed;
    MockLendingPool public pool;
    ModelRegistry public registry;
    TierAuditLog public auditLog;
    MockTier2Verifier public verifier;
    LiquidationEngine public engine;
    TrustTierLiquidator public liquidator;
    Actor[N_ACTORS] public actors;

    uint256[] public positions;
    // Ghost state the properties are checked against.
    mapping(uint256 => uint256[5]) internal snapshotQ;   // features of the latest claim
    mapping(uint256 => bytes32) internal salts;
    mapping(uint256 => int256) internal scores;
    mapping(uint256 => bool) internal approvalOutstanding;
    mapping(uint256 => uint256) internal approvalTime;

    // Violations: each set flag is a broken promise.
    bool public tierBandViolated;
    bool public acceptedWrongWeights;
    bool public tier2WithoutValidHighRiskProof;
    bool public slashedWithoutValidProofOnSnapshot;
    bool public liquidatedWithoutFreshApproval;

    constructor() payable {
        priceFeed = new MockV3Aggregator(8, "COLL/USD", P0);
        volFeed = new MockV3Aggregator(8, "COLL vol", 35e8);
        // A price history: the round 25 h ago and the current one.
        priceFeed.setRoundTimestamp(1, block.timestamp - 25 hours);
        priceFeed.updateAnswer(P0);
        pool = new MockLendingPool();
        pool.addMarket(address(priceFeed), address(volFeed), 8000);
        registry = new ModelRegistry();
        auditLog = new TierAuditLog();
        verifier = new MockTier2Verifier();
        engine = new LiquidationEngine(address(registry), address(auditLog), address(verifier), MODEL, WEIGHTS, address(pool), 3 hours, 2 days);
        auditLog.authorizeLogger(address(engine));
        registry.registerModel(MODEL, "ipfs://model");
        liquidator = new TrustTierLiquidator(address(engine), address(pool));
        engine.setLiquidator(address(liquidator));
        pool.setLiquidator(address(liquidator));
        for (uint256 i = 0; i < N_ACTORS; i++) {
            actors[i] = new Actor{value: 100 ether}();
        }
    }

    receive() external payable {}

    // ------------------------------------------------------------------ helpers

    function _actor(uint256 seed) internal view returns (Actor) {
        return actors[seed % N_ACTORS];
    }

    function _pid(uint256 seed) internal view returns (uint256) {
        return positions.length == 0 ? 0 : positions[seed % positions.length];
    }

    /// @dev The price round in effect 24 h ago (rounds are contiguous here).
    function _pastRound() internal view returns (uint80 r) {
        uint256 target = block.timestamp - 24 hours;
        r = priceFeed.latestRound();
        while (r > 1) {
            (, , , uint256 at, ) = priceFeed.getRoundData(r);
            if (at <= target) break;
            r--;
        }
    }

    function _features(uint256 pid) internal view returns (bool ok, uint256[5] memory q, int256 delta) {
        try engine.currentFeatures(pid, _pastRound()) returns (uint256[5] memory q_, int256 d) {
            return (true, q_, d);
        } catch {
            return (false, q, 0);
        }
    }

    function _inputs(uint256[5] memory q, bool highRisk) internal pure returns (uint256[] memory a) {
        return _inputsW(q, highRisk, true);
    }

    /// Public inputs [weightsHash, q..., label, P(low), P(high)].
    function _inputsW(uint256[5] memory q, bool highRisk, bool rightWeights) internal pure returns (uint256[] memory a) {
        a = new uint256[](9);
        a[0] = rightWeights ? WEIGHTS : WEIGHTS ^ 1;
        for (uint256 i = 0; i < 5; i++) a[1 + i] = q[i];
        a[6] = highRisk ? 1 : 0;
        a[7] = highRisk ? 3 : 1021;
        a[8] = highRisk ? 1021 : 3;
    }

    /// Bands computed independently of the engine: Tier 0 needs delta > 5% + 0.3 sigma
    /// in [10%, 30%], Tier 1 needs delta > 1.5% + 0.1 sigma in [3%, 12%].
    function _bands(uint256 qVol) internal pure returns (int256 b0, int256 b1) {
        int256 s = int256(qVol * 10_000 / 1024);
        b0 = 500 + (s * 3) / 10;
        b0 = b0 < 1000 ? int256(1000) : (b0 > 3000 ? int256(3000) : b0);
        b1 = 150 + s / 10;
        b1 = b1 < 300 ? int256(300) : (b1 > 1200 ? int256(1200) : b1);
    }

    function _call(Actor who, uint256 value, bytes memory data) internal returns (bool ok) {
        (ok, ) = who.exec(address(engine), value, data);
    }

    // ------------------------------------------------------------------ market

    function act_openPosition(uint256 ltvSeed, uint16 ageDays, uint8 topupDays) public {
        if (positions.length >= MAX_POSITIONS) return;
        uint256 pid = positions.length + 1;
        (, int256 price, , , ) = priceFeed.latestRoundData();
        uint256 ltvBps = 2000 + (ltvSeed % 10_001);           // LTV 0.20 - 1.20
        pool.openPosition(pid, 0, 1e18, (uint256(price) * ltvBps) / 10_000);
        uint256 age = uint256(ageDays) % 2000;
        pool.setTimestamps(pid, block.timestamp - age * 1 days, block.timestamp - (uint256(topupDays) % 90) * 1 days);
        positions.push(pid);
    }

    function act_movePrice(uint256 seed) public {
        int256 p = int256(1000e8 + (seed % 2000e8));          // 1,000 - 3,000
        priceFeed.updateAnswer(p);
    }

    function act_refreshFeeds(uint8 volSeed) public {
        (, int256 p, , , ) = priceFeed.latestRoundData();
        priceFeed.updateAnswer(p);
        volFeed.updateAnswer(int256(5 + uint256(volSeed) % 96) * 1e8);   // 5% - 100% volatility
    }

    function act_setVerifier(bool valid) public {
        verifier.setShouldVerify(valid);
    }

    function act_fundRewards(uint64 amount) public {
        uint256 v = uint256(amount) % 1 ether;
        if (address(this).balance < v) return;
        engine.fundRewards{value: v}();
    }

    function act_setClaimReward(uint64 amount) public {
        engine.setClaimReward(uint256(amount) % 0.01 ether);
    }

    // ------------------------------------------------------------------ decisions

    function act_claimTier0(uint256 who, uint256 pidSeed, bool fromDeposit) public {
        uint256 pid = _pid(pidSeed);
        (bool ok, uint256[5] memory q, int256 delta) = _features(pid);
        if (!ok) return;
        uint256 bond = fromDeposit ? 0 : engine.requiredBond();
        if (_call(_actor(who), bond, abi.encodeCall(engine.decideHeuristic, (pid, _pastRound())))) {
            (int256 b0, ) = _bands(q[1]);
            if (delta <= b0) tierBandViolated = true;
            snapshotQ[pid] = q;
        }
    }

    function act_claimTier1(uint256 who, uint256 pidSeed, uint32 scoreSeed, bytes32 salt) public {
        uint256 pid = _pid(pidSeed);
        (bool ok, uint256[5] memory q, int256 delta) = _features(pid);
        if (!ok) return;
        int256 score = int256(uint256(scoreSeed) % 1_000_001);
        uint256[] memory qd = new uint256[](5);
        for (uint256 i = 0; i < 5; i++) qd[i] = q[i];
        bytes32 c = keccak256(abi.encode(qd, score, salt));
        if (_call(_actor(who), engine.requiredBond(), abi.encodeCall(engine.decideCommitment, (pid, _pastRound(), MODEL, c)))) {
            (, int256 b1) = _bands(q[1]);
            if (delta <= b1) tierBandViolated = true;
            snapshotQ[pid] = q;
            salts[pid] = salt;
            scores[pid] = score;
        }
    }

    function act_reveal(uint256 who, uint256 pidSeed, bool correct) public {
        uint256 pid = _pid(pidSeed);
        uint256[] memory qd = new uint256[](5);
        for (uint256 i = 0; i < 5; i++) qd[i] = snapshotQ[pid][i];
        _call(_actor(who), 0, abi.encodeCall(engine.revealCommitment,
            (pid, qd, scores[pid], correct ? salts[pid] : bytes32(uint256(salts[pid]) ^ 1))));
    }

    function act_anchor(uint256 who, uint256 pidSeed) public {
        uint256 pid = _pid(pidSeed);
        _call(_actor(who), 0, abi.encodeCall(engine.anchorFeatures, (pid, _pastRound())));
    }

    function act_decideTier2(uint256 who, uint256 pidSeed, bool highRisk, bool rightWeights) public {
        uint256 pid = _pid(pidSeed);
        (bool ok, uint256[5] memory q, ) = _features(pid);
        if (!ok) return;
        bool valid = verifier.shouldVerify();
        uint256[] memory ins = _inputsW(q, highRisk, rightWeights);
        bytes memory data = abi.encodeCall(engine.decideZkProof, (pid, _pastRound(), MODEL, PROOF, ins));
        if (_call(_actor(who), 0, data)) {
            if (!highRisk || !valid) tier2WithoutValidHighRiskProof = true;
            if (!rightWeights) acceptedWrongWeights = true;
            approvalOutstanding[pid] = true;
            approvalTime[pid] = block.timestamp;
        }
    }

    // ------------------------------------------------------------------ challenges

    function act_challenge(uint256 who, uint256 pidSeed, bool highRisk, bool onSnapshot, bool rightWeights) public {
        uint256 pid = _pid(pidSeed);
        uint256[5] memory q = snapshotQ[pid];
        if (!onSnapshot) q[0] = q[0] + 1;
        bool valid = verifier.shouldVerify();
        uint256[] memory ins = _inputsW(q, highRisk, rightWeights);
        bytes memory data = abi.encodeCall(engine.challengeDecision, (pid, MODEL, PROOF, ins));
        if (_call(_actor(who), 0, data)) {
            if (!highRisk || !valid || !onSnapshot) slashedWithoutValidProofOnSnapshot = true;
            if (!rightWeights) acceptedWrongWeights = true;
        }
    }

    function act_commitChallenge(uint256 who, uint256 pidSeed) public {
        uint256 pid = _pid(pidSeed);
        Actor a = _actor(who);
        bytes32 c = keccak256(abi.encode(address(a), pid, engine.featureSnapshot(pid), keccak256(PROOF)));
        _call(a, 0, abi.encodeCall(engine.commitChallenge, (pid, c)));
    }

    function act_revealChallenge(uint256 who, uint256 pidSeed, bool highRisk) public {
        uint256 pid = _pid(pidSeed);
        bool valid = verifier.shouldVerify();
        if (_call(_actor(who), 0, abi.encodeCall(engine.revealChallenge, (pid, MODEL, PROOF, _inputs(snapshotQ[pid], highRisk))))) {
            if (!highRisk || !valid) slashedWithoutValidProofOnSnapshot = true;
        }
    }

    // ------------------------------------------------------------------ settlement

    function act_reclaim(uint256 who, uint256 pidSeed) public {
        _call(_actor(who), 0, abi.encodeCall(engine.reclaimBond, (_pid(pidSeed))));
    }

    function act_liquidate(uint256 who, uint256 pidSeed) public {
        uint256 pid = _pid(pidSeed);
        (bool ok, ) = _actor(who).exec(address(liquidator), 0, abi.encodeCall(liquidator.liquidate, (pid)));
        if (ok) {
            if (!approvalOutstanding[pid] || block.timestamp > approvalTime[pid] + engine.APPROVAL_TTL()) {
                liquidatedWithoutFreshApproval = true;
            }
            approvalOutstanding[pid] = false;
        }
    }

    function act_deposit(uint256 who, uint64 amount) public {
        _call(_actor(who), uint256(amount) % 1 ether, abi.encodeCall(engine.deposit, ()));
    }

    function act_withdraw(uint256 who) public {
        _call(_actor(who), 0, abi.encodeCall(engine.withdraw, ()));
    }

    // ------------------------------------------------------------------ properties

    /// The engine holds exactly what it owes: pending payouts + open bonds + reward pool.
    function echidna_engine_is_exactly_solvent() public view returns (bool) {
        uint256 owed = engine.rewardPool();
        for (uint256 i = 0; i < N_ACTORS; i++) owed += engine.pendingWithdrawals(address(actors[i]));
        owed += engine.pendingWithdrawals(address(this));
        for (uint256 i = 0; i < positions.length; i++) owed += engine.bondOf(positions[i]);
        return address(engine).balance == owed;
    }

    function echidna_tier_bands_enforced() public view returns (bool) {
        return !tierBandViolated;
    }

    /// No Tier-2 approval or slash ever uses a proof made with other weights.
    function echidna_proofs_use_registered_weights() public view returns (bool) {
        return !acceptedWrongWeights;
    }

    function echidna_tier2_needs_valid_high_risk_proof() public view returns (bool) {
        return !tier2WithoutValidHighRiskProof;
    }

    function echidna_slash_needs_valid_proof_on_snapshot() public view returns (bool) {
        return !slashedWithoutValidProofOnSnapshot;
    }

    function echidna_liquidation_needs_fresh_unused_approval() public view returns (bool) {
        return !liquidatedWithoutFreshApproval;
    }

    /// An open bond always has a claimant; a challenged claim holds no bond.
    function echidna_bond_bookkeeping() public view returns (bool) {
        for (uint256 i = 0; i < positions.length; i++) {
            uint256 pid = positions[i];
            uint256 bond = engine.bondOf(pid);
            if (bond > 0 && engine.claimant(pid) == address(0)) return false;
            if (engine.challenged(pid) && bond > 0) return false;
        }
        return true;
    }
}
