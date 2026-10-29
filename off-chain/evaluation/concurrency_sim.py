"""
Concurrency simulation for the guide's comment: "Consider multiple
transactions in a block for execution; you may apply concurrency to
execute the multiple transactions concurrently and achieve better
performance."

This does NOT modify the EVM's actual (sequential-by-protocol) execution
model - no real Ethereum client executes transactions within a block in
parallel by default, and building one is far outside this project's scope.
What IS in scope, and what this script does, is the standard way parallel-
execution research (e.g. Block-STM, used by Aptos and Sui) measures
achievable parallelism: model each transaction's storage read/write set,
run a conflict-aware scheduler that greedily packs non-conflicting
transactions into the same execution "round", and report how many rounds
are needed. Fewer rounds = more of the batch could safely execute at once
under an optimistic-concurrency-control (OCC) execution engine.

Two designs are compared over the SAME batch of transactions (the 374
positions from the Weeks 5-6 evaluation):

  OLD design (contracts/TierAuditLog.sol before the Weeks 6-7 revision):
    every decideX() call ends in `decisions.push(...)`, writing to the
    shared array-length storage slot. Every transaction's write set
    therefore includes that one shared slot, so EVERY pair of transactions
    conflicts, regardless of which position they target.

  NEW design (current contracts): `TierAuditLog.decisionByPosition` is a
  mapping keyed by positionId, and `LiquidationEngine.positionFinalized`
  is likewise per-position. Two transactions for DIFFERENT positions now
  have entirely disjoint write sets and do not conflict; two transactions
  for the SAME position still (correctly) conflict, and the finalization
  lock means the second one would revert rather than corrupt state - see
  LiquidationEngine.sol's concurrency design note.

Run from the off-chain/ directory:
    python -m evaluation.concurrency_sim
"""

import os

from evaluation.real_data import load_real_positions
from router.delta import compute_delta
from router.position_stream import generate_position_stream
from router.tiering import decide_tier

REPORT_PATH = os.path.join(os.path.dirname(__file__), "results", "concurrency_report.md")

# A fixed shared storage slot every OLD-design transaction touches,
# regardless of position - this is what forces full serialization.
OLD_SHARED_ARRAY_SLOT = "TierAuditLog.decisions[length]"


def build_transactions():
    """
    Reuses the exact same 374-position batch (real + synthetic) as the
    Weeks 5-6 evaluation, so the concurrency result is measured against
    the same workload the cost-comparison numbers were.
    """
    real_positions = load_real_positions()
    synthetic_positions = generate_position_stream(n_positions=300, seed=99)

    txs = []
    for p in real_positions:
        delta_result = compute_delta(p.to_features()["ltv"], p.liquidation_threshold)
        tier = decide_tier(delta_result).tier.name
        txs.append({"position_id": p.position_id, "tier": tier})
    for p in synthetic_positions:
        delta_result = compute_delta(p.to_features()["ltv"], 0.80)
        tier = decide_tier(delta_result).tier.name
        txs.append({"position_id": p.position_id, "tier": tier})
    return txs


def read_write_sets_old_design(tx):
    """Storage footprint under the pre-Weeks-6-7 contracts (array-based audit log)."""
    position_id = tx["position_id"]
    reads = {f"ModelRegistry.isAuthorized[*]"} if tx["tier"] != "HEURISTIC" else set()
    writes = {OLD_SHARED_ARRAY_SLOT}  # the false-conflict-inducing shared write
    if tx["tier"] == "COMMITMENT":
        writes.add(f"LiquidationEngine.tier1Commitments[{position_id}]")
    return reads, writes


def read_write_sets_new_design(tx):
    """Storage footprint of one decide* call under the current contracts:
    the position's state in the lending protocol, the shared price and
    volatility feeds (read only), the per-position lock, and (Tier 0/1) the
    bond bookkeeping and feature snapshot.

    Global configuration (tier2Verifier, tier2ModelHash, the registry entry)
    is only read, never written by a decision, so it creates no conflicts.
    The bond's msg.value raises the engine's ETH balance in every Tier 0/1
    call; balance increments commute, and parallel engines treat them as
    commutative deltas (as Block-STM does for aggregators), so they are not
    modelled as a conflicting write here.
    """
    position_id = tx["position_id"]
    reads = {
        f"PositionSource.position[{position_id}]",
        "PriceFeed.latestRound", "PriceFeed.rounds[*]", "VolatilityFeed.latestRound",
        f"LiquidationEngine.state[{position_id}]",
    }
    if tx["tier"] != "HEURISTIC":
        reads.add("ModelRegistry.isAuthorized[*]")
    if tx["tier"] == "ZK_PROOF":
        reads |= {"LiquidationEngine.tier2Verifier", "LiquidationEngine.tier2ModelHash"}
    writes = {
        f"LiquidationEngine.state[{position_id}]",
        f"TierAuditLog.decisionByPosition[{position_id}]",
        f"TierAuditLog.hasDecision[{position_id}]",
    }
    if tx["tier"] in ("HEURISTIC", "COMMITMENT"):
        writes.add(f"LiquidationEngine.state[{position_id}].bond+snapshot")
    if tx["tier"] == "COMMITMENT":
        writes.add(f"LiquidationEngine.tier1Commitments[{position_id}]")
    return reads, writes


