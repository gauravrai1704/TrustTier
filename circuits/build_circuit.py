"""
Full EZKL pipeline for TrustTier's risk model: ONNX -> compiled circuit ->
proving/verification keys -> real proofs -> on-chain Solidity verifier ->
ready-to-send EVM calldata.

Run from the circuits/ directory, after the risk model has been trained
(off-chain/risk_model/train.py):

    python3 build_circuit.py

VERIFIED INPUTS, NOT TRUSTED INPUTS: the circuit's inputs are the five
normalized features, quantized to q / 1024, with PUBLIC visibility. Every
proof therefore exposes the exact feature values it was computed on:

    instances = [q_ltv, q_vol, q_mom, q_topup, q_age, label, P(low)*2^10, P(high)*2^10]

LiquidationEngine reads the same features from their on-chain sources (the
lending protocol and Chainlink feeds), quantizes them identically
(off-chain/risk_model/onchain_features.py is the Python mirror) and accepts
a proof only if the first five instances match. Nobody has to be trusted to
supply a position's features; only the model weights stay private.

Outputs (written to this directory):
    settings.json, network.compiled, kzg.srs, vk.key, pk.key (~575 MB, not shipped)
    witness.json, proof.json, calldata.bytes  - the primary (high-risk) sample
    Verifier.sol (copied to contracts/EzklVerifier.sol)
    samples.json   - high- and low-risk sample positions: their on-chain
                     parameters, quantized features, proofs and instances
    fidelity.json  - circuit vs ONNX label agreement on random inputs

CAVEATS:
1. The SRS is self-generated (ezkl.gen_srs), not from a public ceremony:
   fine for local development and a testnet demo; production must use a
   ceremony SRS (ezkl.get_srs). kzg.srs is shipped so make_proving_key.py can
   rebuild pk.key deterministically.
2. create_evm_verifier's internal solc sanity check may fail without network
   access; Verifier.sol is written before that check, and Hardhat compiles it.
"""

import asyncio
import itertools
import json
import os
import shutil
import sys
import time

import ezkl
import numpy as np

CIRCUITS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(CIRCUITS_DIR, ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, "off-chain"))

from risk_model.inference import RiskModel  # noqa: E402
from risk_model.onchain_features import SCALE, OnchainPosition, quantize, to_model_input  # noqa: E402
from router.prover import EzklProver  # noqa: E402

ONNX_SOURCE = os.path.join(REPO_ROOT, "off-chain", "risk_model", "artifacts", "risk_model.onnx")
ONNX_PATH = os.path.join(CIRCUITS_DIR, "risk_model.onnx")
SETTINGS_PATH = os.path.join(CIRCUITS_DIR, "settings.json")
CALIBRATION_PATH = os.path.join(CIRCUITS_DIR, "calibration.json")
COMPILED_PATH = os.path.join(CIRCUITS_DIR, "network.compiled")
SRS_PATH = os.path.join(CIRCUITS_DIR, "kzg.srs")
VK_PATH = os.path.join(CIRCUITS_DIR, "vk.key")
PK_PATH = os.path.join(CIRCUITS_DIR, "pk.key")
INPUT_PATH = os.path.join(CIRCUITS_DIR, "input.json")
WITNESS_PATH = os.path.join(CIRCUITS_DIR, "witness.json")
PROOF_PATH = os.path.join(CIRCUITS_DIR, "proof.json")
VERIFIER_SOL_PATH = os.path.join(CIRCUITS_DIR, "Verifier.sol")
VERIFIER_ABI_PATH = os.path.join(CIRCUITS_DIR, "Verifier.abi")
CALLDATA_PATH = os.path.join(CIRCUITS_DIR, "calldata.bytes")
SAMPLES_PATH = os.path.join(CIRCUITS_DIR, "samples.json")
FIDELITY_PATH = os.path.join(CIRCUITS_DIR, "fidelity.json")
CONTRACTS_VERIFIER_DEST = os.path.join(REPO_ROOT, "contracts", "EzklVerifier.sol")

FIDELITY_SAMPLES = 200
NOW = 1_800_000_000  # fixed reference time for the samples (tests use their own clock)
DAY = 86_400

