"""
External validity: score the model against what actually happened.

The deployed model (v2) is trained on SYNTHETIC labels that are a formula of
its own inputs, so its validation accuracy says little about real risk.
This script labels REAL Aave V2 snapshots by their outcome instead:

    label(t) = 1  if the wallet's health factor falls below 1 within the
                  next HORIZON_DAYS (it became liquidatable), else 0

and reports, on those labels:
  1. the deployed model (unchanged) - is it any good on real outcomes?
  2. the health-factor rule's own early warning at the same horizon, as a
     baseline (flag when HF < HF_WARN);
  3. a candidate model retrained on outcome labels with a time split
     (train on the earliest 70% of snapshots, test on the rest), when there
     are enough wallets to make that meaningful (MIN_WALLETS).

Data: Cred Protocol's Aave V2 Health Factor Dataset
(https://github.com/credprotocol/Aave-V2-Health-Factor-Dataset). The repo
ships one sample wallet (data/aave_v2_wallet_*.csv, used by default). The
complete dataset (35,524 wallets, 1.9 GB) is a Dropbox download that the
development sandbox could not reach; on your own machine:

    wget -O aave-v2-hf-complete.csv.zip \\
      "https://www.dropbox.com/s/bbkmwh8skt6w5d8/aave-v2-health-factor-complete.csv.zip?dl=1"
    unzip aave-v2-hf-complete.csv.zip -d data/cred_full
    python -m evaluation.outcome_labels --data data/cred_full

`--data` takes a CSV, or a directory of CSVs. A file holding several wallets
needs an address column (address / wallet / user / account); a file without
one is treated as a single wallet. The candidate model is written to
risk_model/artifacts/candidate/ and is NOT deployed: deploying it means
rebuilding the circuit (circuits/build_circuit.py) and registering its hash.

    python -m evaluation.outcome_labels      -> results/outcome_labels.{json,md}
"""

from __future__ import annotations

import argparse
import glob
import json
import os

import numpy as np
import pandas as pd

from evaluation.real_data import DATA_PATH, positions_from_frame
from risk_model.features import FEATURE_NAMES, normalize_vector
from risk_model.inference import RiskModel

RESULTS = os.path.join(os.path.dirname(__file__), "results")
HORIZON_DAYS = 7
HF_WARN = 1.15
MIN_WALLETS = 20
ADDRESS_COLUMNS = ("address", "wallet", "user", "account")


def _wallet_frames(path: str):
    files = sorted(glob.glob(os.path.join(path, "*.csv"))) if os.path.isdir(path) else [path]
    for f in files:
        for chunk_df in [pd.read_csv(f)]:
            col = next((c for c in ADDRESS_COLUMNS if c in chunk_df.columns), None)
            if col is None:
                yield os.path.splitext(os.path.basename(f))[0], chunk_df
            else:
                for addr, g in chunk_df.groupby(col):
                    yield str(addr), g


def build_dataset(path: str) -> pd.DataFrame:
    rows = []
    for wallet, df in _wallet_frames(path):
        df = df[df["total_debt_eth"] > 0]
        if len(df) < 3:
            continue
        positions = positions_from_frame(df)
        times = pd.to_datetime([p.timestamp for p in positions])
        hfs = np.array([p.health_factor for p in positions])
        for i, p in enumerate(positions):
            window = (times > times[i]) & (times <= times[i] + pd.Timedelta(days=HORIZON_DAYS))
            if not window.any() and i == len(positions) - 1:
                continue  # no future to label
            rows.append({"wallet": wallet, "timestamp": times[i], "hf": p.health_factor,
                         **p.to_features(), "label": int((hfs[window] < 1.0).any())})
    return pd.DataFrame(rows)


def _metrics(y, score, flag) -> dict:
    from sklearn.metrics import precision_score, recall_score, roc_auc_score
    out = {"n": int(len(y)), "positives": int(y.sum()),
           "precision": round(float(precision_score(y, flag, zero_division=0)), 3),
           "recall": round(float(recall_score(y, flag, zero_division=0)), 3)}
    out["roc_auc"] = round(float(roc_auc_score(y, score)), 3) if 0 < y.sum() < len(y) else None
    return out


