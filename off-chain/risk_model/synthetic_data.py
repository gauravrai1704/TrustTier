"""
Generates synthetic borrower position data to train the risk model on.

There is no realistic substitute for real Aave/Compound liquidation history
at this stage of the project (that integration is planned for Weeks 5-6,
per the project timeline, once real historical data replay is built). This
generator exists purely to produce a risk model that behaves sensibly for
the Weeks 2-3 milestone: routing a synthetic position stream through
Tier 0/1/2 end-to-end.

The synthetic "ground truth" risk label is deliberately NOT a pure function
of LTV alone - it also responds to collateral volatility, momentum, and
account history - so the trained model has something non-trivial to learn
and to justify why an ML risk score is more informative than the static
LTV threshold TrustTier is designed to improve on.
"""

import numpy as np

from risk_model.features import FEATURE_NAMES


def generate_synthetic_dataset(n_samples: int = 4000, seed: int = 42):
    rng = np.random.default_rng(seed)

    ltv = rng.uniform(0.30, 1.10, n_samples)
    collateral_volatility_30d = rng.uniform(0.02, 0.60, n_samples)
    price_momentum_24h = rng.uniform(-0.30, 0.30, n_samples)
    time_since_last_topup_days = rng.exponential(scale=15.0, size=n_samples).clip(0, 90)
    account_age_days = rng.uniform(1, 2000, n_samples)

    # Synthetic ground-truth risk score in [0, 1]: LTV dominates, but
    # volatility and adverse momentum amplify risk, while account age and
    # recent top-ups reduce it. Coefficients are illustrative, not fitted
    # to any real dataset.
    raw_score = (
        3.2 * (ltv - 0.5)
        + 1.8 * collateral_volatility_30d
        - 1.1 * price_momentum_24h
        + 0.01 * (time_since_last_topup_days / 90.0) * 2.0
        - 0.4 * np.log1p(account_age_days) / np.log1p(2000)
    )
    noise = rng.normal(0, 0.15, n_samples)
    risk_score = 1.0 / (1.0 + np.exp(-(raw_score + noise)))  # squashed to [0, 1]

    # Binary label for classifier training: "should this be flagged as
    # high-risk / liquidation-worthy" at a 0.5 cutoff on the latent score.
    label = (risk_score > 0.5).astype(int)

    X = np.column_stack(
        [ltv, collateral_volatility_30d, price_momentum_24h, time_since_last_topup_days, account_age_days]
    )
    assert X.shape[1] == len(FEATURE_NAMES)

    return X, label, risk_score
