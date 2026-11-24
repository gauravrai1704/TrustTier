"""
The escalation policy: maps a position's delta (distance to its
liquidation boundary, from delta.py) to one of three verification tiers.

The same bands are enforced ON-CHAIN: LiquidationEngine computes delta from
the lending protocol's own numbers and refuses a tier that is too weak
(tierBands, which adapts to the collateral's volatility). The router uses
`decide_tier_bps` on the contract's delta and q_vol, so it never attempts a
tier the chain would refuse; `decide_tier` (float delta) serves the
off-chain evaluation.

    delta > B0(sigma)                    -> Tier 0 (Heuristic)
    B1(sigma) < delta <= B0(sigma)        -> Tier 1 (Commitment)
    delta <= B1(sigma) (incl. negative)   -> Tier 2 (ZkProof)
"""

from dataclasses import dataclass
from enum import IntEnum

from router.delta import DeltaResult


class Tier(IntEnum):
    HEURISTIC = 0
    COMMITMENT = 1
    ZK_PROOF = 2


# Volatility-adaptive bands (LiquidationEngine.tierBands), in basis points:
#   Tier 0 needs delta > 5% + 0.3 sigma, kept within [10%, 30%]
#          (a 2.2-sigma one-week price move plus a 5% buffer);
#   Tier 1 needs delta > 1.5% + 0.1 sigma, kept within [3%, 12%]
#          (a 2-sigma one-day move plus a 1.5% buffer).
# sigma is the collateral's 30-day volatility; on-chain it is the quantized
# feature q_vol = sigma * 1024.
TIER0_BASE_BPS, TIER0_VOL_TENTHS, TIER0_MIN_BPS, TIER0_MAX_BPS = 500, 3, 1000, 3000
TIER1_BASE_BPS, TIER1_VOL_TENTHS, TIER1_MIN_BPS, TIER1_MAX_BPS = 150, 1, 300, 1200
SCALE = 1024
REFERENCE_SIGMA = 0.35  # typical ETH volatility: bands 15.5% / 5%


def _clamp(x: int, lo: int, hi: int) -> int:
    return lo if x < lo else (hi if x > hi else x)


def _div(a: int, b: int) -> int:
    """Solidity's signed division (truncates toward zero)."""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b > 0) else -q


def tier_bands_bps(q_vol: int) -> tuple:
    """(Tier-0 band, Tier-1 band) in bps, exactly as LiquidationEngine.tierBands."""
    sigma_bps = (int(q_vol) * 10_000) // SCALE
    b0 = _clamp(TIER0_BASE_BPS + _div(sigma_bps * TIER0_VOL_TENTHS, 10), TIER0_MIN_BPS, TIER0_MAX_BPS)
    b1 = _clamp(TIER1_BASE_BPS + _div(sigma_bps * TIER1_VOL_TENTHS, 10), TIER1_MIN_BPS, TIER1_MAX_BPS)
    return b0, b1


def tier_bands(sigma: float) -> tuple:
    """The bands for a volatility sigma (a fraction), as fractions of LTV."""
    b0, b1 = tier_bands_bps(min(SCALE, max(0, int(sigma * SCALE))))
    return b0 / 10_000, b1 / 10_000


@dataclass(frozen=True)
class TierDecision:
    tier: Tier
    delta: float
    reason: str


def decide_tier(delta_result: DeltaResult, sigma: float = REFERENCE_SIGMA) -> TierDecision:
    """Float version for the off-chain evaluation (sigma defaults to 35%)."""
    delta = delta_result.delta
    b0, b1 = tier_bands(sigma)
    if delta > b0:
        return TierDecision(Tier.HEURISTIC, delta, f"delta={delta:.4f} > Tier-0 band {b0:.4f} (far from boundary)")
    if delta > b1:
        return TierDecision(Tier.COMMITMENT, delta,
                            f"Tier-1 band {b1:.4f} < delta={delta:.4f} <= Tier-0 band {b0:.4f} (approaching boundary)")
    return TierDecision(Tier.ZK_PROOF, delta, f"delta={delta:.4f} <= Tier-1 band {b1:.4f} (at genuine risk or already breached)")


def decide_tier_bps(delta_bps: int, q_vol: int) -> TierDecision:
    """The weakest tier the chain accepts for this delta and volatility (integer bps)."""
    delta = delta_bps / 10_000
    b0, b1 = tier_bands_bps(q_vol)
    if delta_bps > b0:
        return TierDecision(Tier.HEURISTIC, delta, f"on-chain delta {delta_bps} bps > Tier-0 band {b0} (far from boundary)")
    if delta_bps > b1:
        return TierDecision(Tier.COMMITMENT, delta,
                            f"Tier-1 band {b1} < on-chain delta {delta_bps} bps <= Tier-0 band {b0} (approaching boundary)")
    return TierDecision(Tier.ZK_PROOF, delta, f"on-chain delta {delta_bps} bps <= Tier-1 band {b1} (at risk or breached)")
