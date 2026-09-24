"""
Full EZKL pipeline for TrustTier's risk model: ONNX -> compiled circuit ->
proving/verification keys -> a real proof -> a real on-chain Solidity
verifier -> ready-to-send EVM calldata.

This is the Weeks 3-5 milestone. Run from the circuits/ directory, after
the risk model has been trained (off-chain/risk_model/train.py):

    python3 build_circuit.py

Outputs (all written to this directory):
    settings.json       - circuit settings (visibility, scale, logrows)
    network.compiled     - the compiled EZKL circuit
    kzg.srs               - locally-generated structured reference string
    pk.key / vk.key       - proving key / verification key
    witness.json          - witness for the sample input below
    proof.json            - the generated zk-SNARK proof
    Verifier.sol          - the auto-generated Solidity verifier contract
    calldata.bytes        - ready-to-send ABI-encoded calldata for
                            verifyProof(bytes,uint256[]) against the
                            deployed verifier

IMPORTANT CAVEATS (read before treating this as production-ready):

1. SRS is self-generated (ezkl.gen_srs), not from a public trusted-setup
   ceremony (e.g. the Perpetual Powers of Tau). A self-generated SRS means
   whoever ran this script could theoretically know the toxic waste used to
   generate it and forge proofs. This is fine for local development and
   coursework demonstration; a real deployment should use a downloaded,
   ceremony-audited SRS instead (ezkl.get_srs, which downloads from a
   public params server - not used here only because this sandboxed
   environment's network allowlist blocks that server, not because it is
   the wrong approach in general).

2. create_evm_verifier internally shells out to `solc` to sanity-check the
   generated Solidity, and needs an active asyncio event loop despite not
   being declared as a coroutine in its Python signature (an EZKL binding
   quirk, not a design choice made here). Both are handled below: the
   asyncio.run() wrapper, and a try/except around the solc-dependent
   post-check, since Verifier.sol is already written to disk by the time
   that internal check runs - the exception does not indicate the verifier
   itself is broken, only that EZKL's own extra sanity pass couldn't run in
   this environment.
"""

import asyncio
import json
import os
import shutil
import sys
import time

import ezkl

CIRCUITS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(CIRCUITS_DIR, ".."))

ONNX_SOURCE = os.path.join(REPO_ROOT, "off-chain", "risk_model", "artifacts", "risk_model.onnx")
METADATA_SOURCE = os.path.join(REPO_ROOT, "off-chain", "risk_model", "artifacts", "model_metadata.json")

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

CONTRACTS_VERIFIER_DEST = os.path.join(REPO_ROOT, "contracts", "EzklVerifier.sol")

# A sample near-boundary position (matches the kind of case that would
# route to Tier 2 in the tiering policy) - feature order must match
# off-chain/risk_model/features.py: FEATURE_NAMES.
SAMPLE_FEATURES = [0.90, 0.30, -0.10, 5.0, 200.0]


def step(msg):
    print(f"\n=== {msg} ===")


