# TrustTier on real Aave V2 positions

`python -m evaluation.aave_eval`

## Bands: adaptive

| sample | rows | T0/T1/T2 | escalated | gas (M) | always-zk (M) | saving | cheap claims liquidatable in 1d / 7d |
|---|---|---|---|---|---|---|---|
| random | 23,182 | 16435/3622/3125 | 1888 | 8547.0 | 20355.0 | 58.0% | 2 / 29 |

## Bands: fixed_15_5

| sample | rows | T0/T1/T2 | escalated | gas (M) | always-zk (M) | saving | cheap claims liquidatable in 1d / 7d |
|---|---|---|---|---|---|---|---|
| random | 23,182 | 20819/376/1987 | 1544 | 7498.7 | 20355.0 | 63.2% | 5 / 54 |

## Early warning (liquidated accounts, adaptive bands)

{
  "liquidated_accounts_observed": 0,
  "flagged_at_least_1_day_before": 0,
  "flagged_at_least_3_days_before": 0,
  "median_lead_days_when_flagged": 0.0
}

## Approved soft liquidations on the random sample

{
  "approved_soft_liquidations": 2965,
  "of_which_liquidatable_within_7d": 85,
  "position_days": 23182
}
