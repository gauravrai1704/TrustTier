"""
Regenerate circuits/pk.key (~575 MB, not shipped) from the shipped SRS and
compiled circuit. EZKL's setup is deterministic for a given SRS
and circuit, so the result matches the shipped vk.key - and therefore the
deployed Halo2Verifier - byte for byte; this script checks that.

    cd circuits && python3 make_proving_key.py

Use build_circuit.py instead only if you change the model or the circuit
(it regenerates the SRS, keys, verifier and sample proofs).
"""

import filecmp
import os
import sys
import tempfile
import time

import ezkl

HERE = os.path.dirname(os.path.abspath(__file__))
COMPILED = os.path.join(HERE, "network.compiled")
SRS = os.path.join(HERE, "kzg.srs")
VK = os.path.join(HERE, "vk.key")
PK = os.path.join(HERE, "pk.key")

for path in (COMPILED, SRS, VK):
    if not os.path.exists(path):
        sys.exit(f"missing {path} - run build_circuit.py instead")

with tempfile.TemporaryDirectory() as tmp:
    vk_new = os.path.join(tmp, "vk.key")
    t0 = time.time()
    ezkl.setup(COMPILED, vk_new, PK, SRS)
    if not filecmp.cmp(VK, vk_new, shallow=False):
        os.remove(PK)
        sys.exit("verification key differs from the shipped vk.key - run build_circuit.py instead")
print(f"Wrote {PK} ({os.path.getsize(PK) / 1e6:.0f} MB) in {time.time() - t0:.1f}s; "
      "matches the shipped verification key and verifier.")