def conflicts(a, b):
    """Standard OCC conflict rule: read-read never conflicts; any other
    read/write pair touching the same key does."""
    a_reads, a_writes = a
    b_reads, b_writes = b
    if a_writes & b_writes:
        return True
    if a_writes & b_reads:
        return True
    if a_reads & b_writes:
        return True
    return False


def schedule_into_rounds(transactions, read_write_fn):
    """
    Greedy round-scheduling: process transactions in order, place each into
    the earliest round whose current occupants don't conflict with it.
    This is the same greedy strategy used to report achievable parallelism
    in the parallel-EVM/Block-STM literature - not a claim of optimality,
    but a standard, reproducible lower-bound-on-parallelism measurement.
    """
    rounds = []  # list of lists of (tx, rw) pairs
    for tx in transactions:
        rw = read_write_fn(tx)
        placed = False
        for round_txs in rounds:
            if not any(conflicts(rw, other_rw) for _, other_rw in round_txs):
                round_txs.append((tx, rw))
                placed = True
                break
        if not placed:
            rounds.append([(tx, rw)])
    return rounds


def main():
    transactions = build_transactions()
    n = len(transactions)
    print(f"Simulating {n} transactions (same batch as the Weeks 5-6 evaluation).\n")

    old_rounds = schedule_into_rounds(transactions, read_write_sets_old_design)
    new_rounds = schedule_into_rounds(transactions, read_write_sets_new_design)

    old_parallelism = n / len(old_rounds)
    new_parallelism = n / len(new_rounds)

    print(f"OLD design (array-based audit log):")
    print(f"  Rounds needed: {len(old_rounds)}")
    print(f"  Achieved parallelism: {old_parallelism:.2f}x (transactions per round, average)")
    print(f"  Largest round: {max(len(r) for r in old_rounds)} transaction(s)")

    print(f"\nNEW design (per-position mapping + finalization lock):")
    print(f"  Rounds needed: {len(new_rounds)}")
    print(f"  Achieved parallelism: {new_parallelism:.2f}x (transactions per round, average)")
    print(f"  Largest round: {max(len(r) for r in new_rounds)} transaction(s)")

    speedup = len(old_rounds) / len(new_rounds)
    print(f"\nSpeedup in achievable parallel rounds: {speedup:.1f}x fewer rounds needed")

    os.makedirs(os.path.dirname(REPORT_PATH), exist_ok=True)
    content = f"""# TrustTier Weeks 6-7 Concurrency Simulation

Generated by `off-chain/evaluation/concurrency_sim.py`, in response to the
guide's comment: *"Consider multiple transactions in a block for
execution; you may apply concurrency to execute the multiple transactions
concurrently and achieve better performance."*

## Method

This models each transaction's storage read/write set under two contract
designs and runs a greedy optimistic-concurrency-control (OCC) scheduler -
the same style of analysis used to report achievable parallelism in the
parallel-execution literature (e.g. Block-STM) - rather than modifying any
real EVM's (sequential-by-protocol) execution model, which is out of
scope for this project. The same {n}-transaction batch from the Weeks 5-6
evaluation (74 real + 300 synthetic positions) is scheduled under both
designs.

## Results

| Design | Rounds needed | Achieved parallelism | Largest round |
|---|---|---|---|
| OLD (array-based audit log) | {len(old_rounds)} | {old_parallelism:.2f}x | {max(len(r) for r in old_rounds)} |
| NEW (per-position mapping + finalization lock) | {len(new_rounds)} | {new_parallelism:.2f}x | {max(len(r) for r in new_rounds)} |

**{speedup:.1f}x fewer rounds needed** under the new design.

## Why

The old `TierAuditLog` wrote every decision via `decisions.push(...)`,
touching the shared array-length storage slot on every single call -
regardless of which position the transaction was for. Under any conflict-
aware concurrent execution engine, that one shared write makes every
transaction in the batch conflict with every other, forcing full
serialization (1 transaction per round) no matter how independent the
underlying positions actually are.

The refactored `TierAuditLog` (`decisionByPosition` mapping) and
`LiquidationEngine` (`positionFinalized` mapping) confine each
transaction's writes to keys scoped by `positionId`. Two transactions for
different positions now have provably disjoint write sets and can execute
in the same round; two transactions for the *same* position still
(correctly) conflict - and are additionally now prevented outright by the
finalization lock, which reverts the second one rather than allowing a
race to silently corrupt the audit trail.

## Limitation

This is an idealized upper-bound demonstration: our {n}-transaction batch
happens to target {len(set(tx['position_id'] for tx in transactions))}
distinct positions (i.e. very few genuine same-position collisions), so
the new design's achievable parallelism here is close to the best case.
Real production traffic would include some fraction of transactions
racing for the same position (competing liquidator bots), which would
correctly still serialize - see `LiquidationEngine.test.js`'s
finalization-lock tests for that behavior.
"""
    with open(REPORT_PATH, "w") as f:
        f.write(content)
    print(f"\nWrote {REPORT_PATH}")


if __name__ == "__main__":
    main()
