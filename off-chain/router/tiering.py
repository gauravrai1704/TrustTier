"""
The escalation policy: maps a position's delta (distance to its
liquidation boundary, from delta.py) to one of three verification tiers.

This is a first, deliberately simple fixed-band version of the policy for
the Weeks 2-3 milestone (get a synthetic stream routing end-to-end). The
project plan's Weeks 6-7 evaluation phase is where the band widths
(TIER_1_BAND, TIER_2_BAND below) get calibrated against replayed historical
liquidation data and the formal cost-optimality analysis described in the
proposal - this module is the natural place that calibration will land.

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
