"""
Per-tier cost constants used by evaluate.py, sourced from numbers we
actually measured - not estimates.

Re-generating a fresh EZKL proof for every position in a several-hundred-
position evaluation batch would take tens of minutes (each proof took
~25s in our Weeks 3-5 measurements) and would not change the result: proof
generation time and on-chain verification gas are properties of the
*circuit*, which is fixed once the risk model is fixed, not of any
individual input. Using one measured, representative cost per tier and
applying it via simulation at the tier-decision level is standard
methodology for cost-at-scale reporting in this literature (e.g. our own
baseline references report proving-cost benchmarks the same way, rather
than re-proving per evaluation sample).

Sources for each constant, in this repo's own test output:
  TIER0_GAS   - scripts/_measure_gas_tmp.js (a throwaway isolated
                measurement script, not kept in the repo), decideHeuristic()
  TIER1_GAS   - same script, decideCommitment()
  TIER2_GAS   - test/EzklIntegration.test.js, "reports realistic end-to-end
                gas cost for a full Tier-2 decision" (real EZKL proof,
                verified on the real Halo2Verifier, not the mock)
  TIER2_PROVING_SECONDS - circuits/build_circuit.py output

NOTE (Weeks 6-7 concurrency revision): all three figures below increased
slightly from their Weeks 1-5 values after LiquidationEngine gained a
per-position finalization lock (positionFinalized mapping - one extra
SLOAD+SSTORE per decision) and TierAuditLog switched from an
array-append to a per-position mapping (a different, not-necessarily-
cheaper SSTORE pattern, but one that removes false cross-transaction
conflicts - see the concurrency design note in TierAuditLog.sol and
concurrency_sim.py for why that trade is worth it). These are the
current, correct figures for the contracts as they stand after that change.
"""

TIER0_GAS = 129_200
TIER1_GAS = 219_766
TIER2_GAS = 1_031_709

TIER2_PROVING_SECONDS = 25.1  # off-chain proving cost, not gas - see circuits/build_circuit.py output

GAS_BY_TIER = {
    "HEURISTIC": TIER0_GAS,
    "COMMITMENT": TIER1_GAS,
    "ZK_PROOF": TIER2_GAS,
}
