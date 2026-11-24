"""
Why the model is tiny: what each larger network costs as a Tier-2 circuit.

For each architecture (5 inputs -> hidden layers -> 1 output, ReLU, sigmoid
output with the same logit clip as the deployed model) this script:
  1. trains it on the same data as the deployed model (the real Aave
     snapshots when evaluation/data/aave_v2_training.npz exists, else the
     synthetic generator) and records held-out accuracy and ROC-AUC;
  2. builds the EZKL circuit exactly as circuits/build_circuit.py does
     (public inputs, Poseidon-hashed weights, input scale 2^10, one inner
     column, the public SRS for its size);
  3. proves one input and records proving time, proof size and proving-key
     size;
  4. generates the Solidity verifier, compiles it with solc (optimizer on, as
     hardhat.config.js), deploys it on Hardhat's in-memory chain and measures
     one verifyProof call; and checks it against the 24,576-byte EIP-170 limit.

Run from off-chain/:
    python -m evaluation.model_size
Writes results/model_size.{json,md}.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import os
import shutil
import subprocess
import sys
import time

import numpy as np
import onnx
import ezkl
from sklearn.metrics import accuracy_score, roc_auc_score
from sklearn.model_selection import GroupShuffleSplit, train_test_split
from sklearn.neural_network import MLPClassifier
from skl2onnx import to_onnx
from skl2onnx.common.data_types import FloatTensorType

from risk_model.train import LOGIT_CLIP, _clip_logits
from risk_model.features import N_FEATURES, normalize_vector
from risk_model.synthetic_data import generate_synthetic_dataset

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
RESULTS = os.path.join(HERE, "results")
WORK = os.environ.get("MODEL_SIZE_WORK", os.path.join(REPO, ".model_size"))
REAL_TRAINING = os.path.join(HERE, "data", "aave_v2_training.npz")
ARCHS = [(4,), (8,), (16,), (32,), (64,), (16, 16), (32, 32), (64, 64)]
SRS_CACHE = os.path.join(WORK, "srs")


def training_data():
    """The deployed model's data and split (risk_model/train.py): split by
    account, positives duplicated in the training part only."""
    if os.path.exists(REAL_TRAINING):
        d = np.load(REAL_TRAINING, allow_pickle=True)
        X, y, groups = d["X"], d["y"].astype(int), d["groups"]
        tr, te = next(GroupShuffleSplit(n_splits=1, test_size=0.25, random_state=42).split(X, y, groups))
        X_tr, y_tr, X_te, y_te = X[tr], y[tr], X[te], y[te]
        pos = np.where(y_tr == 1)[0]
        reps = max(1, int((len(y_tr) - len(pos)) / max(1, len(pos)) / 4))
        X_tr = np.vstack([X_tr] + [X_tr[pos]] * reps)
        y_tr = np.concatenate([y_tr] + [y_tr[pos]] * reps)
        return X_tr, X_te, y_tr, y_te, "real Aave V2 snapshots (account-level split, as train.py)"
    X_raw, y, _ = generate_synthetic_dataset(n_samples=4000)
    X = np.array([normalize_vector(r) for r in X_raw])
    return (*train_test_split(X, y, test_size=0.2, random_state=42, stratify=y), "synthetic")


def export(model, path):
    m = to_onnx(model, initial_types=[("input", FloatTensorType([None, N_FEATURES]))],
                target_opset=15, options={id(model): {"zipmap": False}})
    m = _clip_logits(m, LOGIT_CLIP)
    with open(path, "wb") as f:
        f.write(m.SerializeToString())


def get_srs(settings, logrows):
    os.makedirs(SRS_CACHE, exist_ok=True)
    path = os.path.join(SRS_CACHE, f"kzg{logrows}.srs")
    if not os.path.exists(path):
        async def _g():
            return await ezkl.get_srs(settings_path=settings, srs_path=path)
        asyncio.run(_g())
    return path


def compile_solidity(sol_path, out_dir):
    """Compile with the repo's solcjs (0.8.24, optimizer 200 runs) -> bytecode files."""
    js = f"""
const solc=require('solc');const fs=require('fs');
const src=fs.readFileSync({json.dumps(sol_path)},'utf8');
const inp={{language:'Solidity',sources:{{'V.sol':{{content:src}}}},settings:{{optimizer:{{enabled:true,runs:200}},
  outputSelection:{{'*':{{'*':['evm.bytecode.object','evm.deployedBytecode.object']}}}}}}}};
const out=JSON.parse(solc.compile(JSON.stringify(inp)));
const errs=(out.errors||[]).filter(e=>e.severity==='error'); if(errs.length){{console.error(errs[0].formattedMessage);process.exit(1);}}
const c=out.contracts['V.sol'][Object.keys(out.contracts['V.sol'])[0]];
fs.writeFileSync({json.dumps(os.path.join(out_dir, 'bytecode.hex'))},c.evm.bytecode.object);
fs.writeFileSync({json.dumps(os.path.join(out_dir, 'deployed.hex'))},c.evm.deployedBytecode.object);
"""
    subprocess.run(["node", "-e", js], cwd=REPO, check=True)


def measure_verifier(out_dir):
    env = {**os.environ, "VERIFIER_DIR": out_dir, "UNLIMITED_CODE": "1", "HARDHAT_LOCAL_SOLC": "1"}
    r = subprocess.run(["npx", "hardhat", "run", "scripts/verifier_gas.js"], cwd=REPO, env=env,
                       capture_output=True, text=True, check=True)
    line = [l for l in r.stdout.splitlines() if l.startswith("{")][-1]
    return json.loads(line)


