"""
TrustTier on REAL Aave V2 positions (evaluation/aave_real.py output).

Every position-day is routed exactly as the contract would route it: delta =
liquidation threshold - LTV from Aave's own account data, the bands from the
volatility feature (adaptive) or fixed at 15% / 5%, and the deployed model
(risk_model/artifacts) escalating a Tier-1 position it flags. Gas per tier is
the measured gas (results/gas_measurements.json).

Measures
  cost       tier mix and total decision gas vs proving every position
  safety     cheap "safe" claims (Tier 0/1, not escalated) on positions that
             actually became liquidatable (health factor < 1) within 1 and 7
             days: the claims a watcher would have to slash
  warning    liquidated accounts: the earliest day before first becoming
             liquidatable on which TrustTier would have approved a soft
             liquidation (Tier-2 proof that the model says high risk)
  false alarms  approved soft liquidations on position-days that did not
             become liquidatable within 7 days (random sample)

Run from off-chain/:
    python -m evaluation.aave_eval
Writes results/aave_eval.{json,md}.
"""

from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd

from risk_model.features import FEATURE_NAMES, normalize_vector
from risk_model.inference import RiskModel
from router.tiering import tier_bands_bps

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
POSITIONS = os.path.join(HERE, "data", "aave_v2_positions.parquet")
GAS = json.load(open(os.path.join(RESULTS, "gas_measurements.json")))
G = {0: GAS["decideHeuristic"], 1: GAS["decideCommitment"] + GAS["revealCommitment"], 2: GAS["decideZkProof"]}
FIXED = (1500, 500)


def route(df, adaptive=True):
    """Weakest allowed tier per row, then model escalation of Tier 1."""
    qvol = (df.collateral_volatility_30d.clip(0, 1) * 1024).astype(int).values
    if adaptive:
        bands = np.array([tier_bands_bps(int(v)) for v in qvol])
        b0, b1 = bands[:, 0], bands[:, 1]
    else:
        b0, b1 = np.full(len(df), FIXED[0]), np.full(len(df), FIXED[1])
    d = (df.delta.values * 10_000).round().astype(int)
    tier = np.where(d > b0, 0, np.where(d > b1, 1, 2))
    escalated = (tier == 1) & (df.model_label.values == 1)
    tier = np.where(escalated, 2, tier)
    return tier, escalated


def future_min_hf(df, days):
    out = np.full(len(df), np.inf)
    idx = {}
    for i, (u, d) in enumerate(zip(df.user.values, df.day.values)):
        idx[(u, d)] = i
    hf = df.health_factor.values
    for i, (u, d) in enumerate(zip(df.user.values, df.day.values)):
        m = np.inf
        for k in range(1, days + 1):
            j = idx.get((u, d + k))
            if j is not None:
                m = min(m, hf[j])
        out[i] = m
    return out


