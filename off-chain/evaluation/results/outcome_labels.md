# Outcome-labelled evaluation

`python -m evaluation.outcome_labels` on `evaluation/data/aave_v2_wallet_0x01acb3804ba9c42111c6e9c127831eb486ca1ac7.csv`:
1 wallet(s), 73 snapshots. Label = health factor below 1 within
7 days (the snapshot became liquidatable).

| scorer | snapshots | positives | precision | recall | ROC-AUC |
|---|---|---|---|---|---|
| deployed model v2 (synthetic labels) | 73 | 1 | 0.026 | 1.0 | 0.861 |
| HF rule: warn when HF < 1.15 | 73 | 1 | 0.025 | 1.0 | 0.819 |

Candidate model: skipped: 1 wallet(s); retraining needs at least 20 (download the complete dataset, see module docstring).

With one wallet this is a case study, not a statistic; run it on the complete
Cred Protocol dataset (module docstring) before citing these numbers as results.
