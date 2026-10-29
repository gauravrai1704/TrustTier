"""
Incentive analysis of the bonded challenge game, from measured gas.

The optimistic tiers are only secure if someone watches. A watcher slashes
a false claim only when the bond it wins exceeds what the challenge costs:
the challenge transaction (measured gas x the gas price at challenge time)
plus proving (off-chain, ~16 s; small next to gas at L1 prices). Otherwise
it is the "verifier's dilemma": nobody checks, so a false cheap claim stands.

Two bond rules are compared:
  fixed      the original 0.01 ETH bond (MIN_BOND);
  gas-scaled the bond LiquidationEngine now requires:
             max(MIN_BOND, BOND_GAS_COVER * basefee at the claim).

For each, the script reports the gas price above which challenging loses
money, and how far the base fee may rise between claim and challenge before
it does. It also prices TrustTier's decision gas per position-day (from
hf_baseline.json) on Ethereum L1 and on a rollup, and the smallest position
for which daily monitoring costs less than a target share of the debt per
year - i.e. where the scheme is economically viable.

    python -m evaluation.bond_economics      -> results/bond_economics.{json,md}
"""

from __future__ import annotations

import json
import os

from evaluation.cost_model import CHALLENGE_GAS, COMMITTED_CHALLENGE_GAS, MEASURED

RESULTS = os.path.join(os.path.dirname(__file__), "results")

MIN_BOND_ETH = 0.01
BOND_GAS_COVER = 1_500_000           # LiquidationEngine.BOND_GAS_COVER
GAS_PRICES_GWEI = [1, 2, 5, 10, 15, 20, 30, 50, 75, 100, 150, 200]
ETH_USD = 3000.0                     # assumption for the USD columns
TARGET_COST_BPS_PER_YEAR = 50        # monitoring may cost at most 0.5% of the debt per year
NETWORKS = {                         # effective gas price paid per unit of L2/L1 gas (gwei)
    "Ethereum L1 (20 gwei)": 20.0,
    "Ethereum L1 (5 gwei)": 5.0,
    "Rollup (0.05 gwei effective)": 0.05,
}


def challenge_cost_eth(gwei: float, committed: bool = False) -> float:
    gas = COMMITTED_CHALLENGE_GAS if committed else CHALLENGE_GAS
    return gas * gwei * 1e-9


def gas_scaled_bond_eth(basefee_gwei: float) -> float:
    return max(MIN_BOND_ETH, BOND_GAS_COVER * basefee_gwei * 1e-9)


def run() -> dict:
    rows = []
    for g in GAS_PRICES_GWEI:
        cost = challenge_cost_eth(g)
        cost_c = challenge_cost_eth(g, committed=True)
        scaled = gas_scaled_bond_eth(g)
        rows.append({
            "gas_price_gwei": g,
            "challenge_cost_eth": round(cost, 6),
            "committed_challenge_cost_eth": round(cost_c, 6),
            "fixed_bond_profit_eth": round(MIN_BOND_ETH - cost, 6),
            "gas_scaled_bond_eth": round(scaled, 6),
            "gas_scaled_profit_eth": round(scaled - cost, 6),
            "gas_scaled_profit_committed_eth": round(scaled - cost_c, 6),
        })
    breakeven_fixed = MIN_BOND_ETH / (CHALLENGE_GAS * 1e-9)
    breakeven_fixed_committed = MIN_BOND_ETH / (COMMITTED_CHALLENGE_GAS * 1e-9)

    hf_path = os.path.join(RESULTS, "hf_baseline.json")
    per_day = None
    if os.path.exists(hf_path):
        with open(hf_path) as f:
            hf = json.load(f)["policies"]
        per_day = {p: hf[p]["gas_per_position_day"] for p in ("trusttier", "always_zk")}
    viability = []
    if per_day:
        for net, gwei in NETWORKS.items():
            row = {"network": net, "gas_price_gwei": gwei}
            for policy, gas in per_day.items():
                usd_year = gas * 365 * gwei * 1e-9 * ETH_USD
                row[f"{policy}_usd_per_position_year"] = round(usd_year, 2)
                row[f"{policy}_min_debt_usd"] = round(usd_year / (TARGET_COST_BPS_PER_YEAR / 10_000), 0)
            viability.append(row)

    return {
        "measured": {"challengeDecision": CHALLENGE_GAS, "commit_plus_reveal": COMMITTED_CHALLENGE_GAS,
                     "decideHeuristic": MEASURED["decideHeuristic"]},
        "fixed_bond_eth": MIN_BOND_ETH,
        "bond_gas_cover": BOND_GAS_COVER,
        "fixed_bond_breakeven_gwei": round(breakeven_fixed, 2),
        "fixed_bond_breakeven_committed_gwei": round(breakeven_fixed_committed, 2),
        "gas_scaled_max_basefee_rise": round(BOND_GAS_COVER / CHALLENGE_GAS, 2),
        "gas_scaled_max_basefee_rise_committed": round(BOND_GAS_COVER / COMMITTED_CHALLENGE_GAS, 2),
        "table": rows,
        "assumptions": {"eth_usd": ETH_USD, "target_cost_bps_per_year": TARGET_COST_BPS_PER_YEAR,
                        "decision_cadence": "one decision per position per day (hf_baseline)"},
        "gas_per_position_day": per_day,
        "viability": viability,
    }