def run(path: str) -> dict:
    data = build_dataset(path)
    model = RiskModel()
    x = np.array([normalize_vector([r[n] for n in FEATURE_NAMES]) for _, r in data.iterrows()], dtype=np.float32)
    labels, probs = model.session.run(None, {model.input_name: x})
    p_high = np.asarray(probs)[:, 1]
    y = data["label"].to_numpy()
    report = {
        "data": path, "wallets": int(data["wallet"].nunique()), "snapshots": int(len(data)),
        "horizon_days": HORIZON_DAYS,
        "deployed_model_v2": _metrics(y, p_high, np.asarray(labels).reshape(-1)),
        f"hf_rule_warn_below_{HF_WARN}": _metrics(y, -data["hf"].to_numpy(), (data["hf"] < HF_WARN).astype(int)),
        "candidate_model": None,
    }
    if report["wallets"] >= MIN_WALLETS:
        report["candidate_model"] = _train_candidate(data, x, y)
    else:
        report["candidate_model"] = (f"skipped: {report['wallets']} wallet(s); retraining needs at least "
                                     f"{MIN_WALLETS} (download the complete dataset, see module docstring)")
    return report


def _train_candidate(data, x, y) -> dict:
    from sklearn.neural_network import MLPClassifier
    order = np.argsort(data["timestamp"].to_numpy())
    cut = int(0.7 * len(order))
    tr, te = order[:cut], order[cut:]
    clf = MLPClassifier(hidden_layer_sizes=(8,), max_iter=2000, random_state=0, early_stopping=True)
    clf.fit(x[tr], y[tr])
    p = clf.predict_proba(x[te])[:, 1]
    out = _metrics(y[te], p, (p > 0.5).astype(int))
    out["train_snapshots"], out["split"] = int(len(tr)), "time-ordered 70/30"
    try:
        from skl2onnx import to_onnx
        d = os.path.join(os.path.dirname(__file__), "..", "risk_model", "artifacts", "candidate")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "risk_model_outcome.onnx"), "wb") as f:
            f.write(to_onnx(clf, x[:1], options={id(clf): {"zipmap": False}}).SerializeToString())
        out["exported"] = "risk_model/artifacts/candidate/risk_model_outcome.onnx"
    except Exception as e:  # pragma: no cover - export is a convenience
        out["exported"] = f"not exported: {e}"
    return out


def _markdown(r: dict) -> str:
    def row(name, m):
        return (f"| {name} | {m['n']} | {m['positives']} | {m['precision']} | {m['recall']} | "
                f"{m['roc_auc'] if m['roc_auc'] is not None else 'n/a'} |")
    rows = [row("deployed model v2 (synthetic labels)", r["deployed_model_v2"]),
            row(f"HF rule: warn when HF < {HF_WARN}", r[f"hf_rule_warn_below_{HF_WARN}"])]
    cand = r["candidate_model"]
    if isinstance(cand, dict):
        rows.append(row("candidate retrained on outcomes (test split)", cand))
        cand_note = f"Candidate exported to `{cand.get('exported')}` (not deployed)."
    else:
        cand_note = f"Candidate model: {cand}."
    return f"""# Outcome-labelled evaluation

`python -m evaluation.outcome_labels` on `{os.path.relpath(r['data'], os.path.dirname(os.path.dirname(__file__)))}`:
{r['wallets']} wallet(s), {r['snapshots']} snapshots. Label = health factor below 1 within
{r['horizon_days']} days (the snapshot became liquidatable).

| scorer | snapshots | positives | precision | recall | ROC-AUC |
|---|---|---|---|---|---|
{chr(10).join(rows)}

{cand_note}

With one wallet this is a case study, not a statistic; run it on the complete
Cred Protocol dataset (module docstring) before citing these numbers as results.
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=DATA_PATH)
    args = ap.parse_args()
    r = run(args.data)
    os.makedirs(RESULTS, exist_ok=True)
    with open(os.path.join(RESULTS, "outcome_labels.json"), "w") as f:
        json.dump(r, f, indent=2, default=str)
    with open(os.path.join(RESULTS, "outcome_labels.md"), "w") as f:
        f.write(_markdown(r))
    print(_markdown(r))


if __name__ == "__main__":
    main()
