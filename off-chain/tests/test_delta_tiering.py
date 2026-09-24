import pytest

from router.delta import compute_delta
from router.tiering import decide_tier, Tier, TIER_1_BAND, TIER_2_BAND


class TestComputeDelta:
    def test_safe_position_has_positive_delta(self):
        result = compute_delta(ltv=0.50, liquidation_threshold=0.80)
        assert result.delta == pytest.approx(0.30)

    def test_position_at_threshold_has_zero_delta(self):
        result = compute_delta(ltv=0.80, liquidation_threshold=0.80)
        assert result.delta == pytest.approx(0.0)

    def test_breached_position_has_negative_delta(self):
        result = compute_delta(ltv=0.95, liquidation_threshold=0.80)
        assert result.delta == pytest.approx(-0.15)

    def test_rejects_negative_ltv(self):
        with pytest.raises(ValueError):
            compute_delta(ltv=-0.1, liquidation_threshold=0.80)

    def test_rejects_out_of_range_threshold(self):
        with pytest.raises(ValueError):
            compute_delta(ltv=0.5, liquidation_threshold=0.0)
        with pytest.raises(ValueError):
            compute_delta(ltv=0.5, liquidation_threshold=2.0)


class TestDecideTier:
    def test_far_from_boundary_routes_to_heuristic(self):
        delta_result = compute_delta(ltv=0.40, liquidation_threshold=0.80)  # delta = 0.40
        decision = decide_tier(delta_result)
        assert decision.tier == Tier.HEURISTIC

    def test_just_above_tier1_band_routes_to_heuristic(self):
        # delta slightly greater than TIER_1_BAND
        ltv = 0.80 - (TIER_1_BAND + 0.01)
        decision = decide_tier(compute_delta(ltv=ltv, liquidation_threshold=0.80))
        assert decision.tier == Tier.HEURISTIC

    def test_within_watch_band_routes_to_commitment(self):
        # delta strictly between TIER_2_BAND and TIER_1_BAND
        ltv = 0.80 - (TIER_1_BAND + TIER_2_BAND) / 2
        decision = decide_tier(compute_delta(ltv=ltv, liquidation_threshold=0.80))
        assert decision.tier == Tier.COMMITMENT

    def test_just_below_tier2_band_routes_to_zkproof(self):
        # delta just under TIER_2_BAND should fall into ZK_PROOF (<=).
        # Uses a small offset rather than the exact boundary value to avoid
        # asserting on float-precision artifacts at the boundary itself
        # (e.g. 0.80 - 0.05 does not always equal exactly 0.05 in IEEE 754).
        ltv = 0.80 - (TIER_2_BAND - 0.001)
        decision = decide_tier(compute_delta(ltv=ltv, liquidation_threshold=0.80))
        assert decision.tier == Tier.ZK_PROOF

    def test_just_above_tier2_band_routes_to_commitment(self):
        ltv = 0.80 - (TIER_2_BAND + 0.001)
        decision = decide_tier(compute_delta(ltv=ltv, liquidation_threshold=0.80))
        assert decision.tier == Tier.COMMITMENT

    def test_within_critical_band_routes_to_zkproof(self):
        ltv = 0.80 - (TIER_2_BAND / 2)
        decision = decide_tier(compute_delta(ltv=ltv, liquidation_threshold=0.80))
        assert decision.tier == Tier.ZK_PROOF

    def test_already_breached_position_routes_to_zkproof(self):
        decision = decide_tier(compute_delta(ltv=0.95, liquidation_threshold=0.80))
        assert decision.tier == Tier.ZK_PROOF
        assert decision.delta < 0

    def test_tier_ordering_is_monotonic_in_delta(self):
        # As LTV increases (delta decreases), tier should never decrease
        # in strength - i.e. no position closer to the boundary should
        # get a *weaker* tier than one further away.
        ltvs = [0.30, 0.50, 0.60, 0.68, 0.72, 0.76, 0.79, 0.80, 0.85, 0.95]
        tiers = [decide_tier(compute_delta(ltv=l, liquidation_threshold=0.80)).tier for l in ltvs]
        for earlier, later in zip(tiers, tiers[1:]):
            assert later >= earlier
