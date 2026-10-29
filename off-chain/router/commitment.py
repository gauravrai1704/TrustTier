"""
Computes the Tier-1 commitment hash: a keccak256 binding of a position's
quantized on-chain features q (the same five integers the contract computes
and snapshots), the model's risk score, and a random 32-byte salt, posted
on-chain in place of a full zk-SNARK proof.

Why the salt: the features are public on-chain data, but the score is not,
and it is a 6-decimal number in [0, 1]; without a salt anyone could
brute-force the hash back into the score. A random salt makes the hash hiding; the router keeps the salt,
and revealing it later lets an auditor recompute the hash and check the
claim (see `verify_commitment`).

This is intentionally a much weaker guarantee than Tier 2: the chain only
learns "someone claims these inputs produced this output", not that the
computation was actually performed correctly by the registered model. The
bonded challenge window is what makes a false Tier-1 claim costly.
"""

import os

from eth_abi import encode
from web3 import Web3

# Fixed-point scale used when encoding floats for on-chain hashing/ABI
# encoding, since Solidity has no native float type. 1e6 gives 6 decimal
# digits of precision, comfortably more than these features need.
FIXED_POINT_SCALE = 1_000_000
SALT_BYTES = 32


def _to_fixed_point(value: float) -> int:
    return int(round(value * FIXED_POINT_SCALE))


def new_salt() -> bytes:
    return os.urandom(SALT_BYTES)


def compute_commitment_hash(q: list[int], risk_score: float, salt: bytes) -> str:
    """keccak256(abi.encode(uint256[] q, int256 score * 1e6, bytes32 salt))."""
    if len(salt) != SALT_BYTES:
        raise ValueError(f"salt must be {SALT_BYTES} bytes")
    encoded = encode(
        ["uint256[]", "int256", "bytes32"],
        [[int(x) for x in q], _to_fixed_point(risk_score), salt],
    )
    digest = Web3.keccak(encoded).hex()
    return digest if digest.startswith("0x") else "0x" + digest


def verify_commitment(commitment_hash: str, q: list[int], risk_score: float, salt: bytes) -> bool:
    """Audit check: does a revealed (q, score, salt) match the on-chain commitment?"""
    return compute_commitment_hash(q, risk_score, salt).lower() == commitment_hash.lower()
