// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev The one engine function the baseline needs: the same verified,
///      quantized features TrustTier's tiers and circuit use.
interface IFeatureSource {
    function currentFeatures(uint256 positionId, uint80 pastRoundId)
        external
        view
        returns (uint256[5] memory q, int256 deltaBps);
}

/// @title OnChainMLPBaseline
/// @notice Baseline for the evaluation, after Alhaidari, Palanisamy and
///         Krishnamurthy, "On-Chain Decentralized Learning and Cost-Effective
///         Inference for DeFi Attack Mitigation" (AFT 2025): the model runs
///         *inside* the contract on fixed-point integer weights held in
///         contract storage, which governance sets and updates (their
///         "fully on-chain inference" tier with an L1 parameter update).
///
///         To compare like with like it runs TrustTier's own deployed model
///         (5 -> hidden -> 1 ReLU MLP, decision = logit > 0, as the ONNX graph's
///         argmax over the sigmoid) on TrustTier's own verified features, read
///         from LiquidationEngine.currentFeatures. Every decision runs the model:
///         no tiers, no proofs, and the weights are public.
///
///         Fixed point: weights scaled by SCALE = 1e12 (the scale at which the
///         baseline paper reports bit-exact agreement), inputs q / 1024.
contract OnChainMLPBaseline {
    int256 public constant SCALE = 1e12;
    uint256 internal constant Q_ONE = 1024;

    address public owner;
    IFeatureSource public immutable engine;

    /// Layer widths, e.g. [5, 8, 1]; params are, per layer, the weight matrix
    /// row by row (input-major: w[i][j] for input i, unit j) then the biases.
    uint16[] public layers;
    int256[] public params;

    mapping(uint256 => uint64) public approvedAt;

    event ParamsUpdated(uint256 nParams);
    event Classified(uint256 indexed positionId, bool highRisk, int256 logit);

    error NotOwner();
    error BadShape();

    constructor(address engine_) {
        owner = msg.sender;
        engine = IFeatureSource(engine_);
    }

    /// Set or replace the model (their "L1 Set/Update Params" step).
    function setParams(uint16[] calldata layers_, int256[] calldata params_) external {
        if (msg.sender != owner) revert NotOwner();
        uint256 n = 0;
        for (uint256 l = 0; l + 1 < layers_.length; l++) n += uint256(layers_[l]) * layers_[l + 1] + layers_[l + 1];
        if (layers_.length < 2 || layers_[layers_.length - 1] != 1 || n != params_.length) revert BadShape();
        layers = layers_;
        params = params_;
        emit ParamsUpdated(n);
    }

    /// Large models: since Osaka a transaction may use at most 2^24 gas
    /// (EIP-7825), so weights beyond a few hundred go up in chunks.
    function beginParams(uint16[] calldata layers_) external {
        if (msg.sender != owner) revert NotOwner();
        if (layers_.length < 2 || layers_[layers_.length - 1] != 1) revert BadShape();
        layers = layers_;
        delete params;
    }

    function appendParams(int256[] calldata chunk) external {
        if (msg.sender != owner) revert NotOwner();
        for (uint256 i = 0; i < chunk.length; i++) params.push(chunk[i]);
        emit ParamsUpdated(params.length);
    }

    /// The model on a quantized feature vector q (each in [0, 1024]).
    function classify(uint256[] memory q) public view returns (bool highRisk, int256 logit) {
        uint16[] memory ls = layers;
        int256[] memory a = new int256[](q.length);
        for (uint256 i = 0; i < q.length; i++) a[i] = int256(q[i]) * SCALE / int256(Q_ONE);
        uint256 p = 0;
        for (uint256 l = 0; l + 1 < ls.length; l++) {
            uint256 nIn = ls[l];
            uint256 nOut = ls[l + 1];
            int256[] memory z = new int256[](nOut);
            for (uint256 i = 0; i < nIn; i++) {
                int256 ai = a[i];
                for (uint256 j = 0; j < nOut; j++) z[j] += params[p + i * nOut + j] * ai / SCALE;
            }
            p += nIn * nOut;
            bool hidden = l + 2 < ls.length;
            for (uint256 j = 0; j < nOut; j++) {
                z[j] += params[p + j];
                if (hidden && z[j] < 0) z[j] = 0; // ReLU
            }
            p += nOut;
            a = z;
        }
        logit = a[0];
        highRisk = logit > 0;
    }

    /// Inference as a state-changing transaction on caller-supplied features
    /// (their "L1 inference gas": classifyOnChain).
    function classifyOnChain(uint256[] calldata q) external returns (bool highRisk) {
        int256 logit;
        (highRisk, logit) = classify(q);
        emit Classified(0, highRisk, logit);
    }

    /// A full decision: read the position's verified features, run the model,
    /// and record an approval if it says high risk.
    function decide(uint256 positionId, uint80 pastRoundId) external returns (bool highRisk) {
        (uint256[5] memory q5, ) = engine.currentFeatures(positionId, pastRoundId);
        uint256[] memory q = new uint256[](5);
        for (uint256 i = 0; i < 5; i++) q[i] = q5[i];
        int256 logit;
        (highRisk, logit) = classify(q);
        if (highRisk) approvedAt[positionId] = uint64(block.timestamp);
        emit Classified(positionId, highRisk, logit);
    }
}
