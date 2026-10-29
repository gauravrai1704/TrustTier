"""
Export the risk model's weights for the DApp's in-browser simulation mode
(frontend/src/sim/model.json), so the hosted demo runs the same 5-8-1 MLP
the circuit is compiled from. Run after retraining:

    python -m scripts.export_model_js

The repository already publishes the ONNX file; in a production deployment
the weights would stay with the router, and only their hash is on-chain.
tests/test_export_model.py checks the exported forward pass against ONNX.
"""

import json
import os

import numpy as np
import onnx
from onnx import numpy_helper

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ONNX_PATH = os.path.join(ROOT, "off-chain", "risk_model", "artifacts", "risk_model.onnx")
META_PATH = os.path.join(ROOT, "off-chain", "risk_model", "artifacts", "model_metadata.json")
OUT_PATH = os.path.join(ROOT, "frontend", "src", "sim", "model.json")


def load_weights(path: str = ONNX_PATH) -> dict:
    m = onnx.load(path)
    w = {i.name: numpy_helper.to_array(i) for i in m.graph.initializer}
    return {
        "W1": w["coefficient"].astype(float).tolist(),      # 5 x 8
        "b1": w["intercepts"].reshape(-1).astype(float).tolist(),
        "W2": w["coefficient1"].astype(float).reshape(-1).tolist(),  # 8
        "b2": float(w["intercepts1"].reshape(-1)[0]),
        "logit_clip": float(w["logit_max"]),
    }


def forward(weights: dict, x: np.ndarray) -> np.ndarray:
    """P(high) for normalized inputs x (n x 5) - the same math as frontend/src/sim/model.js."""
    h = np.maximum(x @ np.array(weights["W1"]) + np.array(weights["b1"]), 0)
    z = np.clip(h @ np.array(weights["W2"]) + weights["b2"], -weights["logit_clip"], weights["logit_clip"])
    return 1 / (1 + np.exp(-z))


def main():
    weights = load_weights()
    with open(META_PATH) as f:
        meta = json.load(f)
    weights["model_hash"] = meta["model_hash_keccak256"]
    weights["model_version"] = meta.get("model_version")
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(weights, f, indent=1)
    print(f"wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
