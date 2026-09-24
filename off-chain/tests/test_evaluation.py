import pytest

from evaluation.real_data import load_real_positions
from evaluation.cost_model import GAS_BY_TIER, TIER0_GAS, TIER1_GAS, TIER2_GAS
from evaluation.evaluate import summarize


class TestRealDataLoader:
    def test_loads_expected_number_of_snapshots(self):
        positions = load_real_positions()
        # 75 rows in the source CSV, minus 1 (the first row has zero debt / HF=inf)
        assert len(positions) == 74

    def test_ltv_derivation_matches_threshold_over_hf(self):
        positions = load_real_positions()
        # Spot-check the algebraic relationship: effective_ltv == threshold / HF
        # (before the 1.49 clip) for a position well within the clip range.
        p = positions[0]
        expected_ltv = p.liquidation_threshold / p.health_factor
        assert p.ltv == pytest.approx(min(expected_ltv, 1.49), abs=1e-6)

    def test_account_age_is_nondecreasing(self):
        positions = load_real_positions()
        ages = [p.account_age_days for p in positions]
        assert all(b >= a for a, b in zip(ages, ages[1:]))

    def test_real_trajectory_includes_a_below_boundary_position(self):
        # The real wallet's HF genuinely drops below 1.0 partway through
        # its history (see evaluation/data/README.md) - confirm the loader
        # preserves that, since it's the whole point of using this dataset.
        positions = load_real_positions()
        assert any(p.health_factor < 1.0 for p in positions)


class TestCostSimulation:
    def test_summarize_computes_correct_total_gas(self):
        results = [
            {"tier": "HEURISTIC", "model_flags_high_risk": False},
            {"tier": "COMMITMENT", "model_flags_high_risk": True},
            {"tier": "ZK_PROOF", "model_flags_high_risk": True},
        ]
        summary = summarize(results, "test")
        expected = TIER0_GAS + TIER1_GAS + TIER2_GAS
        assert summary["total_gas_trusttier"] == expected

    def test_always_tier2_is_never_cheaper_than_trusttier(self):
        # However positions are distributed across tiers, TrustTier's
        # total gas should never exceed always-verifying everyone, since
        # every tier's gas cost is <= TIER2_GAS.
        results = [{"tier": t, "model_flags_high_risk": False} for t in
                   ["HEURISTIC", "COMMITMENT", "ZK_PROOF", "HEURISTIC", "COMMITMENT"]]
        summary = summarize(results, "test")
        assert summary["total_gas_trusttier"] <= summary["total_gas_always_tier2"]

    def test_miss_rate_is_zero_when_no_tier0_positions(self):
        results = [{"tier": "ZK_PROOF", "model_flags_high_risk": True}]
        summary = summarize(results, "test")
        assert summary["tier0_count"] == 0
        assert summary["miss_rate_pct"] == 0.0

    def test_miss_rate_computed_correctly(self):
        results = [
            {"tier": "HEURISTIC", "model_flags_high_risk": True},
            {"tier": "HEURISTIC", "model_flags_high_risk": True},
            {"tier": "HEURISTIC", "model_flags_high_risk": False},
            {"tier": "HEURISTIC", "model_flags_high_risk": False},
        ]
        summary = summarize(results, "test")
        assert summary["tier0_high_risk_misses"] == 2
        assert summary["miss_rate_pct"] == pytest.approx(50.0)
