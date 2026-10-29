"""
The five model features, computed from on-chain data exactly as
LiquidationEngine.sol computes them - the Python mirror of the contract's
fixed-point arithmetic.

Why this exists: the contract no longer trusts anyone to supply a position's
features. It reads them from their on-chain sources and checks that the
Tier-2 proof was computed on exactly those values:

    feature                      on-chain source
    ---------------------------  ------------------------------------------------
    ltv                          lending protocol: debt / collateral (USD, 8 dp)
    collateral_volatility_30d    Chainlink realized-volatility feed (percent)
    price_momentum_24h           Chainlink price feed: now vs the round in effect 24 h ago
    time_since_last_topup_days   lending protocol (or adapter) timestamp
    account_age_days             lending protocol (or adapter) timestamp

Each feature is min-max normalized over FEATURE_BOUNDS and quantized to an
integer q in [0, 1024] (the circuit's input scale is 2**10, so the circuit
sees exactly q / 1024). The quantized vector is what the proof's first five
public instances must equal. All arithmetic is integer floor division in the
same order as the Solidity code, so the two agree bit for bit (checked by
test/EzklIntegration.test.js against real proofs).
"""

from __future__ import annotations

from dataclasses import dataclass

SCALE = 1024  # 2**input_scale of the circuit
SECONDS_PER_DAY = 86_400
MAX_TOPUP_DAYS = 90
MAX_AGE_DAYS = 2_000


@dataclass(frozen=True)
class OnchainPosition:
    collateral_usd: int        # 8 decimals (Aave "base currency" convention)
    debt_usd: int              # 8 decimals
    liquidation_threshold_bps: int
    opened_at: int             # unix seconds
    last_topup_at: int         # unix seconds


def quantize(pos: OnchainPosition, price_now: int, price_past: int,
             vol_answer: int, vol_decimals: int, now: int) -> list[int]:
    """Return q = [ltv, volatility, momentum, topup, age], each in [0, 1024]."""
    if pos.collateral_usd <= 0:
        raise ValueError("position has no collateral")
    # ltv / 1.5 * 1024  ==  debt * 2048 / (3 * collateral)
    q_ltv = min(pos.debt_usd * 2048 // (3 * pos.collateral_usd), SCALE)
    # volatility feed answers in percent with `vol_decimals` decimals; range [0, 1]
    q_vol = min(vol_answer * SCALE // (100 * 10 ** vol_decimals), SCALE)
    # momentum m = p_now / p_past - 1 in [-1, 1];  (m + 1) / 2 * 1024 == p_now * 512 / p_past
    q_mom = min(price_now * 512 // price_past, SCALE)
    topup_days = min((now - pos.last_topup_at) // SECONDS_PER_DAY, MAX_TOPUP_DAYS)
    q_top = topup_days * SCALE // MAX_TOPUP_DAYS
    age_days = min((now - pos.opened_at) // SECONDS_PER_DAY, MAX_AGE_DAYS)
    q_age = age_days * SCALE // MAX_AGE_DAYS
    return [q_ltv, q_vol, q_mom, q_top, q_age]


def ltv_bps(pos: OnchainPosition) -> int:
    return pos.debt_usd * 10_000 // pos.collateral_usd


def delta_bps(pos: OnchainPosition) -> int:
    """delta = liquidation threshold - LTV, in basis points (can be negative)."""
    return pos.liquidation_threshold_bps - ltv_bps(pos)


def to_model_input(q: list[int]) -> list[float]:
    """The normalized vector the model and the circuit see."""
    return [x / SCALE for x in q]