def study(arch, X_tr, X_te, y_tr, y_te):
    name = "x".join(map(str, arch))
    d = os.path.join(WORK, name)
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)
    model = MLPClassifier(hidden_layer_sizes=arch, activation="relu", solver="adam", max_iter=1000, random_state=42)
    model.fit(X_tr, y_tr)
    acc = accuracy_score(y_te, model.predict(X_te))
    auc = roc_auc_score(y_te, model.predict_proba(X_te)[:, 1])
    n_params = sum(w.size for w in model.coefs_) + sum(b.size for b in model.intercepts_)
    onnx_path = os.path.join(d, "m.onnx")
    export(model, onnx_path)

    settings = os.path.join(d, "settings.json")
    ra = ezkl.PyRunArgs()
    ra.input_visibility, ra.param_visibility, ra.output_visibility = "public", "hashed/public", "public"
    ra.num_inner_cols = 1
    ezkl.gen_settings(onnx_path, settings, ra)
    rng = np.random.default_rng(3)
    rows = (rng.integers(0, 1025, (64, 5)) / 1024).tolist() + [list(c) for c in itertools.product([0.0, 1.0], repeat=5)]
    with open(os.path.join(d, "cal.json"), "w") as f:
        json.dump({"input_data": [np.array(rows).flatten().tolist()]}, f)
    ezkl.calibrate_settings(os.path.join(d, "cal.json"), onnx_path, settings, "resources", scales=[10])
    logrows = json.load(open(settings))["run_args"]["logrows"]
    compiled = os.path.join(d, "net.compiled")
    ezkl.compile_circuit(onnx_path, compiled, settings)
    srs = get_srs(settings, logrows)
    t0 = time.time()
    ezkl.setup(compiled, os.path.join(d, "vk.key"), os.path.join(d, "pk.key"), srs)
    setup_s = time.time() - t0
    with open(os.path.join(d, "in.json"), "w") as f:
        json.dump({"input_data": [[0.62, 0.35, 0.45, 0.06, 0.10]]}, f)
    ezkl.gen_witness(os.path.join(d, "in.json"), compiled, os.path.join(d, "w.json"))
    t0 = time.time()
    ezkl.prove(os.path.join(d, "w.json"), compiled, os.path.join(d, "pk.key"), os.path.join(d, "p.json"), srs)
    prove_s = time.time() - t0
    assert ezkl.verify(os.path.join(d, "p.json"), settings, os.path.join(d, "vk.key"), srs)
    proof_bytes = len(bytes.fromhex(json.load(open(os.path.join(d, "p.json")))["hex_proof"][2:]))
    sol = os.path.join(d, "Verifier.sol")

    async def _v():
        return await ezkl.create_evm_verifier(os.path.join(d, "vk.key"), settings, sol, os.path.join(d, "v.abi"), srs)
    try:
        asyncio.run(_v())
    except Exception:
        pass  # solc post-check needs network; the file is written first
    ezkl.encode_evm_calldata(os.path.join(d, "p.json"), os.path.join(d, "calldata.bytes"))
    compile_solidity(sol, d)
    gas = measure_verifier(d)
    row = {"hidden_layers": list(arch), "parameters": int(n_params), "accuracy": round(acc, 4), "roc_auc": round(auc, 4),
           "logrows": logrows, "setup_s": round(setup_s, 1), "prove_s": round(prove_s, 1),
           "proof_bytes": proof_bytes, "pk_mb": round(os.path.getsize(os.path.join(d, "pk.key")) / 1e6),
           **gas}
    for f in ("pk.key", "net.compiled"):
        os.remove(os.path.join(d, f))  # large; not needed after measuring
    return row


def main():
    X_tr, X_te, y_tr, y_te, source = training_data()
    rows = []
    for arch in ARCHS:
        print("==", arch, flush=True)
        try:
            r = study(arch, X_tr, X_te, y_tr, y_te)
        except Exception as e:  # e.g. a circuit too large for this machine
            r = {"hidden_layers": list(arch), "error": str(e)[:200]}
        print(json.dumps(r), flush=True)
        rows.append(r)
    os.makedirs(RESULTS, exist_ok=True)
    with open(os.path.join(RESULTS, "model_size.json"), "w") as f:
        json.dump({"training_data": source, "rows": rows}, f, indent=2)
    lines = [f"# Model size vs Tier-2 cost\n\nTraining data: {source}. `python -m evaluation.model_size`.\n",
             "| hidden | params | accuracy | ROC-AUC | logrows | prove (s) | proof (B) | pk (MB) | verifier (B) | EIP-170 | verify gas |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        if "error" in r:
            lines.append(f"| {r['hidden_layers']} | - | - | - | - | error: {r['error'][:60]} | | | | | |")
            continue
        lines.append(f"| {'x'.join(map(str, r['hidden_layers']))} | {r['parameters']} | {r['accuracy']:.3f} | {r['roc_auc']:.3f} | "
                     f"{r['logrows']} | {r['prove_s']} | {r['proof_bytes']} | {r['pk_mb']} | {r['deployed_bytes']:,} | "
                     f"{'yes' if r['eip170_ok'] else 'NO'} | {r['verify_gas']:,} |")
    with open(os.path.join(RESULTS, "model_size.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
