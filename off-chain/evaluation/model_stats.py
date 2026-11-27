"""
Statistical support for the deployed model (real Aave V2 outcomes).

  1. Held-out accounts (the deployed model's own split, risk_model/train.py):
     ROC-AUC, average precision (area under the precision-recall curve),
     precision and recall at the deployed 0.5 cut, each with a 95% confidence
     interval from 1,000 bootstrap resamples of ACCOUNTS (rows of one borrower
     are not independent).
  2. Simple baselines on the same held-out accounts: utilization alone (the
     distance to liquidation in threshold units) and logistic regression on
     the same five features.
  3. A temporal holdout: the same architecture trained on the earliest 75% of
     position-days (before 28 Jun 2022) and tested on the latest 25%, so the
     test period is a market regime the model never saw (it includes the 2022
     crashes). Test rows of accounts seen in training are dropped, so the
     temporal test is also account-disjoint.
  4. Precision and recall at stricter cuts, i.e. what a protocol trades if it
     demands more confidence before a soft liquidation.

Run from off-chain/:
    python -m evaluation.model_stats
Writes results/model_stats.{json,md}.
"""
from __future__ import annotations

import json
import os

import numpy as np
import onnxruntime as ort
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import GroupShuffleSplit
from sklearn.neural_network import MLPClassifier

from risk_model.features import normalize_vector

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
NPZ = os.path.join(HERE, "data", "aave_v2_training.npz")
POSITIONS = os.path.join(HERE, "data", "aave_v2_positions.parquet")
ONNX = os.path.join(HERE, "..", "risk_model", "artifacts", "risk_model.onnx")
FEATS = ["utilization", "collateral_volatility_30d", "price_momentum_24h", "time_since_last_topup_days", "account_age_days"]
B = 1000
RNG = np.random.default_rng(0)


def oversample(X, y):
    """As risk_model/train.py: repeat positives in the training part only."""
    pos = np.where(y == 1)[0]
    reps = max(1, int((len(y) - len(pos)) / max(1, len(pos)) / 4))
    return np.vstack([X] + [X[pos]] * reps), np.concatenate([y] + [y[pos]] * reps)


def mlp():
    return MLPClassifier(hidden_layer_sizes=(8,), activation="relu", solver="adam", max_iter=1000, random_state=42)


def metrics(y, p, cut=0.5):
    f = (p >= cut).astype(int)
    return {"roc_auc": roc_auc_score(y, p), "avg_precision": average_precision_score(y, p),
            "precision": precision_score(y, f, zero_division=0), "recall": recall_score(y, f, zero_division=0)}


def bootstrap(y, p, groups):
    """95% intervals, resampling accounts with replacement."""
    ug = np.unique(groups)
    idx = {g: np.where(groups == g)[0] for g in ug}
    draws = {k: [] for k in ("roc_auc", "avg_precision", "precision", "recall")}
    for _ in range(B):
        pick = np.concatenate([idx[g] for g in RNG.choice(ug, size=len(ug), replace=True)])
        if 0 < y[pick].sum() < len(pick):
            for k, v in metrics(y[pick], p[pick]).items():
                draws[k].append(v)
    return {k: [round(float(np.percentile(v, 2.5)), 3), round(float(np.percentile(v, 97.5)), 3)] for k, v in draws.items()}


def r(d):
    return {k: round(float(v), 3) for k, v in d.items()}


def main():
    d = np.load(NPZ, allow_pickle=True)
    X, y, groups = d["X"], d["y"].astype(int), d["groups"]
    tr, te = next(GroupShuffleSplit(n_splits=1, test_size=0.25, random_state=42).split(X, y, groups))
    sess = ort.InferenceSession(ONNX)
    probs = sess.run(None, {sess.get_inputs()[0].name: X[te].astype(np.float32)})[1]
    p_model = np.asarray(probs)[:, 1]
    yt = y[te]
    out = {"test_rows": int(len(te)), "test_accounts": int(len(np.unique(groups[te]))), "test_positive_rate": round(float(yt.mean()), 4)}
    out["deployed_model"] = {**r(metrics(yt, p_model)), "ci95": bootstrap(yt, p_model, groups[te])}
    # Baselines on the same accounts.
    out["baseline_utilization"] = r(metrics(yt, X[te][:, 0], cut=np.quantile(X[te][:, 0], 1 - yt.mean())))
    Xo, yo = oversample(X[tr], y[tr])
    lr = LogisticRegression(max_iter=2000).fit(Xo, yo)
    out["baseline_logistic"] = r(metrics(yt, lr.predict_proba(X[te])[:, 1]))
    # Stricter cuts for the deployed model.
    out["cuts"] = {str(c): {k: round(float(v), 3) for k, v in metrics(yt, p_model, c).items() if k in ("precision", "recall")}
                   for c in (0.5, 0.6, 0.7, 0.8, 0.9)}
    # Temporal holdout.
    pos = pd.read_parquet(POSITIONS)
    pos = pos[pos.full_horizon & (pos.health_factor >= 1.0)].assign(utilization=lambda f: f.ltv / f.liq_threshold)
    cut_ts = pos.ts.quantile(0.75)
    early, late = pos[pos.ts < cut_ts], pos[pos.ts >= cut_ts]
    late = late[~late.user.isin(set(early.user))]
    Xe = np.array([normalize_vector(v) for v in early[FEATS].values.tolist()])
    Xl = np.array([normalize_vector(v) for v in late[FEATS].values.tolist()])
    ye, yl = early.label.values.astype(int), late.label.values.astype(int)
    m = mlp().fit(*oversample(Xe, ye))
    pl = m.predict_proba(Xl)[:, 1]
    out["temporal"] = {"split_date": str(pd.to_datetime(cut_ts, unit="s").date()), "train_rows": int(len(early)),
                       "test_rows": int(len(late)), "test_accounts": int(late.user.nunique()),
                       "test_positive_rate": round(float(yl.mean()), 4), **r(metrics(yl, pl)),
                       "ci95": bootstrap(yl, pl, late.user.values),
                       "baseline_utilization_auc": round(float(roc_auc_score(yl, Xl[:, 0])), 3)}
    os.makedirs(RESULTS, exist_ok=True)
    with open(os.path.join(RESULTS, "model_stats.json"), "w") as f:
        json.dump(out, f, indent=2)
    with open(os.path.join(RESULTS, "model_stats.md"), "w") as f:
        f.write("# Model statistics\n\n`python -m evaluation.model_stats`\n\n```json\n" + json.dumps(out, indent=2) + "\n```\n")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
