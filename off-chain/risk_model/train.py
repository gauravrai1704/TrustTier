"""
Trains TrustTier's risk-scoring model and exports it to ONNX.

Architecture choice: a small 2-layer MLP (5 inputs -> 8 hidden -> 1 output,
sigmoid activation) via scikit-learn, rather than a deep network. This is
deliberate: EZKL's proving cost scales with circuit size, and the ZKML
EuroSys 2024 baseline (see baseline reference [3]) shows proving even a
distilled GPT-2 takes close to an hour - so at the model-selection stage of
this project, staying small and circuit-friendly matters far more than
squeezing out marginal accuracy gains. scikit-learn is used instead of
PyTorch here for a lightweight dependency footprint; nothing about the
tiering/routing logic depends on this choice.

Run from the off-chain/ directory:
    python -m risk_model.train
"""

import json
import os

import numpy as np
import onnx
from onnx import helper, numpy_helper
from web3 import Web3
from sklearn.neural_network import MLPClassifier
from sklearn.metrics import accuracy_score, roc_auc_score
from sklearn.model_selection import train_test_split
from skl2onnx import to_onnx
from skl2onnx.common.data_types import FloatTensorType

from risk_model.features import FEATURE_BOUNDS, FEATURE_NAMES, N_FEATURES, normalize_vector

MODEL_VERSION = "v2"
# The exported graph clips the output logit to [-LOGIT_CLIP, LOGIT_CLIP]
# before the sigmoid. sigmoid(8) = 0.99966, so labels are unchanged and
# probabilities move by < 0.04%, but the Tier-2 circuit's sigmoid lookup
# table stays small (see circuits/build_circuit.py).
LOGIT_CLIP = 8.0


def _clip_logits(onnx_model, bound: float):
    graph = onnx_model.graph
    idx = next(i for i, n in enumerate(graph.node) if n.op_type == "Sigmoid")
    sigmoid = graph.node[idx]
    graph.initializer.extend([
        numpy_helper.from_array(np.array(-bound, dtype=np.float32), "logit_min"),
        numpy_helper.from_array(np.array(bound, dtype=np.float32), "logit_max"),
    ])
    clip = helper.make_node("Clip", [sigmoid.input[0], "logit_min", "logit_max"], ["clipped_logit"], name="clip_logit")
    sigmoid.input[0] = "clipped_logit"
    graph.node.insert(idx, clip)
    onnx.checker.check_model(onnx_model)
    return onnx_model
from risk_model.synthetic_data import generate_synthetic_dataset

ARTIFACT_DIR = os.path.join(os.path.dirname(__file__), "artifacts")
ONNX_PATH = os.path.join(ARTIFACT_DIR, "risk_model.onnx")
METADATA_PATH = os.path.join(ARTIFACT_DIR, "model_metadata.json")


def train_and_export():
    os.makedirs(ARTIFACT_DIR, exist_ok=True)

    X_raw, y, _risk_scores = generate_synthetic_dataset(n_samples=4000)
    # Train on min-max normalized features (risk_model/features.py): the
    # Tier-2 circuit proves over the same normalized vector.
    X = np.array([normalize_vector(row) for row in X_raw])
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    # Small architecture, kept EZKL-circuit-friendly: 5 -> 8 -> 1.
    model = MLPClassifier(
        hidden_layer_sizes=(8,),
        activation="relu",
        solver="adam",
        max_iter=1000,
        random_state=42,
    )
    model.fit(X_train, y_train)

    preds = model.predict(X_test)
    probs = model.predict_proba(X_test)[:, 1]
    acc = accuracy_score(y_test, preds)
    auc = roc_auc_score(y_test, probs)
    print(f"Validation accuracy: {acc:.4f}")
    print(f"Validation ROC-AUC:  {auc:.4f}")

    # Export to ONNX. skl2onnx needs an explicit input shape/type.
    # zipmap=False is required for EZKL compatibility: by default skl2onnx
    # wraps classifier probability outputs in a ZipMap node (producing a
    # list of {class: probability} dicts), which is a control-flow-like
    # construct that EZKL's ONNX parser (built on the `tract` crate) does
    # not support. Disabling it makes the model emit a plain probability
    # tensor instead - functionally identical, just EZKL-circuit-friendly.
    onnx_model = to_onnx(
        model,
        initial_types=[("input", FloatTensorType([None, N_FEATURES]))],
        target_opset=15,
        options={id(model): {"zipmap": False}},
    )
    onnx_model = _clip_logits(onnx_model, LOGIT_CLIP)
    with open(ONNX_PATH, "wb") as f:
        f.write(onnx_model.SerializeToString())
    print(f"Wrote ONNX model to {ONNX_PATH}")

    # This hash is what gets registered on-chain in ModelRegistry, and what
    # every Tier 1/Tier 2 decision is checked against. Anyone can
    # independently recompute this hash from the ONNX file to verify a
    # claimed model version matches what was actually registered.
    #
    # IMPORTANT: this must be Ethereum's Keccak-256 (Web3.keccak), NOT
    # Python's hashlib.sha3_256. Despite the name, NIST-standardized SHA3-256
    # uses different padding than the original Keccak-256 that Ethereum
    # (and Solidity's `keccak256`) actually uses - the two produce different
    # digests for the same input. Using hashlib.sha3_256 here would silently
    # produce a hash that never matches what ModelRegistry expects.
    with open(ONNX_PATH, "rb") as f:
        onnx_bytes = f.read()
    model_hash = Web3.keccak(onnx_bytes).hex()
    if not model_hash.startswith("0x"):
        model_hash = "0x" + model_hash

    metadata = {
        "feature_names": FEATURE_NAMES,
        "n_features": N_FEATURES,
        "hidden_layer_sizes": [8],
        "model_version": MODEL_VERSION,
        "input_normalization": {"method": "min-max to [0, 1]", "bounds": FEATURE_BOUNDS},
        "logit_clip": LOGIT_CLIP,
        "positive_rate": float(y.mean()),
        "validation_accuracy": acc,
        "validation_roc_auc": auc,
        "onnx_path": os.path.relpath(ONNX_PATH, start=os.path.dirname(__file__)),
        "model_hash_keccak256": model_hash,
    }
    with open(METADATA_PATH, "w") as f:
        json.dump(metadata, f, indent=2)
    print(f"Wrote model metadata to {METADATA_PATH}")
    print(f"Model hash (for ModelRegistry.registerModel): {model_hash}")

    return model_hash


if __name__ == "__main__":
    train_and_export()
