"""
Sensitivity of TrustTier's results to its two design constants: the tier
bands (Tier 0 needs delta > B0, Tier 1 needs delta > B1; contract:
TIER0_MIN_DELTA_BPS / TIER1_MIN_DELTA_BPS) and, for the synthetic stream, the
fixed liquidation threshold (0.80).

Same replay as evaluate.py (374 positions: 74 real Aave V2 snapshots with
their own thresholds + 300 synthetic), same measured gas, same escalation
rule. The model's verdict does not depend on the bands, so it is computed
once per position and the grid is pure bookkeeping.

For each setting it reports:
  saving      gas saved vs always-Tier-2 (higher = cheaper)
  t0_flagged  Tier-0 positions the model flags high risk: cheap claims with
              no model check behind them, covered only by the challenge
              window (lower = safer)
  t0_share    share of positions that get a Tier-0 claim
  escalated   Tier-1 positions escalated to Tier 2 by the model check
  shock_exposed  cheap (Tier 0/1) claims on positions that a sudden 5%
              collateral price drop would push past the liquidation
              threshold within the challenge window (lower = safer). This is
              what the Tier-1 band B1 buys: a safety margin near the boundary.

Run from off-chain/:
    python -m evaluation.band_sensitivity
Writes results/band_sensitivity.{json,md} and results/band_sensitivity.tex.
"""

import json
import os

from evaluation.cost_model import GAS_BY_TIER, TIER2_GAS
from evaluation.real_data import load_real_positions
from risk_model.inference import RiskModel
from router.position_stream import generate_position_stream

RESULTS = os.path.join(os.path.dirname(__file__), "results")
B0_GRID = [0.05, 0.08, 0.10, 0.12, 0.15, 0.20, 0.25, 0.30]
B1_GRID = [0.00, 0.02, 0.05, 0.08, 0.10]
THRESHOLDS = [0.70, 0.75, 0.80, 0.85]
CHOSEN = (0.15, 0.05)
# Stress assumption for the 1-hour challenge window: a sudden 5% fall in the
# collateral price (a severe but observed hourly move in crypto markets).
SHOCK = 0.05
TOP_Y = 46  # y position of the flagged-count labels in the figure


def scored(positions, model, threshold_of):
    out = []
    for p in positions:
        f = p.to_features()
        label, _ = model.predict(f)
        th = threshold_of(p)
        out.append({"delta": th - f["ltv"], "high": label == 1,
                    # would a sudden collateral price drop of SHOCK push it past its threshold?
                    "shock_crosses": f["ltv"] / (1 - SHOCK) >= th})
    return out


def route(rows, b0, b1):
    tiers, t0_flagged, escalated, exposed = [], 0, 0, 0
    for r in rows:
        if r["delta"] > b1 and r["shock_crosses"] and not (b1 < r["delta"] <= b0 and r["high"]):
            exposed += 1  # a cheap claim stands on it, yet a 5% drop breaches it
        if r["delta"] > b0:
            tier = "HEURISTIC"
            t0_flagged += r["high"]
        elif r["delta"] > b1:
            tier = "ZK_PROOF" if r["high"] else "COMMITMENT"
            escalated += r["high"]
        else:
            tier = "ZK_PROOF"
        tiers.append(tier)
    n = len(rows)
    gas = sum(GAS_BY_TIER[t] for t in tiers)
    t0 = tiers.count("HEURISTIC")
    return {
        "b0": b0, "b1": b1, "n": n,
        "tiers": [t0, tiers.count("COMMITMENT"), tiers.count("ZK_PROOF")],
        "saving_pct": round(100 * (1 - gas / (n * TIER2_GAS)), 1),
        "t0_share_pct": round(100 * t0 / n, 1),
        "t0_flagged": t0_flagged,
        "t0_flagged_pct": round(100 * t0_flagged / t0, 1) if t0 else 0.0,
        "flagged_unverified_pct": round(100 * t0_flagged / max(1, sum(r["high"] for r in rows)), 1),
        "escalated": escalated,
        "shock_exposed": exposed,
    }


