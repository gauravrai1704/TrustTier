"""
Live polling sentinel: watches the deployed LiquidationEngine for
DecisionLogged and DecisionChallenged events and raises alerts in real
time, using the pure detection logic in sentinel/detectors.py.

This is a minimal, prototype-scale analogue of a Forta-style detection bot
or an OpenZeppelin Defender monitor - polling instead of a streaming
subscription, printing instead of paging someone, but the same core loop:
watch events as they land, run detection rules over them, surface what
matters. See docs/SECURITY.md for how this fits into the project's overall
security posture.

Run from the off-chain/ directory (with a Hardhat node running and
contracts deployed):
    python3 -m sentinel.watch
"""

import time

from router.chain_client import ChainClient
from sentinel.detectors import SentinelState, evaluate_decision_event

POLL_INTERVAL_SECONDS = 5

# Mirrors LiquidationEngine.Tier / TierAuditLog.Tier ordering (see
# LiquidationEngine.sol) - event args carry the enum as an integer.
TIER_NAMES = {0: "Heuristic", 1: "Commitment", 2: "ZkProof"}


def _get_sender(chain: ChainClient, tx_hash) -> str:
    """DecisionLogged doesn't carry the sender directly (it's emitted by
    TierAuditLog, called internally by LiquidationEngine) - recover it from
    the transaction itself."""
    tx = chain.w3.eth.get_transaction(tx_hash)
    return tx["from"]


def _poll_once(chain: ChainClient, state: SentinelState, from_block: int, to_block: int):
    alerts = []

    decision_events = chain.audit_log.events.DecisionLogged.get_logs(
        fromBlock=from_block, toBlock=to_block
    )
    for e in decision_events:
        args = e["args"]
        sender = _get_sender(chain, e["transactionHash"])
        event = {
            "type": "DecisionLogged",
            "positionId": args["positionId"],
            "tier": TIER_NAMES.get(args["tier"], str(args["tier"])),
            "sender": sender,
            "timestamp": args["timestamp"],
        }
        alerts.extend(evaluate_decision_event(state, event))

    challenge_events = chain.liquidation_engine.events.DecisionChallenged.get_logs(
        fromBlock=from_block, toBlock=to_block
    )
    for e in challenge_events:
        args = e["args"]
        event = {
            "type": "DecisionChallenged",
            "positionId": args["positionId"],
            "challenger": args["challenger"],
            "bond": args["bond"],
        }
        alerts.extend(evaluate_decision_event(state, event))

    return alerts


def _emit(alert):
    print(f"[{alert.severity.upper()}] ({alert.rule}) {alert.message}")


def run(poll_interval: int = POLL_INTERVAL_SECONDS, max_iterations: int = None):
    chain = ChainClient()
    state = SentinelState()
    last_block = chain.w3.eth.block_number

    print(
        f"Sentinel watching LiquidationEngine at "
        f"{chain.liquidation_engine.address} (starting from block {last_block})..."
    )

    iterations = 0
    while max_iterations is None or iterations < max_iterations:
        current_block = chain.w3.eth.block_number
        if current_block > last_block:
            alerts = _poll_once(chain, state, last_block + 1, current_block)
            for alert in alerts:
                _emit(alert)
            last_block = current_block

        iterations += 1
        if max_iterations is None or iterations < max_iterations:
            time.sleep(poll_interval)

    print("Sentinel stopped.")


if __name__ == "__main__":
    run()
