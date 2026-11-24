# TrustTier on real Aave V2 positions

`python -m evaluation.aave_eval`

## Bands: adaptive

| sample | rows | T0/T1/T2 | escalated | gas (M) | always-zk (M) | saving | cheap claims liquidatable in 1d / 7d |
|---|---|---|---|---|---|---|---|
| liquidated | 11,276 | 1096/3603/6577 | 1021 | 8272.7 | 11324.9 | 27.0% | 21 / 501 |
| random | 33,676 | 23620/7948/2108 | 123 | 11534.6 | 33822.0 | 65.9% | 9 / 97 |

## Bands: fixed_15_5

| sample | rows | T0/T1/T2 | escalated | gas (M) | always-zk (M) | saving | cheap claims liquidatable in 1d / 7d |
|---|---|---|---|---|---|---|---|
| liquidated | 11,276 | 3432/2658/5186 | 2298 | 7148.6 | 11324.9 | 36.9% | 59 / 790 |
| random | 33,676 | 30036/2422/1218 | 638 | 10275.7 | 33822.0 | 69.6% | 16 / 135 |

## Early warning (liquidated accounts, adaptive bands)

{
  "trusttier_model": {
    "liquidated_accounts_observed": 386,
    "flagged_at_least_1_day_before": 197,
    "flagged_at_least_3_days_before": 149,
    "median_lead_days_when_flagged": 5.0
  },
  "delta_only_baseline": {
    "liquidated_accounts_observed": 386,
    "flagged_at_least_1_day_before": 239,
    "flagged_at_least_3_days_before": 182,
    "median_lead_days_when_flagged": 7.0
  }
}

## Approved soft liquidations on the random sample

{
  "trusttier_model": {
    "approved_soft_liquidations": 1060,
    "of_which_liquidatable_within_7d": 63,
    "position_days": 33676
  },
  "delta_only_baseline": {
    "approved_soft_liquidations": 2108,
    "of_which_liquidatable_within_7d": 125,
    "position_days": 33676
  }
}

## Ranking (random sample, liquidatable within 7 days)

{
  "model_p_high": 0.8586,
  "minus_delta": 0.9107,
  "base_rate_7d": 0.00659
}