def main():
    model = RiskModel()
    real = scored(load_real_positions(), model, lambda p: p.liquidation_threshold)
    synth_positions = generate_position_stream(n_positions=300, seed=99)

    synth = scored(synth_positions, model, lambda p: 0.80)
    grid = [route(real + synth, b0, b1) for b0 in B0_GRID for b1 in B1_GRID if b1 < b0]
    chosen = next(g for g in grid if (g["b0"], g["b1"]) == CHOSEN)

    # Pareto front over (saving up, flagged Tier-0 claims down, shock-exposed claims down).
    def dominates(h, g):
        ge = (h["saving_pct"] >= g["saving_pct"] and h["t0_flagged"] <= g["t0_flagged"]
              and h["shock_exposed"] <= g["shock_exposed"])
        gt = (h["saving_pct"] > g["saving_pct"] or h["t0_flagged"] < g["t0_flagged"]
              or h["shock_exposed"] < g["shock_exposed"])
        return ge and gt
    pareto = [g for g in grid if not any(dominates(h, g) for h in grid)]
    for g in grid:
        g["pareto"] = g in pareto

    thresholds = []
    for th in THRESHOLDS:
        s = scored(synth_positions, model, lambda p, th=th: th)
        thresholds.append({"threshold": th, **route(real + s, *CHOSEN)})

    with open(os.path.join(RESULTS, "band_sensitivity.json"), "w") as f:
        json.dump({"grid": grid, "thresholds": thresholds, "chosen": chosen,
                   "model_flagged_total": sum(r["high"] for r in real + synth)}, f, indent=2)
    write_markdown(grid, thresholds, chosen)
    write_latex(grid, thresholds, chosen)
    print(f"chosen {CHOSEN}: {chosen}")
    print(f"pareto: {[(g['b0'], g['b1'], g['saving_pct'], g['t0_flagged'], g['shock_exposed']) for g in pareto]}")


def write_markdown(grid, thresholds, chosen):
    lines = ["# Tier-band sensitivity", "",
             "Generated by `off-chain/evaluation/band_sensitivity.py` (374 positions, measured gas).", "",
             "| Tier-0 band B0 | Tier-1 band B1 | Tiers 0/1/2 | Saving | Tier-0 flagged by model | Cheap claims a 5% drop breaches | Escalated | Pareto |",
             "|---|---|---|---|---|---|---|---|"]
    for g in grid:
        mark = " **(chosen)**" if g is chosen else ""
        lines.append(f"| {g['b0']:.2f} | {g['b1']:.2f}{mark} | {'/'.join(map(str, g['tiers']))} | "
                     f"{g['saving_pct']}% | {g['t0_flagged']} ({g['t0_flagged_pct']}%) | {g['shock_exposed']} | {g['escalated']} | "
                     f"{'yes' if g['pareto'] else ''} |")
    lines += ["", "## Synthetic liquidation threshold (bands fixed at 0.15 / 0.05)", "",
              "| Threshold | Tiers 0/1/2 | Saving | Tier-0 flagged | Cheap claims a 5% drop breaches |", "|---|---|---|---|---|"]
    for t in thresholds:
        lines.append(f"| {t['threshold']:.2f} | {'/'.join(map(str, t['tiers']))} | {t['saving_pct']}% | "
                     f"{t['t0_flagged']} ({t['t0_flagged_pct']}%) | {t['shock_exposed']} |")
    with open(os.path.join(RESULTS, "band_sensitivity.md"), "w") as f:
        f.write("\n".join(lines) + "\n")


