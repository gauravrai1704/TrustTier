# Bond economics

`python -m evaluation.bond_economics` - measured gas: a challenge costs 804,800 gas
(900,046 through commit-reveal).

**Fixed 0.01 ETH bond.** Challenging a false claim loses money above
**12.43 gwei** (11.11 gwei with commit-reveal), so at
ordinary L1 gas prices nobody has a reason to watch.

**Gas-scaled bond** (`max(MIN_BOND, 1,500,000 x basefee)`, what the engine enforces now): the bond
covers a challenge at any gas price, and stays profitable as long as the base fee at
challenge time is under **1.86x** the base fee at the claim
(1.67x with commit-reveal).

| gas price (gwei) | challenge cost (ETH) | fixed-bond profit (ETH) | gas-scaled bond (ETH) | gas-scaled profit (ETH) |
|---|---|---|---|---|
| 1 | 0.0008 | +0.0092 | 0.0100 | +0.0092 |
| 2 | 0.0016 | +0.0084 | 0.0100 | +0.0084 |
| 5 | 0.0040 | +0.0060 | 0.0100 | +0.0060 |
| 10 | 0.0080 | +0.0020 | 0.0150 | +0.0070 |
| 15 | 0.0121 | -0.0021 | 0.0225 | +0.0104 |
| 20 | 0.0161 | -0.0061 | 0.0300 | +0.0139 |
| 30 | 0.0241 | -0.0141 | 0.0450 | +0.0209 |
| 50 | 0.0402 | -0.0302 | 0.0750 | +0.0348 |
| 75 | 0.0604 | -0.0504 | 0.1125 | +0.0521 |
| 100 | 0.0805 | -0.0705 | 0.1500 | +0.0695 |
| 150 | 0.1207 | -0.1107 | 0.2250 | +0.1043 |
| 200 | 0.1610 | -0.1510 | 0.3000 | +0.1390 |

## When is daily monitoring affordable?

TrustTier's decision gas per position-day comes from `hf_baseline.json`
(320,111 gas, vs 1,005,834 for always-zk). At
ETH = $3,000, the smallest debt for which a year of daily decisions costs
under 0.5% of the debt:

| network | TrustTier $/position/year | min. debt | always-zk $/position/year | min. debt |
|---|---|---|---|---|
| Ethereum L1 (20 gwei) | $7,010.43 | $1,402,086 | $22,027.76 | $4,405,553 |
| Ethereum L1 (5 gwei) | $1,752.61 | $350,522 | $5,506.94 | $1,101,388 |
| Rollup (0.05 gwei effective) | $17.53 | $3,505 | $55.07 | $11,014 |

On L1 the scheme only pays for large positions (or a slower cadence, e.g.
re-deciding Tier-0 positions weekly); on a rollup it is cheap enough for
ordinary retail positions. That is the deployment target this analysis argues for.