def main():
    if not os.path.exists(ONNX_SOURCE):
        print(f"ERROR: {ONNX_SOURCE} not found.")
        print("Run `python -m risk_model.train` from the off-chain/ directory first.")
        sys.exit(1)

    shutil.copy(ONNX_SOURCE, ONNX_PATH)
    shutil.copy(METADATA_SOURCE, os.path.join(CIRCUITS_DIR, "model_metadata.json"))

    # --- 1. Generate circuit settings ---
    step("1/9 Generating circuit settings")
    run_args = ezkl.PyRunArgs()
    run_args.input_visibility = "private"   # borrower features stay off-chain
    run_args.param_visibility = "private"   # model weights stay confidential
    run_args.output_visibility = "public"   # the risk score is the public claim being proven
    ezkl.gen_settings(ONNX_PATH, SETTINGS_PATH, run_args)
    print("Wrote", SETTINGS_PATH)

    # --- 2. Build calibration data and calibrate settings ---
    step("2/9 Calibrating settings against sample data")
    sys.path.insert(0, os.path.join(REPO_ROOT, "off-chain"))
    from risk_model.synthetic_data import generate_synthetic_dataset  # noqa: E402

    X, _y, _scores = generate_synthetic_dataset(n_samples=32, seed=123)
    with open(CALIBRATION_PATH, "w") as f:
        json.dump({"input_data": [X.flatten().tolist()]}, f)
    ezkl.calibrate_settings(CALIBRATION_PATH, ONNX_PATH, SETTINGS_PATH, "resources")

    with open(SETTINGS_PATH) as f:
        settings = json.load(f)
    logrows = settings["run_args"]["logrows"]
    print(f"Calibrated. logrows={logrows}, input_scale={settings['run_args']['input_scale']}")

    # --- 3. Compile the circuit ---
    step("3/9 Compiling circuit")
    ezkl.compile_circuit(ONNX_PATH, COMPILED_PATH, SETTINGS_PATH)
    print("Wrote", COMPILED_PATH, f"({os.path.getsize(COMPILED_PATH)} bytes)")

    # --- 4. Generate the SRS locally (see module docstring caveat #1) ---
    step("4/9 Generating structured reference string (local, self-generated)")
    ezkl.gen_srs(SRS_PATH, logrows)
    print("Wrote", SRS_PATH, f"({os.path.getsize(SRS_PATH)} bytes)")

    # --- 5. Setup: generate proving + verification keys ---
    step("5/9 Running setup (generating proving/verification keys)")
    t0 = time.time()
    ezkl.setup(COMPILED_PATH, VK_PATH, PK_PATH, SRS_PATH)
    print(f"Setup complete in {time.time() - t0:.1f}s.")
    print(f"  pk.key: {os.path.getsize(PK_PATH)} bytes, vk.key: {os.path.getsize(VK_PATH)} bytes")

    # --- 6. Generate a witness for the sample input ---
    step("6/9 Generating witness for sample position")
    with open(INPUT_PATH, "w") as f:
        json.dump({"input_data": [SAMPLE_FEATURES]}, f)
    ezkl.gen_witness(INPUT_PATH, COMPILED_PATH, WITNESS_PATH)
    with open(WITNESS_PATH) as f:
        witness = json.load(f)
    print("Rescaled outputs (label, [P(class0), P(class1)]):",
          witness["pretty_elements"]["rescaled_outputs"])

    # --- 7. Generate the proof ---
    step("7/9 Generating zk-SNARK proof")
    t0 = time.time()
    ezkl.prove(WITNESS_PATH, COMPILED_PATH, PK_PATH, PROOF_PATH, SRS_PATH)
    proving_time = time.time() - t0
    print(f"Proof generated in {proving_time:.1f}s.  Wrote {PROOF_PATH} "
          f"({os.path.getsize(PROOF_PATH)} bytes)")

    # --- 8. Verify locally ---
    step("8/9 Verifying proof locally")
    t0 = time.time()
    valid = ezkl.verify(PROOF_PATH, SETTINGS_PATH, VK_PATH, SRS_PATH)
    verify_time = time.time() - t0
    print(f"Local verification: {valid} (in {verify_time:.3f}s)")
    if not valid:
        print("ERROR: proof failed local verification. Stopping before generating a verifier.")
        sys.exit(1)

    # --- 9. Generate the Solidity verifier + EVM calldata ---
    step("9/9 Generating Solidity verifier and EVM calldata")

    async def _generate_verifier():
        # NOTE: not declared as a coroutine by ezkl's Python type stubs /
        # inspect.iscoroutinefunction, but it returns a Future that must be
        # awaited from within a running event loop - see module docstring.
        return await ezkl.create_evm_verifier(VK_PATH, SETTINGS_PATH, VERIFIER_SOL_PATH, VERIFIER_ABI_PATH, SRS_PATH)

    try:
        asyncio.run(_generate_verifier())
    except Exception as e:
        # EZKL's internal solc-based sanity check can fail in network-
        # restricted environments (it tries to fetch a solc binary via
        # svm-rs). Verifier.sol is written to disk before that check runs,
        # so this is not fatal - Hardhat's own (already-working) solc
        # toolchain compiles it correctly regardless. See module docstring
        # caveat #2.
        print(f"NOTE: create_evm_verifier's internal solc post-check failed ({e}).")
        if os.path.exists(VERIFIER_SOL_PATH):
            print(f"{VERIFIER_SOL_PATH} was still written successfully - continuing.")
        else:
            print("ERROR: Verifier.sol was not written. Cannot continue.")
            sys.exit(1)

    ezkl.encode_evm_calldata(PROOF_PATH, CALLDATA_PATH)
    print(f"Wrote {CALLDATA_PATH} ({os.path.getsize(CALLDATA_PATH)} bytes) - "
          f"ready-to-send calldata for verifyProof(bytes,uint256[])")

    # Copy the generated verifier into contracts/, with a provenance header,
    # ready for `npx hardhat compile` / deployment.
    with open(VERIFIER_SOL_PATH) as f:
        verifier_source = f.read()
    header = (
        "// SPDX-License-Identifier: MIT\n\n"
        "// =============================================================================\n"
        "// AUTO-GENERATED by EZKL (ezkl.create_evm_verifier) - DO NOT HAND-EDIT.\n"
        "// Regenerate via circuits/build_circuit.py if the risk model changes.\n"
        "// =============================================================================\n\n"
    )
    verifier_body = verifier_source.split("pragma solidity", 1)[1]
    with open(CONTRACTS_VERIFIER_DEST, "w") as f:
        f.write(header + "pragma solidity" + verifier_body)
    print(f"Copied verifier to {CONTRACTS_VERIFIER_DEST}")

    print("\n=== Done. Summary ===")
    print(f"  Proving time:       {proving_time:.1f}s")
    print(f"  Local verify time:  {verify_time:.3f}s")
    print(f"  Proof size:         {os.path.getsize(PROOF_PATH)} bytes")
    print(f"  Circuit logrows:    {logrows}")
    print("\nNext: `npx hardhat compile` from the repo root, then run")
    print("test/EzklIntegration.test.js to verify this proof on-chain end to end.")


if __name__ == "__main__":
    main()