def write_latex(grid, thresholds, chosen):
    """A pgfplots figure (saving vs flagged Tier-0 claims, one line per B1)
    and a threshold table, data inline so the .tex compiles on its own."""
    style = {0.00: ("tiertwo", "*"), 0.02: ("tierone", "square*"), 0.05: ("tierzero", "triangle*"),
             0.08: ("accent", "diamond*"), 0.10: ("muted", "pentagon*")}
    plots = []
    for b1 in B1_GRID:
        pts = [g for g in grid if g["b1"] == b1]
        color, mark = style[b1]
        coords = " ".join(f"({g['b0']},{g['saving_pct']})" for g in pts)
        plots.append(f"\\addplot[color={color}, mark={mark}, mark size=1.6pt] coordinates {{{coords}}};\n"
                     f"\\addlegendentry{{$B_1={b1:.2f}$: {pts[0]['shock_exposed']} exposed}}")
    flagged = {g["b0"]: g["t0_flagged"] for g in grid}
    labels = "\n".join(f"\\node[font=\\scriptsize, text=tiertwo] at (axis cs:{b0},{TOP_Y}) {{{n}}};"
                        for b0, n in sorted(flagged.items()))
    rows = " \\\\\n".join(
        f"{t['threshold']:.2f} & {t['tiers'][0]}/{t['tiers'][1]}/{t['tiers'][2]} & {t['saving_pct']}\\% & {t['t0_flagged']} & {t['shock_exposed']}"
        for t in thresholds)
    tex = f"""% Generated by off-chain/evaluation/band_sensitivity.py - do not edit by hand.
% Needs pgfplots, booktabs and the paper's tierzero/tierone/tiertwo/accent/muted colors.
\\begin{{figure}}[t]
\\centering
\\begin{{tikzpicture}}
\\begin{{axis}}[
  width=0.92\\columnwidth, height=5.4cm,
  xlabel={{Tier-0 band $B_0$ (Tier~0 needs $\\delta > B_0$)}},
  ylabel={{Gas saving vs.\\ always-Tier-2 (\\%)}},
  ymin=27, ymax={TOP_Y + 2}, xmin=0.03, xmax=0.32,
  xtick={{0.05,0.10,0.15,0.20,0.25,0.30}},
  xticklabel style={{/pgf/number format/fixed, /pgf/number format/precision=2}},
  clip=false,
  legend columns=2,
  legend style={{font=\\scriptsize, at={{(0.5,-0.30)}}, anchor=north, draw=none, column sep=6pt}},
  tick label style={{font=\\scriptsize}}, label style={{font=\\small}},
  grid=major, grid style={{gray!20}}]
{chr(10).join(plots)}
{labels}
\\draw[dashed, gray] (axis cs:0.03,{TOP_Y - 1}) -- (axis cs:0.32,{TOP_Y - 1});
\\node[draw, circle, inner sep=2.6pt, thick] at (axis cs:{chosen['b0']},{chosen['saving_pct']}) {{}};
\\node[font=\\scriptsize, anchor=north] at (axis cs:{chosen['b0']},{chosen['saving_pct'] - 0.4}) {{chosen}};
\\end{{axis}}
\\end{{tikzpicture}}
\\caption{{Gas saving over 374 positions as the tier bands vary. Red numbers along the top: Tier-0
claims the model would flag high risk at each $B_0$ (independent of $B_1$). ``Exposed'': cheap
claims that a sudden 5\\% collateral price drop would push past the liquidation threshold. The
circled point is the deployed setting ($B_0=0.15$, $B_1=0.05$).}}
\\label{{fig:band-sensitivity}}
\\end{{figure}}

\\begin{{table}}[t]
\\centering\\small
\\caption{{Sensitivity to the synthetic stream's liquidation threshold (bands fixed at 0.15/0.05; real positions keep their own thresholds).}}
\\label{{tab:threshold-sensitivity}}
\\begin{{tabular}}{{lcccc}}
\\toprule
Threshold & Tiers 0/1/2 & Saving & Tier-0 flagged & Exposed \\\\
\\midrule
{rows} \\\\
\\bottomrule
\\end{{tabular}}
\\end{{table}}
"""
    with open(os.path.join(RESULTS, "band_sensitivity.tex"), "w") as f:
        f.write(tex)


if __name__ == "__main__":
    main()
