"""
TrustTier vs. the lending protocol's own rule (the health-factor baseline).

Every lending protocol already has a free, deterministic liquidation rule:
Aave liquidates a position once its health factor drops below 1, i.e. once
LTV reaches the liquidation threshold. A reviewer's first question is why a
model-scored liquidation is needed at all. This script answers it by
simulating the same positions, on the same price paths, under three
policies:

  hf_rule      Aave's rule only. Keepers watch off-chain; a position is
               liquidated (50% close factor, 5% bonus) only once LTV >= LT.
               No decision gas, but nothing happens before the boundary.
  trusttier    TrustTier's tiers once per day per position: Tier 0 / Tier 1
               cheap claims far from the boundary, Tier 2 (a zk proof) near
               it. When the proven model says HIGH RISK, the position is
               soft-liquidated pre-emptively through TrustTierLiquidator
               (same close factor and bonus). The HF rule stays in force as
               the protocol's fallback.
  always_zk    The same pre-emptive policy, but every position's daily
               decision is a Tier-2 proof (the "prove everything" baseline,
               as in evaluate.py).

Price paths are a daily geometric random walk per position with the
position's own 30-day volatility (daily sigma = vol30 / sqrt(30)), a common
market factor (correlation RHO) and rare market-wide crash days, over a
HORIZON_DAYS horizon. Debt is constant (no interest), collateral amounts
change only through liquidations, and borrowers never top up - a stress
test, not a forecast. The model sees exactly the quantized on-chain features
(LiquidationEngine arithmetic) and runs through the same ONNX file the
circuit is compiled from.

What it measures, per policy:
  - forced liquidations: liquidations at LTV >= LT (the borrower pays the
    bonus on half the debt, at the worst moment);
  - insolvencies and bad debt: LTV >= 1 before any liquidation could help,
    the loss the protocol (its lenders) absorbs;
  - pre-emptive soft liquidations, and how many were unnecessary
    (the no-intervention path never reached LT within the horizon);
  - decision gas (measured, evaluation/cost_model.py).

    python -m evaluation.hf_baseline          -> results/hf_baseline.{json,md}
"""

from __future__ import annotations

import json
import os

import numpy as np
import onnxruntime as ort

from evaluation.cost_model import GAS_BY_TIER, LIQUIDATE_GAS

RESULTS = os.path.join(os.path.dirname(__file__), "results")
ONNX = os.path.join(os.path.dirname(__file__), "..", "risk_model", "artifacts", "risk_model.onnx")

N_POSITIONS = 3000
HORIZON_DAYS = 30
LT = 0.80                    # liquidation threshold
CLOSE_FACTOR = 0.5
BONUS = 0.05
RHO = 0.6                    # weight of the common market factor
CRASH_PROB = 0.02            # chance per day of a market-wide crash
CRASH_RANGE = (0.12, 0.30)   # size of a crash day
SEED = 7

T0_MIN, T1_MIN = 0.15, 0.05  # tier bands on delta (LiquidationEngine)


def _quantize(ltv, vol, mom, topup_days, age_days):
    """Vectorized mirror of LiquidationEngine.currentFeatures (floors included)."""
    q = np.empty((len(ltv), 5), dtype=np.int64)
    q[:, 0] = np.minimum(np.floor(ltv * 2048 / 3), 1024)
    q[:, 1] = np.minimum(np.floor(vol * 1024), 1024)
    q[:, 2] = np.minimum(np.floor((1 + mom) * 512), 1024)
    q[:, 3] = np.floor(np.minimum(np.floor(topup_days), 90) * 1024 / 90)
    q[:, 4] = np.floor(np.minimum(np.floor(age_days), 2000) * 1024 / 2000)
    return np.clip(q, 0, 1024)


class _Model:
    def __init__(self):
        self.s = ort.InferenceSession(ONNX, providers=["CPUExecutionProvider"])
        self.name = self.s.get_inputs()[0].name

    def label(self, q):
        if len(q) == 0:
            return np.zeros(0, dtype=bool)
        labels, _ = self.s.run(None, {self.name: (q / 1024).astype(np.float32)})
        return np.asarray(labels).reshape(-1) == 1


def _paths(rng, vol):
    n = len(vol)
    sigma = vol / np.sqrt(30)
    market = rng.standard_normal(HORIZON_DAYS)
    idio = rng.standard_normal((n, HORIZON_DAYS))
    z = RHO * market[None, :] + np.sqrt(1 - RHO ** 2) * idio
    r = -0.5 * sigma[:, None] ** 2 + sigma[:, None] * z
    crash = rng.random(HORIZON_DAYS) < CRASH_PROB
    sizes = rng.uniform(*CRASH_RANGE, HORIZON_DAYS)
    r += np.where(crash, np.log(1 - sizes), 0.0)[None, :]
    return np.exp(np.cumsum(r, axis=1))  # price relative to day 0, shape (n, days)