def main():
    df = pd.read_parquet(POSITIONS)
    model = RiskModel()
    X = [normalize_vector(r) for r in df[FEATURE_NAMES].values.tolist()]
    q = [[int(round(v * 1024)) for v in x] for x in X]
    preds = [model.predict_q(qq) for qq in q]
    df["model_label"] = [p[0] for p in preds]
    df["p_high"] = [p[1][1] for p in preds]
    df["liq_1d"] = future_min_hf(df, 1) < 1.0
    df["liq_7d"] = future_min_hf(df, 7) < 1.0
    live = df[df.health_factor >= 1.0]  # positions not yet liquidatable

    report = {"positions": int(len(df)), "accounts": int(df.user.nunique()),
              "samples": {s: {"positions": int(len(g)), "accounts": int(g.user.nunique())} for s, g in df.groupby("sample")},
              "gas_per_tier": G, "policies": {}}
    for name, adaptive in (("adaptive", True), ("fixed_15_5", False)):
        r = {}
        for s, g in live.groupby("sample"):
            tier, esc = route(g, adaptive)
            gas = sum(G[t] for t in tier)
            all_zk = len(g) * G[2]
            cheap = tier < 2
            r[s] = {
                "rows": int(len(g)),
                "tiers": [int((tier == k).sum()) for k in range(3)],
                "escalated": int(esc.sum()),
                "gas_M": round(gas / 1e6, 1), "always_zk_gas_M": round(all_zk / 1e6, 1),
                "saving_pct": round(100 * (1 - gas / all_zk), 1),
                "cheap_claims_liquidatable_1d": int((cheap & g.liq_1d.values).sum()),
                "cheap_claims_liquidatable_7d": int((cheap & g.liq_7d.values).sum()),
                "liquidatable_7d_rows": int(g.liq_7d.sum()),
            }
        report["policies"][name] = r

    # Early warning on liquidated accounts (adaptive bands), and approvals on
    # the random sample: TrustTier (Tier 2 AND the proven model says high risk)
    # against a model-free rule that approves whenever delta is in the Tier-2
    # band. The health-factor rule itself acts only at HF < 1 (zero lead).
    tier, _ = route(df, True)
    live_now = df.health_factor.values >= 1.0
    policies = {"trusttier_model": (tier == 2) & (df.model_label.values == 1) & live_now,
                "delta_only_baseline": (tier == 2) & live_now,
                # Alhaidari et al. (AFT 2025)-style on-chain inference: the same model
                # runs on every position, with no tiers, and approves whenever it says high risk.
                "onchain_model_every_position": (df.model_label.values == 1) & live_now}
    report["early_warning"], report["false_alarms_random_sample"] = {}, {}
    for pname, approves in policies.items():
        df["approves"] = approves
        lead = []
        for u, g in df[df["sample"] == "liquidated"].groupby("user"):
            g = g.sort_values("day")
            first = g[g.health_factor < 1.0]
            if not len(first):
                continue
            d0 = int(first.day.iloc[0])
            before = g[(g.day < d0) & (g.day >= d0 - 14) & g.approves]
            lead.append(d0 - int(before.day.min()) if len(before) else 0)
        lead = np.array(lead)
        report["early_warning"][pname] = {
            "liquidated_accounts_observed": int(len(lead)),
            "flagged_at_least_1_day_before": int((lead >= 1).sum()),
            "flagged_at_least_3_days_before": int((lead >= 3).sum()),
            "median_lead_days_when_flagged": float(np.median(lead[lead >= 1])) if (lead >= 1).any() else 0.0,
        }
        rnd = df[(df["sample"] == "random") & (df.health_factor >= 1.0)]
        appr = rnd.approves.values
        report["false_alarms_random_sample"][pname] = {
            "approved_soft_liquidations": int(appr.sum()),
            "of_which_liquidatable_within_7d": int((appr & rnd.liq_7d.values).sum()),
            "position_days": int(len(rnd)),
        }
    # Ranking quality on the random sample (base rate of becoming liquidatable within 7 days).
    from sklearn.metrics import roc_auc_score
    rnd = df[(df["sample"] == "random") & (df.health_factor >= 1.0)]
    report["ranking_auc_random_sample"] = {
        "model_p_high": round(float(roc_auc_score(rnd.liq_7d, rnd.p_high)), 4),
        "minus_delta": round(float(roc_auc_score(rnd.liq_7d, -rnd.delta)), 4),
        "base_rate_7d": round(float(rnd.liq_7d.mean()), 5),
    }
    os.makedirs(RESULTS, exist_ok=True)
    with open(os.path.join(RESULTS, "aave_eval.json"), "w") as f:
        json.dump(report, f, indent=2)
    lines = ["# TrustTier on real Aave V2 positions", "", "`python -m evaluation.aave_eval`", ""]
    for pol, r in report["policies"].items():
        lines += [f"## Bands: {pol}", "", "| sample | rows | T0/T1/T2 | escalated | gas (M) | always-zk (M) | saving | cheap claims liquidatable in 1d / 7d |",
                  "|---|---|---|---|---|---|---|---|"]
        for s, v in r.items():
            lines.append(f"| {s} | {v['rows']:,} | {'/'.join(map(str, v['tiers']))} | {v['escalated']} | {v['gas_M']} | "
                         f"{v['always_zk_gas_M']} | {v['saving_pct']}% | {v['cheap_claims_liquidatable_1d']} / {v['cheap_claims_liquidatable_7d']} |")
        lines.append("")
    lines += ["## Early warning (liquidated accounts, adaptive bands)", "", json.dumps(report["early_warning"], indent=2), "",
              "## Approved soft liquidations on the random sample", "", json.dumps(report["false_alarms_random_sample"], indent=2), "",
              "## Ranking (random sample, liquidatable within 7 days)", "", json.dumps(report["ranking_auc_random_sample"], indent=2)]
    with open(os.path.join(RESULTS, "aave_eval.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
