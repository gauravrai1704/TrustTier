"""
Real Tier-2 proving: an EZKL (Halo2/KZG) proof that the registered risk model,
run on a position's quantized on-chain features q (see
risk_model/onchain_features.py), outputs the claimed label.

The circuit's inputs are PUBLIC: the proof's instances are
[q_ltv, q_vol, q_mom, q_topup, q_age, label, P(low)*2^10, P(high)*2^10], and
LiquidationEngine checks the first five against the values it reads from
the lending protocol and Chainlink feeds itself. Only the model weights are
private.

Requires the circuit artifacts (network.compiled, pk.key, kzg.srs). pk.key is
not shipped; `python3 make_proving_key.py` in circuits/ rebuilds it.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from dataclasses import dataclass
from typing import Sequence

from eth_abi import decode

from risk_model.onchain_features import to_model_input

CIRCUITS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "circuits"))

# Public-instance layout (must match LiquidationEngine's constants).
N_FEATURES = 5
INSTANCE_LABEL = 5


@dataclass
class Tier2Proof:
    proof: bytes
    public_inputs: list[int]
    seconds: float

    @property
    def features(self) -> list[int]:
        return self.public_inputs[:N_FEATURES]

    @property
    def label(self) -> int:
        return self.public_inputs[INSTANCE_LABEL]

    @property
    def high_risk(self) -> bool:
        return self.label == 1


def decode_evm_calldata(calldata: bytes) -> tuple[bytes, list[int]]:
    """Split EZKL's verifyProof(bytes,uint256[]) calldata into its arguments."""
    proof, instances = decode(["bytes", "uint256[]"], calldata[4:])
    return proof, [int(x) for x in instances]


class EzklProver:
    def __init__(self, circuits_dir: str = CIRCUITS_DIR):
        self.dir = circuits_dir
        self.compiled = os.path.join(circuits_dir, "network.compiled")
        self.pk = os.path.join(circuits_dir, "pk.key")
        self.srs = os.path.join(circuits_dir, "kzg.srs")

    def available(self) -> bool:
        return all(os.path.exists(p) for p in (self.compiled, self.pk, self.srs))

    def prove(self, q: Sequence[int]) -> Tier2Proof:
        """Prove the model's output on the quantized feature vector q."""
        import ezkl

        if not self.available():
            raise FileNotFoundError("EZKL artifacts missing - run `python3 make_proving_key.py` in circuits/")
        if len(q) != N_FEATURES or not all(0 <= int(x) <= 1024 for x in q):
            raise ValueError(f"q must be {N_FEATURES} integers in [0, 1024], got {list(q)}")
        t0 = time.time()
        with tempfile.TemporaryDirectory() as tmp:
            inp, wit, prf, cd = (os.path.join(tmp, n) for n in ("in.json", "wit.json", "proof.json", "cd.bytes"))
            with open(inp, "w") as f:
                json.dump({"input_data": [to_model_input([int(x) for x in q])]}, f)
            ezkl.gen_witness(inp, self.compiled, wit)
            ezkl.prove(wit, self.compiled, self.pk, prf, self.srs)
            ezkl.encode_evm_calldata(prf, cd)
            with open(cd, "rb") as f:
                proof, instances = decode_evm_calldata(f.read())
        if instances[:N_FEATURES] != [int(x) for x in q]:
            raise RuntimeError(f"instance layout changed: expected features {list(q)}, got {instances[:N_FEATURES]}")
        return Tier2Proof(proof=proof, public_inputs=instances, seconds=time.time() - t0)
