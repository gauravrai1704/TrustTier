"""
End-to-end demo: opens a synthetic stream of positions in MockLendingPool
(spread across the deployed markets), then routes each one: the router reads
the engine's own features and delta, picks the tier the chain allows, runs
the model and submits the decision. Prints a summary report.

Run from the off-chain/ directory, after contracts are deployed and the
model is registered (see scripts/setup_chain.py):
    python -m scripts.run_synthetic_stream
"""

import sys
import time

from risk_model.inference import RiskModel
from router.chain_client import ChainClient
from router.position_stream import generate_onchain_stream
from router.processor import PositionProcessor


def main():
    risk_model = RiskModel()
    chain = ChainClient()
    processor = PositionProcessor(chain_client=chain, risk_model=risk_model)

    n = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    start_id = 2_000_000 + int(time.time()) % 1_000_000 * 100  # fresh IDs on every run
    chain.refresh_mock_feeds()
    specs = generate_onchain_stream(chain.markets, n_positions=n, start_id=start_id)
    print(f"Opening {len(specs)} positions in MockLendingPool across {len(chain.markets)} markets.\n")

    results = []
    for spec in specs:
        chain.open_demo_position(spec.position_id, spec.market, spec.ltv, spec.age_days, spec.topup_days)
        result = processor.process(spec.position_id)
        results.append(result)
        print(
            f"position={result.position_id:>5}  ltv={result.ltv:.3f}  q={result.features_q}  "
            f"delta={result.delta_bps:+5d}bps  tier={result.tier:<10}  "
            f"risk_score={('%.3f' % result.risk_score) if result.risk_score is not None else '   -  '}  "
            f"gas={result.gas_used}  {result.outcome}"
            + (f"  proof={result.proof_kind} {result.proving_seconds}s" if result.proof_kind else "")
        )

    print("\n--- Summary ---")
    tier_counts = {}
    total_gas = 0
    for r in results:
        tier_counts[r.tier] = tier_counts.get(r.tier, 0) + 1
        total_gas += r.gas_used or 0

    for tier_name, count in tier_counts.items():
        print(f"  {tier_name:<10}: {count} position(s)")
    print(f"  Total decision gas (features computed on-chain) across {len(results)} positions: {total_gas}")
    print(f"  Not liquidated (Tier-2 proof showed low risk): {sum(r.outcome == 'NOT_LIQUIDATED' for r in results)}")

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
