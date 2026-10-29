"""Tests for sentinel/detectors.py - pure logic, no chain required."""

from sentinel.detectors import (
    Alert,
    SentinelState,
    check_challenge_alert,
    check_rate_anomaly,
    evaluate_decision_event,
)


class TestChallengeAlert:
    def test_returns_a_critical_alert(self):
        event = {"positionId": 42, "challenger": "0xChallenger", "bond": 10**16}
        alert = check_challenge_alert(event)
        assert alert.severity == "critical"
        assert alert.rule == "challenge_succeeded"

    def test_message_includes_position_and_challenger(self):
        event = {"positionId": 7, "challenger": "0xABC", "bond": 10**16}
        alert = check_challenge_alert(event)
        assert "7" in alert.message
        assert "0xABC" in alert.message

    def test_alert_carries_position_id_and_address(self):
        event = {"positionId": 9, "challenger": "0xDEF", "bond": 5}
        alert = check_challenge_alert(event)
        assert alert.position_id == 9
        assert alert.address == "0xDEF"


class TestRateAnomaly:
    def test_no_alert_below_threshold(self):
        state = SentinelState()
        for i in range(5):
            alert = check_rate_anomaly(state, "0xBot", timestamp=i, max_decisions_in_window=10)
        assert alert is None

    def test_alert_once_threshold_exceeded(self):
        state = SentinelState()
        alert = None
        for i in range(12):
            alert = check_rate_anomaly(state, "0xBot", timestamp=i, max_decisions_in_window=10)
        assert alert is not None
        assert alert.severity == "warning"
        assert alert.rule == "rate_anomaly"

    def test_old_activity_outside_window_is_pruned(self):
        state = SentinelState()
        # 11 decisions all at t=0 - over threshold within the window.
        for _ in range(11):
            check_rate_anomaly(state, "0xBot", timestamp=0, window_seconds=300, max_decisions_in_window=10)
        # A single new decision far outside the window should not still be
        # flagged, since the old activity has aged out.
        alert = check_rate_anomaly(state, "0xBot", timestamp=10_000, window_seconds=300, max_decisions_in_window=10)
        assert alert is None

    def test_different_addresses_tracked_independently(self):
        state = SentinelState()
        for i in range(11):
            check_rate_anomaly(state, "0xBotA", timestamp=i, max_decisions_in_window=10)
        # 0xBotB has done nothing - must not inherit 0xBotA's count.
        alert = check_rate_anomaly(state, "0xBotB", timestamp=0, max_decisions_in_window=10)
        assert alert is None

    def test_alert_message_names_the_address_and_count(self):
        state = SentinelState()
        alert = None
        for i in range(12):
            alert = check_rate_anomaly(state, "0xSpammer", timestamp=i, max_decisions_in_window=10)
        assert "0xSpammer" in alert.message
        assert "12" in alert.message


class TestEvaluateDecisionEvent:
    def test_decision_challenged_always_produces_a_critical_alert(self):
        state = SentinelState()
        event = {"type": "DecisionChallenged", "positionId": 1, "challenger": "0xC", "bond": 10}
        alerts = evaluate_decision_event(state, event)
        assert len(alerts) == 1
        assert alerts[0].severity == "critical"

    def test_decision_logged_tier2_is_not_monitored_for_rate_anomaly(self):
        state = SentinelState()
        # Even many rapid Tier-2 decisions shouldn't trigger a rate alert -
        # Tier 2 is already cryptographically verified, no economic gap.
        for i in range(20):
            event = {
                "type": "DecisionLogged",
                "positionId": i,
                "tier": "ZkProof",
                "sender": "0xHeavyUser",
                "timestamp": i,
            }
            alerts = evaluate_decision_event(state, event)
            assert alerts == []

    def test_decision_logged_heuristic_triggers_rate_anomaly_when_excessive(self):
        state = SentinelState()
        alerts = []
        for i in range(15):
            event = {
                "type": "DecisionLogged",
                "positionId": i,
                "tier": "Heuristic",
                "sender": "0xSpamBot",
                "timestamp": i,
            }
            alerts = evaluate_decision_event(state, event)
        assert any(a.rule == "rate_anomaly" for a in alerts)

    def test_missing_sender_is_skipped_gracefully(self):
        state = SentinelState()
        event = {"type": "DecisionLogged", "positionId": 1, "tier": "Heuristic", "sender": None, "timestamp": 1}
        alerts = evaluate_decision_event(state, event)
        assert alerts == []

    def test_unknown_event_type_produces_no_alerts(self):
        state = SentinelState()
        event = {"type": "SomethingElse"}
        alerts = evaluate_decision_event(state, event)
        assert alerts == []
