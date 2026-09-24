"""
Computes the Tier-1 commitment hash: a keccak256 binding of a position's
model input features and the resulting risk score, posted on-chain in place
of a full zk-SNARK proof.

This is intentionally a much weaker guarantee than Tier 2: the chain only
learns "someone claims these inputs produced this output", not that the
computation was actually performed correctly by the registered model. That
gap is exactly what the periodic probabilistic audit (re-running the
inference off-chain and comparing against the on-chain commitment) is meant
to catch after the fact - a mechanism not yet implemented in this phase,
noted here as follow-on work for the Week 6 evaluation phase.
"""

from eth_abi import encode
from web3 import Web3

from risk_model.features import features_to_vector

# Fixed-point scale used when encoding floats for on-chain hashing/ABI
# encoding, since Solidity has no native float type. 1e6 gives 6 decimal
# digits of precision, comfortably more than these features need.
FIXED_POINT_SCALE = 1_000_000


def _to_fixed_point(value: float) -> int:
    return int(round(value * FIXED_POINT_SCALE))


def compute_commitment_hash(features: dict, risk_score: float) -> str:
    """keccak256(abi.encode(feature values as fixed-point ints, risk score as fixed-point int))."""
    feature_vector = features_to_vector(features)
    scaled_features = [_to_fixed_point(v) for v in feature_vector]
    scaled_score = _to_fixed_point(risk_score)

    encoded = encode(
        ["int256[]", "int256"],
        [scaled_features, scaled_score],
    )
    return Web3.keccak(encoded).hex()