# Sample positions, defined by ON-CHAIN parameters (USD and prices with 8
# decimals, volatility in percent with 8 decimals). The tests recreate exactly
# these positions in MockLendingPool + mock Chainlink feeds and check that the
# contract's quantized features equal these proofs' public instances.
SAMPLES = [
    {   # LTV 0.93, price fell 9.1% in 24 h, 35% volatility, topped up 5 days ago, 200-day-old account
        "name": "high_risk", "expected_label": 1,
        "collateral_usd": 2_000 * 10**8, "debt_usd": 1_860 * 10**8, "liquidation_threshold_bps": 8_000,
        "price_now": 2_000 * 10**8, "price_past": 2_200 * 10**8, "vol_answer": 35 * 10**8, "vol_decimals": 8,
        "topup_days_ago": 5, "age_days": 200,
    },
    {   # LTV 0.20, price rose 5.3%, 5% volatility, topped up 1 day ago, 1,500-day-old account
        "name": "low_risk", "expected_label": 0,
        "collateral_usd": 2_000 * 10**8, "debt_usd": 400 * 10**8, "liquidation_threshold_bps": 8_000,
        "price_now": 2_000 * 10**8, "price_past": 1_900 * 10**8, "vol_answer": 5 * 10**8, "vol_decimals": 8,
        "topup_days_ago": 1, "age_days": 1_500,
    },
    {   # LTV 0.72 (delta 8%: the chain allows a cheap Tier-1 claim), but the price fell
        # 16.7% in 24 h, 50% volatility, no top-up for 60 days, 30-day-old account:
        # the model says high risk, so a Tier-1 "safe" claim on it is slashable.
        "name": "watch_high", "expected_label": 1,
        "collateral_usd": 2_000 * 10**8, "debt_usd": 1_440 * 10**8, "liquidation_threshold_bps": 8_000,
        "price_now": 2_000 * 10**8, "price_past": 2_400 * 10**8, "vol_answer": 50 * 10**8, "vol_decimals": 8,
        "topup_days_ago": 60, "age_days": 30,
    },
]


def sample_q(s):
    pos = OnchainPosition(s["collateral_usd"], s["debt_usd"], s["liquidation_threshold_bps"],
                          opened_at=NOW - s["age_days"] * DAY, last_topup_at=NOW - s["topup_days_ago"] * DAY)
    return quantize(pos, s["price_now"], s["price_past"], s["vol_answer"], s["vol_decimals"], NOW)


def step(msg):
    print(f"\n=== {msg} ===")


def check_label_fidelity(n=FIDELITY_SAMPLES, seed=11):
    """The circuit must give the same label as the ONNX model on any q."""
    model = RiskModel()
    rng = np.random.default_rng(seed)
    mismatches = 0
    tmp_in, tmp_w = os.path.join(CIRCUITS_DIR, "_fid_in.json"), os.path.join(CIRCUITS_DIR, "_fid_w.json")
    for _ in range(n):
        q = [int(x) for x in rng.integers(0, SCALE + 1, 5)]
        with open(tmp_in, "w") as f:
            json.dump({"input_data": [to_model_input(q)]}, f)
        ezkl.gen_witness(tmp_in, COMPILED_PATH, tmp_w)
        with open(tmp_w) as f:
            circuit_label = int(float(json.load(f)["pretty_elements"]["rescaled_outputs"][0][0]))
        onnx_label, _ = model.predict_q(q)
        mismatches += int(circuit_label != onnx_label)
    for p in (tmp_in, tmp_w):
        os.remove(p)
    return mismatches


