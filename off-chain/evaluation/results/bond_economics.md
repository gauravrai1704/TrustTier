# Bond economics

`python -m evaluation.bond_economics` - measured gas: a challenge costs 678,771 gas
(773,609 through commit-reveal).

**Fixed 0.01 ETH bond.** Challenging a false claim loses money above
**14.73 gwei** (12.93 gwei with commit-reveal), so at
ordinary L1 gas prices nobody has a reason to watch.

**Gas-scaled bond** (`max(MIN_BOND, 1,500,000 x basefee)`, what the engine enforces now): the bond
covers a challenge at any gas price, and stays profitable as long as the base fee at
challenge time is under **2.21x** the base fee at the claim
(1.94x with commit-reveal).

| gas price (gwei) | challenge cost (ETH) | fixed-bond profit (ETH) | gas-scaled bond (ETH) | gas-scaled profit (ETH) |
|---|---|---|---|---|
| 1 | 0.0007 | +0.0093 | 0.0100 | +0.0093 |
| 2 | 0.0014 | +0.0086 | 0.0100 | +0.0086 |
| 5 | 0.0034 | +0.0066 | 0.0100 | +0.0066 |
| 10 | 0.0068 | +0.0032 | 0.0150 | +0.0082 |
| 15 | 0.0102 | -0.0002 | 0.0225 | +0.0123 |
| 20 | 0.0136 | -0.0036 | 0.0300 | +0.0164 |
| 30 | 0.0204 | -0.0104 | 0.0450 | +0.0246 |
| 50 | 0.0339 | -0.0239 | 0.0750 | +0.0411 |
| 75 | 0.0509 | -0.0409 | 0.1125 | +0.0616 |
| 100 | 0.0679 | -0.0579 | 0.1500 | +0.0821 |
| 150 | 0.1018 | -0.0918 | 0.2250 | +0.1232 |
| 200 | 0.1358 | -0.1258 | 0.3000 | +0.1642 |

## When is daily monitoring affordable?

TrustTier's decision gas per position-day comes from `hf_baseline.json`
(322,467 gas, vs 880,332 for always-zk). At
ETH = $3,000, the smallest debt for which a year of daily decisions costs
under 0.5% of the debt:

| network | TrustTier $/position/year | min. debt | always-zk $/position/year | min. debt |
|---|---|---|---|---|
| Ethereum L1 (20 gwei) | $7,062.03 | $1,412,405 | $19,279.27 | $3,855,854 |
| Ethereum L1 (5 gwei) | $1,765.51 | $353,101 | $4,819.82 | $963,964 |
| Rollup (0.05 gwei effective) | $17.66 | $3,531 | $48.20 | $9,640 |

On L1 the scheme only pays for large positions (or a slower cadence, e.g.
re-deciding Tier-0 positions weekly); on a rollup it is cheap enough for
ordinary retail positions. That is the deployment target this analysis argues for.
