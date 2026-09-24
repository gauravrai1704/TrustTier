"""
Weeks 2-3 milestone demo: generates a synthetic stream of borrower
positions, routes each through the delta -> tier -> (model inference) ->
on-chain decision pipeline, and prints a summary report.

Run from the off-chain/ directory, after contracts are deployed and the
model is registered (see scripts/setup_chain.py):
    python -m scripts.run_synthetic_stream
"""

from risk_model.inference import RiskModel
from router.chain_client import ChainClient
from router.position_stream import generate_position_stream
from router.processor import PositionProcessor


def main():
    risk_model = RiskModel()
    chain = ChainClient()
    processor = PositionProcessor(chain_client=chain, risk_model=risk_model)

    positions = generate_position_stream(n_positions=12)
    print(f"Generated {len(positions)} synthetic positions.\n")

    results = []
    for position in positions:
        result = processor.process(position.position_id, position.to_features())
        results.append(result)
        print(
            f"position={result.position_id:>5}  ltv={result.ltv:.3f}  "
            f"delta={result.delta:+.4f}  tier={result.tier:<10}  "
            f"risk_score={('%.3f' % result.risk_score) if result.risk_score is not None else '   -  '}  "
            f"gas={result.gas_used}"
        )

    print("\n--- Summary ---")
    tier_counts = {}
    total_gas = 0
    for r in results:
        tier_counts[r.tier] = tier_counts.get(r.tier, 0) + 1
        total_gas += r.gas_used or 0

    for tier_name, count in tier_counts.items():
        print(f"  {tier_name:<10}: {count} position(s)")
    print(f"  Total gas used across {len(results)} decisions: {total_gas}")

    # No on-chain decisionCount() exists anymore (see TierAuditLog.sol's
    # concurrency design note - a shared counter would reintroduce the same
    # false-conflict problem the per-position mapping refactor removed).
    # Reconstruct the on-chain count from event logs instead, purely as a
    # sanity check that every decision this script made actually landed.
    on_chain_events = chain.get_decisions_via_events()
    print(f"\nOn-chain TierAuditLog emitted {len(on_chain_events)} DecisionLogged event(s) "
          f"(reconstructed from logs, not an on-chain counter - see chain_client.py).")

    all_tiers_hit = len(tier_counts) == 3
    print(
        "\nMilestone check: all three tiers exercised in this run -> "
        + ("PASS" if all_tiers_hit else "FAIL (re-run or check position_stream.py bands)")
    )


if __name__ == "__main__":
    main()
