"""
Baseline: the deployed model run *inside* a contract (Alhaidari et al., AFT 2025),
contracts/baselines/OnChainMLPBaseline.sol.

  1. Exports the deployed ONNX model's weights as the contract's fixed-point
     integers (scale 1e12) -> results/baseline_params.json, which
     scripts/baseline_onchain.js uploads and measures.
  2. Checks that the integer model the contract runs makes the same decision
     as the ONNX model (the one TrustTier's circuit proves) on every real Aave
     V2 position-day (data/aave_v2_positions.parquet): their "bitwise
     consistency" check, on our data.

Run from off-chain/:
    python -m evaluation.baseline_onchain
"""
from __future__ import annotations

import json
import os

import numpy as np
import onnx
import pandas as pd
from onnx import numpy_helper

from risk_model.features import FEATURE_NAMES, normalize_vector
from risk_model.inference import RiskModel

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
ONNX = os.path.join(HERE, "..", "risk_model", "artifacts", "risk_model.onnx")
POSITIONS = os.path.join(HERE, "data", "aave_v2_positions.parquet")
SCALE = 10**12


def tdiv(a: int, b: int) -> int:
    """Solidity's signed division: truncates toward zero."""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b > 0) else -q


def export_params():
    init = {i.name: numpy_helper.to_array(i) for i in onnx.load(ONNX).graph.initializer}
    w0, b0, w1, b1 = init["coefficient"], init["intercepts"].ravel(), init["coefficient1"], init["intercepts1"].ravel()
    to_int = lambda x: [int(round(float(v) * SCALE)) for v in np.asarray(x).ravel()]  # noqa: E731
    params = to_int(w0) + to_int(b0) + to_int(w1) + to_int(b1)  # w0 is (in, out) row-major = input-major
    layers = [w0.shape[0], w0.shape[1], w1.shape[1]]
    return layers, params


def classify(layers, params, q):
    a = [tdiv(x * SCALE, 1024) for x in q]
    p = 0
    for l in range(len(layers) - 1):
        n_in, n_out = layers[l], layers[l + 1]
        z = [0] * n_out
        for i in range(n_in):
            for j in range(n_out):
                z[j] += tdiv(params[p + i * n_out + j] * a[i], SCALE)
        p += n_in * n_out
        for j in range(n_out):
            z[j] += params[p + j]
            if l + 2 < len(layers) and z[j] < 0:
                z[j] = 0
        p += n_out
        a = z
    return int(a[0] > 0), a[0]


def main():
    layers, params = export_params()
    os.makedirs(RESULTS, exist_ok=True)
    out = {"scale": str(SCALE), "layers": layers, "params": [str(x) for x in params]}
    df = pd.read_parquet(POSITIONS)
    df = df.assign(utilization=df.ltv / df.liq_threshold)
    model = RiskModel()
    q = [[int(v * 1024) for v in normalize_vector(r)] for r in df[FEATURE_NAMES].values.tolist()]
    onnx_labels = np.array([model.predict_q(x)[0] for x in q])
    chain_labels = np.array([classify(layers, params, x)[0] for x in q])
    agree = int((onnx_labels == chain_labels).sum())
    out["agreement"] = {"position_days": len(q), "same_decision": agree, "high_risk_onnx": int(onnx_labels.sum())}
    with open(os.path.join(RESULTS, "baseline_params.json"), "w") as f:
        json.dump(out, f, indent=2)
    print(f"{len(params)} parameters; on-chain integer model agrees with ONNX on {agree:,}/{len(q):,} real position-days")


if __name__ == "__main__":
    main()
