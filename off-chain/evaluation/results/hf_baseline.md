# TrustTier vs. the health-factor rule

`python -m evaluation.hf_baseline` - 3000 positions, 30 daily steps,
LT 0.8, close factor 0.5, bonus 0.05, market
correlation 0.6, crash probability 0.02/day
(size 12%-30%), seed 7.
1021 positions reach the threshold if nobody acts.

| policy | forced liquidations (LTV >= LT) | insolvencies | bad debt (% of debt) | bonus paid by borrowers (% of debt) | pre-emptive soft liquidations | decision gas | gas / position-day |
|---|---|---|---|---|---|---|---|
| hf_rule | 2461 | 61 | 0.018% | 1.353% | 0 (0 unnecessary) | 0.0 M | 0 |
| trusttier | 297 | 2 | 0.001% | 1.669% | 2365 (323 unnecessary) | 29,022.1 M | 322,467 |
| always_zk | 297 | 2 | 0.001% | 1.669% | 2368 (323 unnecessary) | 79,229.9 M | 880,332 |

TrustTier's decision gas is 63.4% below proving every position
every day, for the same pre-emptive protection near the boundary.

Over ten further independent scenarios (mean, and the bad-debt range):

| policy | forced liquidations | insolvencies | bad debt (% of debt) |
|---|---|---|---|
| hf_rule | 3971.9 | 197.8 | 0.087% (0.002-0.294) |
| trusttier | 1085.1 | 45.1 | 0.022% (0.0-0.089) |

Reading it: the health-factor rule costs no decision gas but acts only at the
boundary, so a crash day can carry a position from below LT to under water
before any keeper can help (bad debt). Acting earlier, on a model that sees
volatility and momentum and is proven on-chain, converts some forced
liquidations and insolvencies into smaller pre-emptive ones. The price is
decision gas and a share of unnecessary soft liquidations (positions that
would have recovered); TrustTier's tiers spend that gas only near the
boundary. Assumptions are deliberately simple (constant debt, no top-ups,
synthetic price paths), so the absolute numbers matter less than the
comparison on identical paths.
