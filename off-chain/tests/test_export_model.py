"""The DApp's in-browser model (scripts/export_model_js.py) must agree with
the ONNX model the circuit is compiled from."""

import numpy as np
import onnxruntime as ort

from scripts.export_model_js import ONNX_PATH, forward, load_weights


def test_exported_forward_pass_matches_onnx():
    rng = np.random.default_rng(0)
    q = rng.integers(0, 1025, size=(500, 5))
    x = (q / 1024).astype(np.float32)
    s = ort.InferenceSession(ONNX_PATH, providers=["CPUExecutionProvider"])
    labels, probs = s.run(None, {s.get_inputs()[0].name: x})
    p = forward(load_weights(), x.astype(float))
    assert np.max(np.abs(p - np.asarray(probs)[:, 1])) < 1e-5
    assert ((p > 0.5).astype(int) == np.asarray(labels).reshape(-1)).mean() > 0.998
