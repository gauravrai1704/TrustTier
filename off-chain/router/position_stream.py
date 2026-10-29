"""
Generates a synthetic stream of borrower positions for the Weeks 2-3
milestone: proving that a stream of positions correctly routes across all
three tiers end-to-end against the local chain.

This is distinct from risk_model/synthetic_data.py, which generates
*training* data for the risk model. This module generates individual
*position events* - the kind of thing a real system would receive from a
lending protocol's position-tracking service - deliberately spanning safe,
watch-band, and critical LTV ranges so every tier gets exercised at least
once per run.
"""

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class SyntheticPosition:
    position_id: int
    ltv: float
    collateral_volatility_30d: float
    price_momentum_24h: float
    time_since_last_topup_days: float
    account_age_days: float

    def to_features(self) -> dict:
        return {
            "ltv": self.ltv,
            "collateral_volatility_30d": self.collateral_volatility_30d,
            "price_momentum_24h": self.price_momentum_24h,
            "time_since_last_topup_days": self.time_since_last_topup_days,
            "account_age_days": self.account_age_days,
        }


def generate_position_stream(n_positions: int = 12, seed: int = 7, start_id: int = 1000) -> list:
    """
    Generates a stream that deliberately covers the full LTV range (safe,
    watch-band, and critical/breached), rather than a uniform random draw,
    so a short demo run reliably exercises all three tiers instead of
    relying on chance.
    """
    rng = np.random.default_rng(seed)

    # Explicit LTV bands, split roughly evenly across the stream length.
    n_per_band = max(1, n_positions // 3)
    safe_ltvs = rng.uniform(0.35, 0.60, n_per_band)
    watch_ltvs = rng.uniform(0.66, 0.76, n_per_band)
    critical_ltvs = rng.uniform(0.76, 0.98, n_positions - 2 * n_per_band)

    all_ltvs = np.concatenate([safe_ltvs, watch_ltvs, critical_ltvs])
    rng.shuffle(all_ltvs)  # interleave tiers, like a real position stream would arrive

    positions = []
    for i, ltv in enumerate(all_ltvs):
        positions.append(
            SyntheticPosition(
                position_id=start_id + i,
                ltv=float(ltv),
                collateral_volatility_30d=float(rng.uniform(0.05, 0.45)),
                price_momentum_24h=float(rng.uniform(-0.2, 0.2)),
                time_since_last_topup_days=float(rng.uniform(0, 60)),
                account_age_days=float(rng.uniform(30, 1500)),
            )
        )
    return positions


@dataclass(frozen=True)
class DemoPositionSpec:
    """A position to OPEN in MockLendingPool (demo chain). Volatility and
    momentum are not chosen here: they come from the market's feeds."""
    position_id: int
    market: int
    ltv: float
    age_days: int
    topup_days: int


def generate_onchain_stream(markets: list, n_positions: int = 12, seed: int = 7,
                            start_id: int = 1000) -> list:
    """Positions spread across the deployed markets and across the safe /
    watch / critical bands of each market's own liquidation threshold, so
    every tier is exercised."""
    rng = np.random.default_rng(seed)
    bands = [(-0.35, -0.20), (-0.14, -0.06), (-0.04, 0.15)]   # LTV minus threshold
    specs = []
    for i in range(n_positions):
        market = i % len(markets)
        threshold = markets[market]["thresholdBps"] / 10_000
        lo, hi = bands[(i // len(markets) + i) % 3]
        ltv = float(np.clip(threshold + rng.uniform(lo, hi), 0.05, 1.45))
        specs.append(DemoPositionSpec(
            position_id=start_id + i, market=market, ltv=round(ltv, 4),
            age_days=int(rng.integers(10, 1500)), topup_days=int(rng.integers(0, 90)),
        ))
    rng.shuffle(specs)
    return specs