def main():
    if not os.path.exists(ONNX_SOURCE):
        sys.exit(f"{ONNX_SOURCE} not found - run `python -m risk_model.train` in off-chain/ first")
    shutil.copy(ONNX_SOURCE, ONNX_PATH)

    step("1/9 Generating circuit settings")
    run_args = ezkl.PyRunArgs()
    run_args.input_visibility = "public"    # features are public chain data, checked on-chain
    run_args.param_visibility = "private"   # model weights stay confidential
    run_args.output_visibility = "public"   # the label/probabilities are the claim
    run_args.num_inner_cols = 1             # keeps the verifier under the 24 KB contract limit
    ezkl.gen_settings(ONNX_PATH, SETTINGS_PATH, run_args)

    step("2/9 Calibrating over the whole input domain")
    # Every input is q / 1024 with q in [0, 1024]: calibrate on random points
    # and every corner of the unit box so any position can be proved (inputs
    # outside the calibrated range make EZKL's witness generation hang).
    # Scale 10 + clipped logits give a 2^16-row circuit and ~16 s proofs.
    rng = np.random.default_rng(3)
    rows = (rng.integers(0, SCALE + 1, (64, 5)) / SCALE).tolist()
    rows += [list(c) for c in itertools.product([0.0, 1.0], repeat=5)]
    with open(CALIBRATION_PATH, "w") as f:
        json.dump({"input_data": [np.array(rows).flatten().tolist()]}, f)
    ezkl.calibrate_settings(CALIBRATION_PATH, ONNX_PATH, SETTINGS_PATH, "resources", scales=[10])
    with open(SETTINGS_PATH) as f:
        settings = json.load(f)
    logrows = settings["run_args"]["logrows"]
    assert settings["run_args"]["input_scale"] == 10, "on-chain quantization assumes input_scale 10"
    print(f"logrows={logrows}, input_scale=10")

    step("3/9 Compiling circuit")
    ezkl.compile_circuit(ONNX_PATH, COMPILED_PATH, SETTINGS_PATH)

    step("4/9 Generating structured reference string (local, self-generated)")
    ezkl.gen_srs(SRS_PATH, logrows)

    step("5/9 Setup (proving + verification keys)")
    t0 = time.time()
    ezkl.setup(COMPILED_PATH, VK_PATH, PK_PATH, SRS_PATH)
    print(f"Setup {time.time() - t0:.1f}s; pk.key {os.path.getsize(PK_PATH) / 1e6:.0f} MB")

    step("6/9 Label fidelity: circuit vs ONNX model")
    mismatches = check_label_fidelity()
    print(f"Disagreements: {mismatches}/{FIDELITY_SAMPLES}")
    with open(FIDELITY_PATH, "w") as f:
        json.dump({"random_inputs": FIDELITY_SAMPLES, "label_disagreements": mismatches,
                   "domain": "q uniform in [0, 1024]^5", "seed": 11}, f, indent=2)

    step("7/9 Primary sample: witness, proof, local verification")
    primary = SAMPLES[0]
    with open(INPUT_PATH, "w") as f:
        json.dump({"input_data": [to_model_input(sample_q(primary))]}, f)
    ezkl.gen_witness(INPUT_PATH, COMPILED_PATH, WITNESS_PATH)
    t0 = time.time()
    ezkl.prove(WITNESS_PATH, COMPILED_PATH, PK_PATH, PROOF_PATH, SRS_PATH)
    proving_time = time.time() - t0
    if not ezkl.verify(PROOF_PATH, SETTINGS_PATH, VK_PATH, SRS_PATH):
        sys.exit("proof failed local verification")
    print(f"Proof in {proving_time:.1f}s, verified locally")

    step("8/9 Solidity verifier and calldata")

    async def _generate_verifier():
        return await ezkl.create_evm_verifier(VK_PATH, SETTINGS_PATH, VERIFIER_SOL_PATH, VERIFIER_ABI_PATH, SRS_PATH)

    if os.path.exists(VERIFIER_SOL_PATH):
        os.remove(VERIFIER_SOL_PATH)  # so a stale verifier can never be mistaken for a fresh one
    try:
        asyncio.run(_generate_verifier())
    except Exception as e:  # solc post-check needs network; the file is already written
        print(f"NOTE: create_evm_verifier's solc post-check failed ({e}).")
    if not os.path.exists(VERIFIER_SOL_PATH):
        sys.exit("Verifier.sol was not written")
    ezkl.encode_evm_calldata(PROOF_PATH, CALLDATA_PATH)
    with open(VERIFIER_SOL_PATH) as f:
        body = f.read().split("pragma solidity", 1)[1]
    header = (
        "// SPDX-License-Identifier: MIT\n\n"
        "// =============================================================================\n"
        "// AUTO-GENERATED by EZKL (ezkl.create_evm_verifier) - DO NOT HAND-EDIT.\n"
        "// Regenerate via circuits/build_circuit.py if the risk model changes.\n"
        "// =============================================================================\n\n"
    )
    with open(CONTRACTS_VERIFIER_DEST, "w") as f:
        f.write(header + "pragma solidity" + body)

    step("9/9 Sample proofs")
    prover = EzklProver(CIRCUITS_DIR)
    out = []
    for s in SAMPLES:
        q = sample_q(s)
        p = prover.prove(q)
        if p.label != s["expected_label"]:
            sys.exit(f"sample {s['name']} proved label {p.label}, expected {s['expected_label']}")
        out.append({**{k: v for k, v in s.items() if k != "expected_label"},
                    "q": q, "label": p.label, "proof": "0x" + p.proof.hex(),
                    "public_inputs": [str(x) for x in p.public_inputs],
                    "proving_seconds": round(p.seconds, 1)})
        print(f"  {s['name']}: q={q} label={p.label} {len(p.proof)} proof bytes {p.seconds:.1f}s")
    with open(SAMPLES_PATH, "w") as f:
        json.dump({"instance_layout": ["q_ltv", "q_vol", "q_mom", "q_topup", "q_age", "label",
                                       "p_low_x2^10", "p_high_x2^10"],
                   "units": "USD and prices with 8 decimals; vol_answer in percent with vol_decimals decimals",
                   "samples": out}, f, indent=2)

    print("\n=== Done ===")
    print(f"  logrows {logrows}, proving {proving_time:.1f}s, label disagreements {mismatches}/{FIDELITY_SAMPLES}")


if __name__ == "__main__":
    main()