def _positions(rng):
    ltv = rng.uniform(0.40, 0.79, N_POSITIONS)
    vol = rng.uniform(0.02, 0.60, N_POSITIONS)
    topup = rng.exponential(15.0, N_POSITIONS).clip(0, 90)
    age = rng.uniform(1, 2000, N_POSITIONS)
    return ltv, vol, topup, age


def _liquidate(coll, debt, idx, price):
    """Close CLOSE_FACTOR of debt at `price`, seizing repaid * (1 + BONUS) of
    collateral value. Returns the bonus paid by each borrower (USD)."""
    repaid = debt[idx] * CLOSE_FACTOR
    seized_value = np.minimum(repaid * (1 + BONUS), coll[idx] * price[idx])
    coll[idx] -= seized_value / price[idx]
    debt[idx] -= repaid
    return seized_value - repaid


def simulate(policy: str, model: _Model, ltv0, vol, topup0, age0, rel_price):
    n = len(ltv0)
    coll = np.ones(n)                    # collateral units; price 1.0 at day 0
    debt = ltv0.copy()                   # USD; ltv0 * collateral value
    alive = np.ones(n, dtype=bool)
    out = dict(forced_liquidations=0, insolvent_positions=0, bad_debt=0.0, borrower_bonus_paid=0.0,
               soft_liquidations=0, soft_positions=set(), gas=0, tier_counts={"HEURISTIC": 0, "COMMITMENT": 0,
               "ZK_PROOF": 0}, proofs=0)
    prev = np.ones(n)
    for d in range(HORIZON_DAYS):
        price = rel_price[:, d]
        mom = price / prev - 1
        prev = price
        value = coll * price
        ltv = np.where(value > 0, debt / np.maximum(value, 1e-12), 0)

        # Insolvency: the position is under water before anyone can act.
        under = alive & (ltv >= 1.0) & (debt > 0)
        out["insolvent_positions"] += int(under.sum())
        out["bad_debt"] += float((debt[under] - value[under]).sum())
        alive &= ~under

        if policy != "hf_rule":
            live = np.where(alive & (debt > 0))[0]
            delta = LT - ltv[live]
            q = _quantize(ltv[live], vol[live], mom[live], topup0[live] + d, age0[live] + d)
            flags = model.label(q)
            if policy == "always_zk":
                tier2 = np.ones(len(live), dtype=bool)
            else:
                tier2 = delta <= T1_MIN
                tier1 = (delta > T1_MIN) & (delta <= T0_MIN)
                escalate = tier1 & flags        # router never makes a claim its watcher could slash
                tier2 |= escalate
                n_t1 = int((tier1 & ~escalate).sum())
                n_t0 = int((delta > T0_MIN).sum())
                out["tier_counts"]["COMMITMENT"] += n_t1
                out["tier_counts"]["HEURISTIC"] += n_t0
                out["gas"] += n_t1 * GAS_BY_TIER["COMMITMENT"] + n_t0 * GAS_BY_TIER["HEURISTIC"]
            # Tier-2 decisions are charged a full proof's gas whether or not the
            # proof shows high risk (as in evaluate.py: conservative for
            # TrustTier, since a low-risk proof is not submitted); a
            # high-risk one is also executed through TrustTierLiquidator.
            act = tier2 & flags
            out["proofs"] += int(tier2.sum())
            out["tier_counts"]["ZK_PROOF"] += int(tier2.sum())
            idx = live[act & (ltv[live] < LT)]  # pre-emptive (the HF rule handles LTV >= LT)
            out["gas"] += int(tier2.sum()) * GAS_BY_TIER["ZK_PROOF"] + len(idx) * LIQUIDATE_GAS
            if len(idx):
                out["borrower_bonus_paid"] += float(_liquidate(coll, debt, idx, price).sum())
                out["soft_liquidations"] += len(idx)
                out["soft_positions"].update(int(i) for i in idx)

        # The protocol's own rule, in force under every policy.
        value = coll * price
        ltv = np.where(value > 0, debt / np.maximum(value, 1e-12), 0)
        hf = np.where(alive & (debt > 0) & (ltv >= LT))[0]
        if len(hf):
            out["borrower_bonus_paid"] += float(_liquidate(coll, debt, hf, price).sum())
            out["forced_liquidations"] += len(hf)
    return out


