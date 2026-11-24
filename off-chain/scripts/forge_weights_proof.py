"""
Build the forged-weights proof used by the weight-binding tests
(circuits/forged_weights_sample.json).

The attack it reproduces (docs/SECURITY.md finding 32): take the deployed
model, push its last-layer bias up so it calls everything "high risk",
compile it with the deployed circuit settings and prove the LOW-risk sample
position with the deployed proving key. The result is a valid proof under
the deployed verification key (the verifier encodes the network's shape, not
its weights) with label 1. Only the Poseidon weights hash in public input 0
differs, and that is what LiquidationEngine checks (WrongModelWeights).

Run from the repository root (needs circuits/pk.key):
    python off-chain/scripts/forge_weights_proof.py
"""
import json
import os
import tempfile

import ezkl
import numpy as np
import onnx
from onnx import numpy_helper

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
C = os.path.join(ROOT, "circuits")
MODEL = os.path.join(ROOT, "off-chain", "risk_model", "artifacts", "risk_model.onnx")
BIAS_SHIFT = 14.0  # enough to flip the low-risk sample (logits are clipped to +-8)


def main():
    w = tempfile.mkdtemp()
    m = onnx.load(MODEL)
    t = next(i for i in m.graph.initializer if i.name == "intercepts1")
    t.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(t).astype(np.float32) + np.float32(BIAS_SHIFT), t.name))
    onnx.save(m, os.path.join(w, "forged.onnx"))
    ezkl.compile_circuit(os.path.join(w, "forged.onnx"), os.path.join(w, "forged.compiled"), os.path.join(C, "settings.json"))

    samples = json.load(open(os.path.join(C, "samples.json")))
    low = next(s for s in samples["samples"] if s["name"] == "low_risk")
    q = [int(x) for x in low["public_inputs"][1:6]]
    json.dump({"input_data": [[x / 1024 for x in q]]}, open(os.path.join(w, "in.json"), "w"))
    ezkl.gen_witness(os.path.join(w, "in.json"), os.path.join(w, "forged.compiled"), os.path.join(w, "wit.json"))
    ezkl.prove(os.path.join(w, "wit.json"), os.path.join(w, "forged.compiled"), os.path.join(C, "pk.key"),
               os.path.join(w, "proof.json"), os.path.join(C, "kzg.srs"))
    ok = ezkl.verify(os.path.join(w, "proof.json"), os.path.join(C, "settings.json"), os.path.join(C, "vk.key"),
                     os.path.join(C, "kzg.srs"))
    p = json.load(open(os.path.join(w, "proof.json")))
    inst = [int(ezkl.felt_to_big_endian(x), 16) for x in p["instances"][0]]
    assert ok, "forged proof should verify under the deployed key"
    assert inst[1:6] == q and inst[6] == 1, inst
    assert str(inst[0]) != str(samples["weights_hash"])
    out = {"name": "forged_weights_low_risk",
           "note": "The low_risk sample position proved with forged weights (last-layer bias +14): a valid proof "
                   "under the deployed verification key, label 1 (high risk), but its weights hash is not the "
                   "registered one. Made by off-chain/scripts/forge_weights_proof.py.",
           "proof": p["hex_proof"], "public_inputs": [str(x) for x in inst]}
    with open(os.path.join(C, "forged_weights_sample.json"), "w") as f:
        json.dump(out, f, indent=2)
    print("verifies under the deployed key:", ok, "instances:", inst)


if __name__ == "__main__":
    main()
