# Real historical Aave V2 data

`aave_v2_wallet_0x01acb3804ba9c42111c6e9c127831eb486ca1ac7.csv`

## Source
Cred Protocol's public **Aave V2 Health Factor Dataset**:
https://github.com/credprotocol/Aave-V2-Health-Factor-Dataset

This is the sample file linked directly from that repository's README (75
rows, ~80KB), covering one real Aave V2 wallet's on-chain position history
from 2021-01-03 to 2022-06-25. It contains real per-snapshot values for
total collateral (ETH), total debt (ETH), the current liquidation
threshold, and the resulting health factor (HF), reconstructed by Cred
Protocol from actual on-chain Aave V2 events (the repository reports a
mean difference of ~1.33% against ground-truth health factors in their own
validation).

**This single wallet's trajectory includes a real liquidation-adjacent
event**: HF drops below 1.0 around 2022-01-07 (row 51, HF=0.815), and
collateral collapses from ~0.18 ETH to ~0.000018 ETH between rows 60-61
(2022-03-13 to 2022-03-20) - consistent with the position being liquidated.

## Known limitation: single-account sample, not a large-N historical dataset

Cred Protocol's full dataset (1.33M rows, 35,524 accounts, 1.91GB) is
real and public, but distributed via a Dropbox link, which is outside
this project's available network access at the time this file was
retrieved. Pulling more than this one sample wallet would require either:
- Downloading Cred Protocol's full dataset from the Dropbox link in their
  README directly (not done here), or
- Querying Aave's on-chain history directly via an Etherscan or TheGraph
  API key (see "Extending to a larger real dataset" below).

**What this means for `evaluate.py` (Weeks 5-6 evaluation script):** the
real-data portion of the evaluation is a genuine, honestly-sourced
single-account case study - useful for confirming TrustTier's tiering
logic behaves correctly against a real historical HF trajectory, including
correctly escalating through all three tiers as the position actually
approached and crossed its real liquidation boundary. It is NOT a
statistically representative sample of liquidation risk across the
protocol. The broader, statistically-sized portion of the evaluation uses
the project's existing synthetic generator
(`router/position_stream.py`), clearly labeled as such throughout.

## Extending to a larger real dataset later
To replay against many real accounts instead of one:
1. Get a free Etherscan API key (or a TheGraph API key for Aave's
   subgraph).
2. Query `LiquidationCall` and reserve-data events for the Aave V2 Lending
   Pool contract (`0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9`) across a
   block range of interest.
3. Reconstruct per-account collateral/debt/HF time series the same way
   Cred Protocol's methodology does (see their repo's data-flow diagram),
   or adapt `real_data.py`'s feature derivation to whatever schema the
   query returns.
4. Feed the resulting positions through `replay.py` exactly as the single
   sample wallet is today.

## License / attribution
Cred Protocol's repository does not state an explicit license for the
dataset itself; the sample file is linked publicly and directly from their
README as a "how can I download this dataset" example, which this project
downloaded via that same public link
(`raw.githubusercontent.com/credprotocol/...`). Attribute Cred Protocol
(https://credprotocol.com) if this data or derived results are published.
