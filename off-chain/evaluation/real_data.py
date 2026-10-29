"""
Loads the real Aave V2 wallet health-factor history (see data/README.md
for provenance) and derives TrustTier's 5 model features from it.

Feature derivation - what's real vs. what's a documented proxy:

  ltv                          REAL, derived exactly: current_liquidation_threshold / HF.
                                (Since HF = collateral*threshold/debt, and effective
                                LTV = debt/collateral, algebra gives
                                effective_ltv = threshold / HF exactly - no
                                approximation involved.)
  collateral_volatility_30d    DERIVED from real data: rolling stddev of the
                                period-over-period percent change in total_collateral_eth.
                                Genuinely computed from real values, but the
                                dataset's snapshots are roughly weekly, not
                                daily, so this is a "volatility across
                                observed snapshots" rather than a strict
                                30-day window. Documented here rather than
                                silently mislabeled.
  price_momentum_24h           DERIVED from real data: percent change in
                                total_collateral_eth between consecutive
                                snapshots. Same weekly-vs-24h caveat as above.
  time_since_last_topup_days   REAL, computed exactly from real timestamps:
                                days since total_collateral_eth last increased.
  account_age_days             REAL, computed exactly: days since this
                                wallet's first snapshot in the dataset.

Everything here is either an exact derivation from real values (ltv,
account_age_days, time_since_last_topup_days) or a real rolling statistic
computed over real values, at a coarser cadence than the feature name
technically implies (collateral_volatility_30d, price_momentum_24h) - never
a fabricated or synthetic number.
"""

import os
from dataclasses import dataclass

import pandas as pd

DATA_PATH = os.path.join(
    os.path.dirname(__file__), "data", "aave_v2_wallet_0x01acb3804ba9c42111c6e9c127831eb486ca1ac7.csv"
)


@dataclass(frozen=True)
class RealPosition:
    position_id: int
    block_height: int
    timestamp: str
    ltv: float
    liquidation_threshold: float
    collateral_volatility_30d: float
    price_momentum_24h: float
    time_since_last_topup_days: float
    account_age_days: float
    health_factor: float  # kept for reference/validation, not a model feature

    def to_features(self) -> dict:
        return {
            "ltv": self.ltv,
            "collateral_volatility_30d": self.collateral_volatility_30d,
            "price_momentum_24h": self.price_momentum_24h,
            "time_since_last_topup_days": self.time_since_last_topup_days,
            "account_age_days": self.account_age_days,
        }


def load_real_positions(position_id_start: int = 2000, path: str = DATA_PATH) -> list:
    return positions_from_frame(pd.read_csv(path), position_id_start)


def positions_from_frame(df: pd.DataFrame, position_id_start: int = 2000) -> list:
    """One wallet's snapshots (Cred Protocol's column layout) -> RealPositions."""
    df = df.copy()
    df["block_timestamp"] = pd.to_datetime(df["block_timestamp"])
    df = df.sort_values("block_timestamp")

    # Drop the very first row: HF is `inf` there (zero debt yet), which
    # isn't a meaningful position to route through tiering.
    df = df[df["total_debt_eth"] > 0].reset_index(drop=True)

    collateral = df["total_collateral_eth"]
    pct_change = collateral.pct_change()

    # Rolling stddev over the last 4 snapshots (~1 month at this dataset's
    # roughly-weekly cadence) as the volatility proxy; NaN for the first
    # few rows (insufficient history) is filled with 0 (treated as "no
    # observed volatility yet" rather than dropping early rows entirely).
    rolling_volatility = pct_change.rolling(window=4, min_periods=1).std().fillna(0.0)

    first_timestamp = df["block_timestamp"].iloc[0]
    last_topup_timestamp = df["block_timestamp"].iloc[0]

    positions = []
    for i, row in df.iterrows():
        if i > 0 and collateral.iloc[i] > collateral.iloc[i - 1]:
            last_topup_timestamp = row["block_timestamp"]

        account_age_days = (row["block_timestamp"] - first_timestamp).days
        time_since_topup_days = (row["block_timestamp"] - last_topup_timestamp).days
        momentum = pct_change.iloc[i] if not pd.isna(pct_change.iloc[i]) else 0.0

        threshold = row["current_liquidation_threshold"]
        hf = row["HF"]
        effective_ltv = threshold / hf if hf > 0 else 999.0  # HF<=0 shouldn't occur post-filter; guard anyway

        positions.append(
            RealPosition(
                position_id=position_id_start + i,
                block_height=int(row["block_height"]),
                timestamp=str(row["block_timestamp"]),
                ltv=min(effective_ltv, 1.49),  # clip to the router's validated LTV range (see main.py's PositionFeatures)
                liquidation_threshold=threshold,
                collateral_volatility_30d=min(float(rolling_volatility.iloc[i]), 1.0),
                price_momentum_24h=max(min(float(momentum), 1.0), -1.0),
                time_since_last_topup_days=min(float(time_since_topup_days), 90.0),
                account_age_days=float(account_age_days),
                health_factor=float(hf),
            )
        )

    return positions


if __name__ == "__main__":
    positions = load_real_positions()
    print(f"Loaded {len(positions)} real position snapshots.")
    print(f"{'block':>10} {'timestamp':>20} {'HF':>8} {'eff_ltv':>8} {'thresh':>7}")
    for p in positions:
        print(f"{p.block_height:>10} {p.timestamp:>20} {p.health_factor:>8.3f} {p.ltv:>8.3f} {p.liquidation_threshold:>7.3f}")