def _markdown(r: dict) -> str:
    t = "\n".join(
        f"| {x['gas_price_gwei']} | {x['challenge_cost_eth']:.4f} | {x['fixed_bond_profit_eth']:+.4f} | "
        f"{x['gas_scaled_bond_eth']:.4f} | {x['gas_scaled_profit_eth']:+.4f} |" for x in r["table"])
    v = "\n".join(
        f"| {x['network']} | ${x['trusttier_usd_per_position_year']:,.2f} | ${x['trusttier_min_debt_usd']:,.0f} | "
        f"${x['always_zk_usd_per_position_year']:,.2f} | ${x['always_zk_min_debt_usd']:,.0f} |" for x in r["viability"])
    a = r["assumptions"]
    return f"""# Bond economics

`python -m evaluation.bond_economics` - measured gas: a challenge costs {r['measured']['challengeDecision']:,} gas
({r['measured']['commit_plus_reveal']:,} through commit-reveal).

**Fixed 0.01 ETH bond.** Challenging a false claim loses money above
**{r['fixed_bond_breakeven_gwei']} gwei** ({r['fixed_bond_breakeven_committed_gwei']} gwei with commit-reveal), so at
ordinary L1 gas prices nobody has a reason to watch.

**Gas-scaled bond** (`max(MIN_BOND, {r['bond_gas_cover']:,} x basefee)`, what the engine enforces now): the bond
covers a challenge at any gas price, and stays profitable as long as the base fee at
challenge time is under **{r['gas_scaled_max_basefee_rise']}x** the base fee at the claim
({r['gas_scaled_max_basefee_rise_committed']}x with commit-reveal).

| gas price (gwei) | challenge cost (ETH) | fixed-bond profit (ETH) | gas-scaled bond (ETH) | gas-scaled profit (ETH) |
|---|---|---|---|---|
{t}

## When is daily monitoring affordable?

TrustTier's decision gas per position-day comes from `hf_baseline.json`
({r['gas_per_position_day']['trusttier']:,} gas, vs {r['gas_per_position_day']['always_zk']:,} for always-zk). At
ETH = ${a['eth_usd']:,.0f}, the smallest debt for which a year of daily decisions costs
under {a['target_cost_bps_per_year'] / 100:.1f}% of the debt:

| network | TrustTier $/position/year | min. debt | always-zk $/position/year | min. debt |
|---|---|---|---|---|
{v}

On L1 the scheme only pays for large positions (or a slower cadence, e.g.
re-deciding Tier-0 positions weekly); on a rollup it is cheap enough for
ordinary retail positions. That is the deployment target this analysis argues for.
"""


def main():
    r = run()
    with open(os.path.join(RESULTS, "bond_economics.json"), "w") as f:
        json.dump(r, f, indent=2)
    with open(os.path.join(RESULTS, "bond_economics.md"), "w") as f:
        f.write(_markdown(r))
    print(_markdown(r))


if __name__ == "__main__":
    main()
