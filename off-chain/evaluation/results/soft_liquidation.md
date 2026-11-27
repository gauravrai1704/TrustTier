# Soft-liquidation terms

`python -m evaluation.soft_liquidation`

| policy | forced | insolvent | bad debt % | bonus paid % | soft (positions, unnecessary) | cost of one unnecessary soft liq. (% of debt) | 10-scenario bad debt % |
|---|---|---|---|---|---|---|---|
| same_as_protocol | 373 | 6 | 0.003 | 1.626 | 2262 (1238, 282) | 2.5 | 0.023 |
| hf_rule | 2461 | 61 | 0.018 | 1.353 | 0 (0, 0) | - | 0.087 |
| gentle | 1029 | 13 | 0.004 | 0.869 | 4221 (1238, 282) | 0.4 | 0.037 |
| minimal | 1683 | 27 | 0.01 | 0.929 | 4910 (1238, 282) | 0.1 | 0.055 |
