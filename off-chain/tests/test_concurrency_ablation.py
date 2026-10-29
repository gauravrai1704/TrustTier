"""Tests for evaluation/concurrency_ablation.py."""

from evaluation.concurrency_ablation import (
    make_contended_batch,
    positions_to_txs,
    run_contention_ablation,
    run_size_ablation,
    run_tier_mix_ablation,
)


def test_positions_to_txs_assigns_a_valid_tier_to_every_position():
    txs = positions_to_txs(range(1, 21), seed=1)
    assert len(txs) == 20
    for tx in txs:
        assert tx["tier"] in ("HEURISTIC", "COMMITMENT", "ZKPROOF")


def test_positions_to_txs_is_deterministic_for_a_fixed_seed():
    a = positions_to_txs(range(1, 51), seed=7)
    b = positions_to_txs(range(1, 51), seed=7)
    assert a == b


def test_make_contended_batch_has_requested_size():
    txs = make_contended_batch(100, 0.2, seed=0)
    assert len(txs) == 100


def test_make_contended_batch_zero_contention_is_all_distinct_positions():
    txs = make_contended_batch(50, 0.0, seed=0)
    ids = [tx["position_id"] for tx in txs]
    assert len(set(ids)) == 50


def test_make_contended_batch_higher_contention_means_fewer_distinct_positions():
    low = make_contended_batch(200, 0.05, seed=1)
    high = make_contended_batch(200, 0.5, seed=1)
    distinct_low = len(set(tx["position_id"] for tx in low))
    distinct_high = len(set(tx["position_id"] for tx in high))
    assert distinct_high < distinct_low


def test_run_size_ablation_old_design_scales_linearly_with_n():
    rows = run_size_ablation(sizes=(10, 20, 40))
    for r in rows:
        assert r["old_rounds"] == r["n"]  # fully serial: one tx per round


def test_run_size_ablation_new_design_stays_at_one_round_with_no_contention():
    rows = run_size_ablation(sizes=(10, 20, 40, 80))
    for r in rows:
        assert r["new_rounds"] == 1


def test_run_contention_ablation_rounds_never_exceed_old_design_rounds():
    rows = run_contention_ablation(n=100, contention_rates=(0.0, 0.1, 0.3))
    for r in rows:
        assert r["new_rounds"] <= r["old_rounds"]


def test_run_contention_ablation_more_contention_does_not_decrease_rounds_needed():
    # Each contention level re-seeds its own random batch, so the exact
    # rounds-needed curve need not be strictly monotonic step-by-step - but
    # the overall trend from zero to heavy contention should still need
    # more rounds, and never regress below the zero-contention baseline.
    rows = run_contention_ablation(n=200, contention_rates=(0.0, 0.1, 0.2, 0.3, 0.5))
    baseline = rows[0]["new_rounds"]
    assert baseline == 1
    for r in rows[1:]:
        assert r["new_rounds"] >= baseline
    assert rows[-1]["new_rounds"] >= rows[1]["new_rounds"]


def test_run_tier_mix_ablation_does_not_change_achievable_rounds():
    rows = run_tier_mix_ablation(n=150)
    rounds = {r["new_rounds"] for r in rows}
    # All scenarios should need the same number of rounds (no contention in
    # this ablation, so tier composition is the only thing varying).
    assert len(rounds) == 1
