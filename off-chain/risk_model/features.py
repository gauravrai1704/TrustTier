"""
Feature definitions for the TrustTier risk model.

Kept deliberately small and simple (5 numeric features, no categorical
encoding, no feature crosses) for two reasons:
  1. It is representative of what a real DeFi risk score would use beyond
     a bare LTV ratio - collateral volatility, momentum, and account
     history all plausibly refine a liquidation decision.
  2. Small, simple models compile into far smaller/faster zk-SNARK circuits.
     EZKL (Weeks 3-5) performs its own fixed-point quantization during
     circuit compilation, so no manual weight quantization is done here -
     keeping the *architecture* small is what actually matters for
     circuit size and proving time.

Feature order matters: it must exactly match the column order the ONNX
model was exported with, since ONNX Runtime takes a plain float array.
"""

FEATURE_NAMES = [
    "ltv",                      # current loan-to-value ratio, in [0, 1.5]
    "collateral_volatility_30d",  # 30-day realized volatility of the collateral asset, in [0, 1]
    "price_momentum_24h",         # signed 24h price change of the collateral asset, in [-1, 1]
    "time_since_last_topup_days",  # days since the borrower last added collateral/repaid, in [0, 90]
    "account_age_days",           # age of the borrowing account, in [0, 2000] (older accounts are lower-risk, all else equal)
]

N_FEATURES = len(FEATURE_NAMES)


def features_to_vector(features: dict) -> list:
    """Convert a features dict into an ordered vector matching FEATURE_NAMES."""
    return [float(features[name]) for name in FEATURE_NAMES]
