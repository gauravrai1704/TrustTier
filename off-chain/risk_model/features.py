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

# Declared domain of each feature (same order as FEATURE_NAMES). The model is
# trained on, and the Tier-2 circuit proves over, min-max normalized features
# (each mapped to [0, 1] with these bounds), so every input the circuit sees
# lies in [0, 1]. That keeps the circuit's lookup tables small (2^16 rows,
# ~16 s proofs); with raw units (account ages up to 2,000 days) the circuit
# needed 2^18 rows and minutes per proof. Values outside the bounds are
# clamped to them, on-chain and off-chain alike.
FEATURE_BOUNDS = [
    (0.0, 1.5),     # ltv
    (0.0, 1.0),     # collateral_volatility_30d
    (-1.0, 1.0),    # price_momentum_24h
    (0.0, 90.0),    # time_since_last_topup_days
    (0.0, 2000.0),  # account_age_days
]


def features_to_vector(features: dict) -> list:
    """Convert a features dict into an ordered vector matching FEATURE_NAMES."""
    return [float(features[name]) for name in FEATURE_NAMES]


def normalize_vector(vector) -> list:
    """Min-max normalize a raw feature vector to [0, 1] using FEATURE_BOUNDS,
    clamping out-of-range values to the bounds - the same min() clamping
    LiquidationEngine applies to features it reads on-chain."""
    if len(vector) != N_FEATURES:
        raise ValueError(f"expected {N_FEATURES} features, got {len(vector)}")
    out = []
    for value, (low, high) in zip(vector, FEATURE_BOUNDS):
        value = min(max(float(value), low), high)
        out.append((value - low) / (high - low))
    return out
