"""
Loads the exported ONNX risk model and runs inference via ONNX Runtime.

Using ONNX Runtime here (rather than re-loading the scikit-learn model
directly) is deliberate: it's exactly the artifact format EZKL consumes in
Weeks 3-5, so this module exercises the same ONNX file that will eventually
be compiled into a zk-SNARK circuit - catching any export issues (unsupported
ops, shape mismatches) early, well before the EZKL integration phase.
"""

import json
import os

import numpy as np
import onnxruntime as ort

from risk_model.features import features_to_vector, normalize_vector

_ARTIFACT_DIR = os.path.join(os.path.dirname(__file__), "artifacts")
_ONNX_PATH = os.path.join(_ARTIFACT_DIR, "risk_model.onnx")
_METADATA_PATH = os.path.join(_ARTIFACT_DIR, "model_metadata.json")


class RiskModel:
    """Thin wrapper around an ONNX Runtime session for the risk model."""

    def __init__(self, onnx_path: str = _ONNX_PATH, metadata_path: str = _METADATA_PATH):
        if not os.path.exists(onnx_path):
            raise FileNotFoundError(
                f"No trained model found at {onnx_path}. "
                f"Run `python -m risk_model.train` from the off-chain/ directory first."
            )
        self.session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name

        with open(metadata_path) as f:
            self.metadata = json.load(f)
        self.model_hash = self.metadata["model_hash_keccak256"]

    def predict_risk_score(self, features: dict) -> float:
        """Run inference and return a risk score in [0, 1]."""
        x = np.array([normalize_vector(features_to_vector(features))], dtype=np.float32)
        outputs = self.session.run(None, {self.input_name: x})
        # With zipmap=False (see risk_model/train.py), skl2onnx exports
        # MLPClassifier as (label, probability_tensor) where
        # probability_tensor has shape (batch, n_classes) - no more
        # list-of-dicts ZipMap wrapper. We want P(class=1), i.e. column 1.
        probabilities = outputs[1]
        risk_score = float(probabilities[0][1])
        return risk_score

    def predict(self, features: dict) -> tuple[int, list[float]]:
        """Return (label, [P(low risk), P(high risk)]) exactly as the circuit sees it."""
        x = np.array([normalize_vector(features_to_vector(features))], dtype=np.float32)
        label, probabilities = self.session.run(None, {self.input_name: x})
        return int(label[0]), [float(p) for p in probabilities[0]]

    def predict_q(self, q) -> tuple[int, list[float]]:
        """Same as predict(), from the quantized on-chain feature vector q
        (integers in [0, 1024]) - exactly the input the circuit proves on."""
        x = np.array([[v / 1024 for v in q]], dtype=np.float32)
        label, probabilities = self.session.run(None, {self.input_name: x})
        return int(label[0]), [float(p) for p in probabilities[0]]
