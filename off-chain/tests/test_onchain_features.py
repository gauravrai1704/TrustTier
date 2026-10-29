"""
Tests for the verified-input pipeline's off-chain half:
  - risk_model/onchain_features.py, the Python mirror of the contract's
    feature arithmetic (cross-checked against the real proofs' instances);
  - router/tiering.decide_tier_bps, the mirror of the contract's tier rule;
  - router/commitment.py over quantized features;
  - ChainClient.find_past_round, the 24-hour round search.
"""

import json
import os
import unittest

from risk_model.inference import RiskModel
from risk_model.onchain_features import OnchainPosition, delta_bps, ltv_bps, quantize, to_model_input
from router.chain_client import ChainClient, MOMENTUM_WINDOW
from router.commitment import compute_commitment_hash, new_salt, verify_commitment
from router.tiering import TIER0_MIN_DELTA_BPS, TIER1_MIN_DELTA_BPS, Tier, decide_tier_bps

SAMPLES = os.path.join(os.path.dirname(__file__), "..", "..", "circuits", "samples.json")
NOW = 1_800_000_000
DAY = 86_400


def _sample_position(s):
    return OnchainPosition(s["collateral_usd"], s["debt_usd"], s["liquidation_threshold_bps"],
                           NOW - s["age_days"] * DAY, NOW - s["topup_days_ago"] * DAY)


