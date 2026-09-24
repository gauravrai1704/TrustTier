"""
Computes delta: the distance from a position's current LTV to its
liquidation threshold. This is the cheap, public signal the escalation
policy (tiering.py) uses to decide how much verification strength a
position's liquidation decision needs.

delta = liquidation_threshold - current_ltv

  delta > 0  : position is currently safe (further above zero = safer)
  delta == 0 : position is exactly at the liquidation boundary
  delta < 0  : position has already breached the threshold

Smaller (including negative) delta means higher risk and triggers a
higher verification tier.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class DeltaResult:
    ltv: float
    liquidation_threshold: float
    delta: float


def compute_delta(ltv: float, liquidation_threshold: float = 0.80) -> DeltaResult:
    if ltv < 0:
        raise ValueError(f"ltv must be non-negative, got {ltv}")
    if not (0 < liquidation_threshold <= 1.5):
        raise ValueError(f"liquidation_threshold out of expected range: {liquidation_threshold}")

    delta = liquidation_threshold - ltv
    return DeltaResult(ltv=ltv, liquidation_threshold=liquidation_threshold, delta=delta)
