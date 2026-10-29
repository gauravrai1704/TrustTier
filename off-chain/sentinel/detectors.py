"""
Detection logic for TrustTier's sentinel monitoring layer.

Context (see docs/SECURITY.md for the full write-up): TrustTier's bonded
challenge window (LiquidationEngine.sol) gives the system economic security
- a false Tier 0/1 claim CAN be slashed - but only if someone actually
notices and submits the challenge within the window. Nothing on-chain
*alerts* anyone that a challenge happened, or that a claimant's behavior
looks suspicious. That's the gap this module (and sentinel/watch.py) fills:
a lightweight, prototype-scale analogue of the pattern used by real
production systems like Forta Network (a decentralized network of
detection bots watching on-chain activity) and OpenZeppelin Defender
(automated monitoring + response actions) - NOT a claim of equivalent
coverage, audit rigor, or scale. It is a real, working, tested starting
point, built to demonstrate the pattern, not a production-grade
replacement for either.

This module is pure logic - no web3 calls, no I/O - so it's fully unit
testable without a running chain. sentinel/watch.py wires it to a live
event-polling loop.
"""

from collections import defaultdict
from dataclasses import dataclass, field


@dataclass
class Alert:
    severity: str  # "info" | "warning" | "critical"
    rule: str
    message: str
    position_id: int = None
    address: str = None


@dataclass
class SentinelState:
    """Rolling state the sentinel needs across events to detect patterns
    that no single event reveals on its own (e.g. rate anomalies)."""

    # address -> list of decision timestamps (seconds), used for the
    # rate-anomaly check below. Kept small by evaluate_decision_event's
    # window-based pruning, not meant to grow unbounded.
    decisions_by_address: dict = field(default_factory=lambda: defaultdict(list))


def check_challenge_alert(challenged_event: dict) -> Alert:
    """
    A successful challenge means a Tier 0/1 claim was just proven false and
    its bond slashed - by definition, someone's liquidation decision was
    wrong (or malicious). This is always worth a human's attention.
    """
    return Alert(
        severity="critical",
        rule="challenge_succeeded",
        message=(
            f"Position {challenged_event['positionId']} - a Tier 0/1 claim "
            f"was successfully challenged by {challenged_event['challenger']} "
            f"and its bond ({challenged_event['bond']} wei) was slashed. "
            f"The original claim was FALSE."
        ),
        position_id=challenged_event["positionId"],
        address=challenged_event["challenger"],
    )


def check_rate_anomaly(
    state: SentinelState,
    address: str,
    timestamp: int,
    window_seconds: int = 300,
    max_decisions_in_window: int = 10,
) -> Alert:
    """
    Flags an address submitting an unusually high rate of decisions in a
    short window - e.g. a liquidation bot spamming Tier 0 claims to try to
    overwhelm challengers' ability to review them all before the challenge
    window closes. This is the kind of volumetric pattern Forta-style bots
    watch for; our version is intentionally simple (a fixed sliding-window
    count), not a learned anomaly model.
    """
    history = state.decisions_by_address[address]
    history.append(timestamp)
    # Prune anything outside the window so history doesn't grow unbounded
    # and old activity doesn't count against a currently-quiet address.
    cutoff = timestamp - window_seconds
    state.decisions_by_address[address] = [t for t in history if t >= cutoff]

    count = len(state.decisions_by_address[address])
    if count > max_decisions_in_window:
        return Alert(
            severity="warning",
            rule="rate_anomaly",
            message=(
                f"{address} submitted {count} decisions in the last "
                f"{window_seconds}s (threshold: {max_decisions_in_window}). "
                f"Possible attempt to flood the challenge window."
            ),
            address=address,
        )
    return None


def evaluate_decision_event(state: SentinelState, event: dict) -> list:
    """
    Entry point for a single on-chain event (either DecisionLogged or
    DecisionChallenged, distinguished by event["type"]). Returns a list of
    zero or more Alerts - most events trigger none.
    """
    alerts = []

    if event["type"] == "DecisionChallenged":
        alerts.append(check_challenge_alert(event))
        return alerts  # a challenge event carries no claimant/sender for rate tracking here

    if event["type"] == "DecisionLogged":
        # Tier 2 decisions are already cryptographically verified - no
        # economic-security gap to monitor, so the rate check is scoped to
        # Tier 0/1 only (the tiers the bonded challenge window protects).
        if event.get("tier") in ("Heuristic", "Commitment"):
            sender = event.get("sender")
            timestamp = event.get("timestamp")
            if sender is not None and timestamp is not None:
                alert = check_rate_anomaly(state, sender, timestamp)
                if alert is not None:
                    alerts.append(alert)

    return alerts
