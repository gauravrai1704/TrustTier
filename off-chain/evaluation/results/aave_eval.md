# TrustTier on real Aave V2 positions

`python -m evaluation.aave_eval`

## Bands: adaptive

| sample | rows | T0/T1/T2 | escalated | gas (M) | always-zk (M) | saving | cheap claims liquidatable in 1d / 7d |
|---|---|---|---|---|---|---|---|
| liquidated | 11,276 | 1096/4170/6010 | 454 | 7920.0 | 11325.9 | 30.1% | 25 / 559 |
| random | 33,676 | 23620/8033/2023 | 38 | 11485.1 | 33824.9 | 66.0% | 9 / 98 |

## Bands: fixed_15_5

| sample | rows | T0/T1/T2 | escalated | gas (M) | always-zk (M) | saving | cheap claims liquidatable in 1d / 7d |
|---|---|---|---|---|---|---|---|
| liquidated | 11,276 | 3432/3029/4815 | 1927 | 6918.2 | 11325.9 | 38.9% | 58 / 831 |
| random | 33,676 | 30036/2685/955 | 375 | 10115.2 | 33824.9 | 70.1% | 15 / 134 |

## Early warning (liquidated accounts, adaptive bands)

{
  "trusttier_model": {
    "liquidated_accounts_observed": 386,
    "flagged_at_least_1_day_before": 228,
    "flagged_at_least_3_days_before": 165,
    "median_lead_days_when_flagged": 6.0
  },
  "delta_only_baseline": {
    "liquidated_accounts_observed": 386,
    "flagged_at_least_1_day_before": 237,
    "flagged_at_least_3_days_before": 178,
    "median_lead_days_when_flagged": 7.0
  }
}

## Approved soft liquidations on the random sample

{
  "trusttier_model": {
    "approved_soft_liquidations": 838,
    "of_which_liquidatable_within_7d": 80,
    "position_days": 33676
  },
  "delta_only_baseline": {
    "approved_soft_liquidations": 2023,
    "of_which_liquidatable_within_7d": 124,
    "position_days": 33676
  }
}

## Ranking (random sample, liquidatable within 7 days)

{
  "model_p_high": 0.9117,
  "minus_delta": 0.9107,
  "base_rate_7d": 0.00659
}
