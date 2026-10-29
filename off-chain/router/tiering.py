"""
The escalation policy: maps a position's delta (distance to its
liquidation boundary, from delta.py) to one of three verification tiers.

The same bands are enforced ON-CHAIN: LiquidationEngine computes delta from
the lending protocol's own numbers and refuses a tier that is too weak
(TIER0_MIN_DELTA_BPS, TIER1_MIN_DELTA_BPS). The router uses `decide_tier_bps`
on the contract's delta, so it never attempts a tier the chain would refuse;
`decide_tier` (float delta) remains for the off-chain evaluation.

    delta > TIER_1_BAND                    -> Tier 0 (Heuristic)
    TIER_2_BAND < delta <= TIER_1_BAND      -> Tier 1 (Commitment)
    delta <= TIER_2_BAND (incl. negative)   -> Tier 2 (ZkProof)
"""

from dataclasses import dataclass
from enum import IntEnum

from router.delta import DeltaResult


class Tier(IntEnum):
    HEURISTIC = 0
    COMMITMENT = 1
    ZK_PROOF = 2


# Band thresholds, expressed in the same units as delta (i.e. LTV points).
# A position more than 15 LTV-points below its liquidation threshold is
# considered "far from danger"; within 5 points (or already breached) is
# "genuine risk" and gets the strongest verification tier.
TIER_1_BAND = 0.15
TIER_2_BAND = 0.05


@dataclass(frozen=True)
class TierDecision:
    tier: Tier
    delta: float
    reason: str


def decide_tier(delta_result: DeltaResult) -> TierDecision:
    delta = delta_result.delta

    if delta > TIER_1_BAND:
        return TierDecision(
            tier=Tier.HEURISTIC,
            delta=delta,
            reason=f"delta={delta:.4f} > TIER_1_BAND={TIER_1_BAND} (far from boundary)",
        )
    elif delta > TIER_2_BAND:
        return TierDecision(
            tier=Tier.COMMITMENT,
            delta=delta,
            reason=f"TIER_2_BAND={TIER_2_BAND} < delta={delta:.4f} <= TIER_1_BAND={TIER_1_BAND} (approaching boundary)",
        )
    else:
        return TierDecision(
            tier=Tier.ZK_PROOF,
            delta=delta,
            reason=f"delta={delta:.4f} <= TIER_2_BAND={TIER_2_BAND} (at genuine risk or already breached)",
        )


# The contract's thresholds, in basis points (LiquidationEngine.sol).
TIER0_MIN_DELTA_BPS = 1500
TIER1_MIN_DELTA_BPS = 500
assert TIER0_MIN_DELTA_BPS == round(TIER_1_BAND * 10_000) and TIER1_MIN_DELTA_BPS == round(TIER_2_BAND * 10_000)


def decide_tier_bps(delta_bps: int) -> TierDecision:
    """The weakest tier the chain accepts for this delta (integer basis points)."""
    delta = delta_bps / 10_000
    if delta_bps > TIER0_MIN_DELTA_BPS:
        return TierDecision(Tier.HEURISTIC, delta, f"on-chain delta {delta_bps} bps > {TIER0_MIN_DELTA_BPS} (far from boundary)")
    if delta_bps > TIER1_MIN_DELTA_BPS:
        return TierDecision(Tier.COMMITMENT, delta,
                            f"{TIER1_MIN_DELTA_BPS} < on-chain delta {delta_bps} bps <= {TIER0_MIN_DELTA_BPS} (approaching boundary)")
    return TierDecision(Tier.ZK_PROOF, delta, f"on-chain delta {delta_bps} bps <= {TIER1_MIN_DELTA_BPS} (at risk or breached)")