class TestQuantization(unittest.TestCase):
    def test_matches_the_real_proofs_public_inputs(self):
        with open(SAMPLES) as f:
            samples = json.load(f)["samples"]
        self.assertGreaterEqual(len(samples), 3)
        for s in samples:
            q = quantize(_sample_position(s), s["price_now"], s["price_past"], s["vol_answer"], s["vol_decimals"], NOW)
            self.assertEqual(q, s["q"], s["name"])
            self.assertEqual(q, [int(x) for x in s["public_inputs"][:5]], s["name"])

    def test_model_label_on_q_matches_the_proven_label(self):
        model = RiskModel()
        with open(SAMPLES) as f:
            for s in json.load(f)["samples"]:
                self.assertEqual(model.predict_q(s["q"])[0], s["label"], s["name"])

    def test_hand_computed_values(self):
        pos = OnchainPosition(2000 * 10**8, 1860 * 10**8, 8000, NOW - 200 * DAY, NOW - 5 * DAY)
        self.assertEqual(quantize(pos, 2000 * 10**8, 2200 * 10**8, 35 * 10**8, 8, NOW), [634, 358, 465, 56, 102])
        self.assertEqual(ltv_bps(pos), 9300)
        self.assertEqual(delta_bps(pos), -1300)

    def test_clamps_every_feature(self):
        pos = OnchainPosition(100, 1000, 8000, NOW - 10_000 * DAY, NOW - 500 * DAY)
        q = quantize(pos, 10 * 10**8, 10**8, 300 * 10**8, 8, NOW)
        self.assertEqual(q, [1024, 1024, 1024, 1024, 1024])

    def test_partial_days_round_down(self):
        pos = OnchainPosition(10**8, 0, 8000, NOW - DAY + 1, NOW - 2 * DAY + 1)
        q = quantize(pos, 10**8, 10**8, 0, 8, NOW)
        self.assertEqual(q[3:], [1 * 1024 // 90, 0])

    def test_rejects_empty_position(self):
        with self.assertRaises(ValueError):
            quantize(OnchainPosition(0, 0, 8000, NOW, NOW), 1, 1, 1, 8, NOW)

    def test_model_input_is_q_over_1024(self):
        self.assertEqual(to_model_input([0, 512, 1024, 256, 768]), [0.0, 0.5, 1.0, 0.25, 0.75])


class TestTierRule(unittest.TestCase):
    def test_boundaries_match_the_contract(self):
        self.assertEqual(decide_tier_bps(TIER0_MIN_DELTA_BPS + 1).tier, Tier.HEURISTIC)
        self.assertEqual(decide_tier_bps(TIER0_MIN_DELTA_BPS).tier, Tier.COMMITMENT)
        self.assertEqual(decide_tier_bps(TIER1_MIN_DELTA_BPS + 1).tier, Tier.COMMITMENT)
        self.assertEqual(decide_tier_bps(TIER1_MIN_DELTA_BPS).tier, Tier.ZK_PROOF)
        self.assertEqual(decide_tier_bps(-5000).tier, Tier.ZK_PROOF)

    def test_constants_match_the_solidity_source(self):
        src = open(os.path.join(os.path.dirname(__file__), "..", "..", "contracts", "LiquidationEngine.sol")).read()
        self.assertIn(f"TIER0_MIN_DELTA_BPS = {TIER0_MIN_DELTA_BPS};", src)
        self.assertIn(f"TIER1_MIN_DELTA_BPS = {TIER1_MIN_DELTA_BPS};", src)


class TestCommitment(unittest.TestCase):
    def test_round_trip_and_binding(self):
        salt = new_salt()
        h = compute_commitment_hash([491, 358, 465, 682, 15], 0.7675, salt)
        self.assertTrue(verify_commitment(h, [491, 358, 465, 682, 15], 0.7675, salt))
        self.assertFalse(verify_commitment(h, [491, 358, 465, 682, 16], 0.7675, salt))
        self.assertFalse(verify_commitment(h, [491, 358, 465, 682, 15], 0.7676, salt))
        self.assertFalse(verify_commitment(h, [491, 358, 465, 682, 15], 0.7675, new_salt()))

    def test_salt_length_enforced(self):
        with self.assertRaises(ValueError):
            compute_commitment_hash([1, 2, 3, 4, 5], 0.5, b"short")


class _Call:
    def __init__(self, value=None, exc=None):
        self.value, self.exc = value, exc

    def call(self):
        if self.exc:
            raise self.exc
        return self.value


class _FakeFeed:
    """Rounds with given update times, ids optionally phase-encoded."""
    def __init__(self, times, phase=0):
        base = phase << 64
        self.rounds = {base + i + 1: t for i, t in enumerate(times)}
        self.latest = max(self.rounds)

    def latestRoundData(self):
        return _Call((self.latest, 1, 0, self.rounds[self.latest], self.latest))

    def getRoundData(self, rid):
        if rid not in self.rounds:
            return _Call(exc=ValueError("no data"))
        return _Call((rid, 1, 0, self.rounds[rid], rid))


class _FakeContract:
    def __init__(self, feed):
        self.functions = feed


def _client_with(feed):
    c = ChainClient.__new__(ChainClient)
    c.feed = lambda addr: _FakeContract(feed)
    return c


class TestFindPastRound(unittest.TestCase):
    def _brute(self, times, now):
        target = now - MOMENTUM_WINDOW
        return max(i + 1 for i, t in enumerate(times) if t <= target)

    def test_hourly_rounds(self):
        now = NOW
        times = [now - 72 * 3600 + h * 3600 for h in range(72)]
        c = _client_with(_FakeFeed(times))
        self.assertEqual(c.find_past_round("0x0", now), self._brute(times, now))

    def test_irregular_rounds_against_brute_force(self):
        import random
        rng = random.Random(3)
        for _ in range(50):
            t, times = NOW - 5 * DAY, []
            while t < NOW:
                t += rng.randint(60, 20_000)
                times.append(min(t, NOW))
            if times[0] > NOW - MOMENTUM_WINDOW:
                continue
            c = _client_with(_FakeFeed(times))
            self.assertEqual(c.find_past_round("0x0", NOW), self._brute(times, NOW))

    def test_latest_round_older_than_a_day(self):
        c = _client_with(_FakeFeed([NOW - 3 * DAY, NOW - 2 * DAY]))
        self.assertEqual(c.find_past_round("0x0", NOW), 2)

    def test_phase_encoded_ids(self):
        times = [NOW - 30 * 3600 + h * 3600 for h in range(30)]
        c = _client_with(_FakeFeed(times, phase=3))
        self.assertEqual(c.find_past_round("0x0", NOW), (3 << 64) + self._brute(times, NOW))

    def test_no_round_old_enough(self):
        c = _client_with(_FakeFeed([NOW - 3600, NOW]))
        with self.assertRaises(LookupError):
            c.find_past_round("0x0", NOW)


if __name__ == "__main__":
    unittest.main()