def run(seed: int = SEED) -> dict:
    rng = np.random.default_rng(seed)
    ltv0, vol, topup0, age0 = _positions(rng)
    rel = _paths(rng, vol)
    model = _Model()
    initial_debt = float(ltv0.sum())
    # Counterfactual: does the untouched position ever reach LT?
    would_hit = (ltv0[:, None] / rel >= LT).any(axis=1)

    report = {"setup": {
        "positions": N_POSITIONS, "horizon_days": HORIZON_DAYS, "liquidation_threshold": LT,
        "close_factor": CLOSE_FACTOR, "bonus": BONUS, "market_correlation": RHO,
        "crash_prob_per_day": CRASH_PROB, "crash_range": CRASH_RANGE, "seed": seed,
        "positions_reaching_LT_without_action": int(would_hit.sum()),
    }, "policies": {}}
    for policy in ("hf_rule", "trusttier", "always_zk"):
        r = simulate(policy, model, ltv0, vol, topup0, age0, rel)
        soft = r.pop("soft_positions")
        unnecessary = sum(1 for i in soft if not would_hit[i])
        r["bad_debt_pct_of_debt"] = round(100 * r["bad_debt"] / initial_debt, 3)
        r["bad_debt"] = round(r["bad_debt"], 4)
        r["borrower_bonus_paid_pct_of_debt"] = round(100 * r["borrower_bonus_paid"] / initial_debt, 3)
        r["borrower_bonus_paid"] = round(r["borrower_bonus_paid"], 4)
        r["positions_soft_liquidated"] = len(soft)
        r["unnecessary_soft_liquidations"] = unnecessary
        r["gas_per_position_day"] = round(r["gas"] / (N_POSITIONS * HORIZON_DAYS))
        report["policies"][policy] = r
    tt, az = report["policies"]["trusttier"], report["policies"]["always_zk"]
    report["trusttier_gas_saving_vs_always_zk_pct"] = round(100 * (1 - tt["gas"] / az["gas"]), 1) if az["gas"] else None
    report["seeds"] = _seed_sweep(model) if seed == SEED else None
    return report


def _seed_sweep(model, seeds=range(1, 11)) -> dict:
    """The headline numbers over ten independent scenarios (mean, min, max)."""
    keys = ("forced_liquidations", "insolvent_positions", "bad_debt_pct_of_debt")
    acc = {p: {k: [] for k in keys} for p in ("hf_rule", "trusttier")}
    for s in seeds:
        rng = np.random.default_rng(1000 + s)
        ltv0, vol, topup0, age0 = _positions(rng)
        rel = _paths(rng, vol)
        initial = float(ltv0.sum())
        for p in acc:
            r = simulate(p, model, ltv0, vol, topup0, age0, rel)
            acc[p]["forced_liquidations"].append(r["forced_liquidations"])
            acc[p]["insolvent_positions"].append(r["insolvent_positions"])
            acc[p]["bad_debt_pct_of_debt"].append(100 * r["bad_debt"] / initial)
    return {p: {k: {"mean": round(float(np.mean(v)), 3), "min": round(float(np.min(v)), 3),
                    "max": round(float(np.max(v)), 3)} for k, v in d.items()} for p, d in acc.items()}


def _markdown(r: dict) -> str:
    s = r["setup"]
    rows = []
    for name, p in r["policies"].items():
        rows.append(f"| {name} | {p['forced_liquidations']} | {p['insolvent_positions']} | "
                    f"{p['bad_debt_pct_of_debt']}% | {p['borrower_bonus_paid_pct_of_debt']}% | "
                    f"{p['soft_liquidations']} ({p['unnecessary_soft_liquidations']} unnecessary) | "
                    f"{p['gas'] / 1e6:,.1f} M | {p['gas_per_position_day']:,} |")
    sweep = r.get("seeds") or {}
    sweep_rows = []
    for name, d in sweep.items():
        sweep_rows.append(f"| {name} | {d['forced_liquidations']['mean']} | {d['insolvent_positions']['mean']} | "
                          f"{d['bad_debt_pct_of_debt']['mean']}% ({d['bad_debt_pct_of_debt']['min']}-"
                          f"{d['bad_debt_pct_of_debt']['max']}) |")
    return f"""# TrustTier vs. the health-factor rule

`python -m evaluation.hf_baseline` - {s['positions']} positions, {s['horizon_days']} daily steps,
LT {s['liquidation_threshold']}, close factor {s['close_factor']}, bonus {s['bonus']}, market
correlation {s['market_correlation']}, crash probability {s['crash_prob_per_day']}/day
(size {s['crash_range'][0]:.0%}-{s['crash_range'][1]:.0%}), seed {s['seed']}.
{s['positions_reaching_LT_without_action']} positions reach the threshold if nobody acts.

| policy | forced liquidations (LTV >= LT) | insolvencies | bad debt (% of debt) | bonus paid by borrowers (% of debt) | pre-emptive soft liquidations | decision gas | gas / position-day |
|---|---|---|---|---|---|---|---|
{chr(10).join(rows)}

TrustTier's decision gas is {r['trusttier_gas_saving_vs_always_zk_pct']}% below proving every position
every day, for the same pre-emptive protection near the boundary.

Over ten further independent scenarios (mean, and the bad-debt range):

| policy | forced liquidations | insolvencies | bad debt (% of debt) |
|---|---|---|---|
{chr(10).join(sweep_rows)}

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
"""


def main():
    r = run()
    os.makedirs(RESULTS, exist_ok=True)
    with open(os.path.join(RESULTS, "hf_baseline.json"), "w") as f:
        json.dump(r, f, indent=2)
    with open(os.path.join(RESULTS, "hf_baseline.md"), "w") as f:
        f.write(_markdown(r))
    print(_markdown(r))


if __name__ == "__main__":
    main()
