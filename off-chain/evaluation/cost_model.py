"""
Per-tier cost constants used by evaluate.py and the dashboard's cost panel,
read from MEASURED gas - never typed in by hand.

Source of truth: evaluation/results/gas_measurements.json, written by
    npx hardhat run scripts/measure_gas.js > off-chain/evaluation/results/gas_measurements.json
which deploys the contracts on a fresh chain and executes every entry point,
with the real EZKL verifier and real proofs for Tier 2.
(Earlier versions hard-coded these numbers here; they went stale when the
bonded challenge window was added, so the evaluation reported 51.4% savings
while the contracts actually delivered less. Reading the file removes that
failure mode, and tests/test_evaluation.py checks the wiring.)

There is no separate feature-oracle transaction any more: every decide*
call reads the position from the lending protocol and the Chainlink feeds
itself, computes the five features and delta, and enforces the tier. That
work is inside each measured decision, so the decision gas IS the full
per-position cost.

Re-generating a fresh EZKL proof for every position in a several-hundred-
position evaluation would take hours and change nothing: proving time and
verification gas are properties of the fixed circuit, not of the input.
"""

import json
import os

_MEASUREMENTS = os.path.join(os.path.dirname(__file__), "results", "gas_measurements.json")

with open(_MEASUREMENTS) as _f:
    MEASURED = json.load(_f)

# Gas of the full decision per tier (features computed on-chain). A Tier-1
# claim is only complete once its commitment is opened (an unopened one
# forfeits its bond), so its cost includes revealCommitment.
REVEAL_GAS = MEASURED["revealCommitment"]
DECISION_GAS_BY_TIER = {
    "HEURISTIC": MEASURED["decideHeuristic"],
    "COMMITMENT": MEASURED["decideCommitment"] + REVEAL_GAS,
    "ZK_PROOF": MEASURED["decideZkProof"],
}

TIER0_GAS = DECISION_GAS_BY_TIER["HEURISTIC"]
TIER1_GAS = DECISION_GAS_BY_TIER["COMMITMENT"]
TIER2_GAS = DECISION_GAS_BY_TIER["ZK_PROOF"]

GAS_BY_TIER = dict(DECISION_GAS_BY_TIER)

CHALLENGE_GAS = MEASURED["challengeDecision"]
COMMITTED_CHALLENGE_GAS = MEASURED["commitChallenge"] + MEASURED["revealChallenge"]
LIQUIDATE_GAS = MEASURED["liquidate"]

# Off-chain proving time for one Tier-2 proof (EZKL, 2^16-row circuit): the
# mean of the sample proofs circuits/build_circuit.py generated and timed on
# the reference machine (circuits/samples.json). Not gas.
_SAMPLES = os.path.join(os.path.dirname(__file__), "..", "..", "circuits", "samples.json")
with open(_SAMPLES) as _f:
    _seconds = [s["proving_seconds"] for s in json.load(_f)["samples"]]
TIER2_PROVING_SECONDS = round(sum(_seconds) / len(_seconds), 1)
