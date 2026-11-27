"""
How hard should a pre-emptive (soft) liquidation hit? The stress test of
evaluation/hf_baseline.py, re-run with gentler terms for TrustTier's soft
liquidations only (the protocol's own rule keeps 50% / 5%):

  same as the protocol   close 50% of the debt, 5% bonus   (the demo pool)
  gentle                 close 20% of the debt, 2% bonus
  minimal                close 10% of the debt, 1% bonus

For each: forced liquidations, insolvencies, bad debt, total bonus paid by
borrowers, soft liquidations and how many were unnecessary, and what one
unnecessary soft liquidation costs its borrower (share of debt).

Run from off-chain/:
    python -m evaluation.soft_liquidation
Writes results/soft_liquidation.{json,md}.
"""
import json
import os

from evaluation import hf_baseline as hb

RESULTS = os.path.join(os.path.dirname(__file__), "results")
TERMS = {"same_as_protocol": (0.5, 0.05), "gentle": (0.2, 0.02), "minimal": (0.1, 0.01)}
KEYS = ("forced_liquidations", "insolvent_positions", "bad_debt_pct_of_debt", "borrower_bonus_paid_pct_of_debt",
        "soft_liquidations", "positions_soft_liquidated", "unnecessary_soft_liquidations")


def main():
    out = {}
    for name, (cf, bonus) in TERMS.items():
        hb.SOFT_CLOSE_FACTOR, hb.SOFT_BONUS = cf, bonus
        rep = hb.run()
        tt = rep["policies"]["trusttier"]
        out[name] = {"close_factor": cf, "bonus": bonus,
                     "cost_of_one_unnecessary_soft_liquidation_pct_of_debt": round(100 * cf * bonus, 2),
                     **{k: tt[k] for k in KEYS},
                     "ten_scenarios_mean_bad_debt_pct": rep["seeds"]["trusttier"]["bad_debt_pct_of_debt"]["mean"]}
        if name == "same_as_protocol":
            hf = rep["policies"]["hf_rule"]
            out["hf_rule"] = {k: hf[k] for k in KEYS} | {"ten_scenarios_mean_bad_debt_pct": rep["seeds"]["hf_rule"]["bad_debt_pct_of_debt"]["mean"]}
    hb.SOFT_CLOSE_FACTOR, hb.SOFT_BONUS = hb.CLOSE_FACTOR, hb.BONUS
    os.makedirs(RESULTS, exist_ok=True)
    with open(os.path.join(RESULTS, "soft_liquidation.json"), "w") as f:
        json.dump(out, f, indent=2)
    lines = ["# Soft-liquidation terms", "", "`python -m evaluation.soft_liquidation`", "",
             "| policy | forced | insolvent | bad debt % | bonus paid % | soft (positions, unnecessary) | cost of one unnecessary soft liq. (% of debt) | 10-scenario bad debt % |",
             "|---|---|---|---|---|---|---|---|"]
    for k, v in out.items():
        lines.append(f"| {k} | {v['forced_liquidations']} | {v['insolvent_positions']} | {v['bad_debt_pct_of_debt']} | "
                     f"{v['borrower_bonus_paid_pct_of_debt']} | {v['soft_liquidations']} ({v['positions_soft_liquidated']}, {v['unnecessary_soft_liquidations']}) | "
                     f"{v.get('cost_of_one_unnecessary_soft_liquidation_pct_of_debt', '-')} | {v['ten_scenarios_mean_bad_debt_pct']} |")
    with open(os.path.join(RESULTS, "soft_liquidation.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
