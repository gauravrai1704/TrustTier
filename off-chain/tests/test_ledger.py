"""The ledger database (ledger/db.py) and the router's RPC allow-list."""

import json

from ledger.db import LedgerDB


def _ev(dep, tx, i, type_, pid="7", actor="0xA", amount=None, tier=None, **data):
    return {"deployment": dep, "block_number": i, "block_time": 1000 + i, "tx_hash": tx, "log_index": i,
            "contract": "LiquidationEngine", "type": type_, "position_id": pid, "actor": actor.lower(),
            "tier": tier, "amount_wei": None if amount is None else str(amount), "data": json.dumps(data)}


def test_events_are_deduplicated_and_kept_per_deployment():
    db = LedgerDB(":memory:")
    rows = [_ev("d1", "0x1", 0, "SafeClaimRecorded"), _ev("d1", "0x1", 1, "DecisionLogged", tier="Heuristic")]
    assert db.insert_events(rows) == 2
    assert db.insert_events(rows) == 0                       # idempotent re-index
    assert db.insert_events([_ev("d2", "0x1", 0, "SafeClaimRecorded")]) == 1  # a new epoch keeps its own history
    assert db.count_events("d1") == 2 and db.count_events("d2") == 1
    assert [e["type"] for e in db.events("d1")] == ["DecisionLogged", "SafeClaimRecorded"]  # newest first


def test_summary_and_leaderboard_total_money_exactly():
    db = LedgerDB(":memory:")
    big = 10**18 + 1                                           # exact wei, no float rounding
    db.insert_events([
        _ev("d", "0x1", 0, "DecisionChallenged", actor="0xW", amount=big),
        _ev("d", "0x2", 1, "DecisionChallenged", actor="0xW", amount=big),
        _ev("d", "0x3", 2, "RewardPaid", amount=5),
        _ev("d", "0x4", 3, "PositionLiquidated", actor="0xK", debtRepaidUsd=93000000000),
        _ev("d", "0x5", 4, "DecisionLogged", tier="ZkProof"),
    ])
    s = db.summary("d")
    assert s["slashed_wei"] == str(2 * big) and s["rewards_wei"] == "5"
    assert s["debt_repaid_usd"] == 930.0 and s["decisions_by_tier"] == {"ZkProof": 1}
    lb = db.leaderboard("d")
    assert lb["watchers"][0] == {"address": "0xw", "count": 2, "amount_wei": str(2 * big)}
    assert lb["liquidators"][0]["address"] == "0xk"


def test_filters():
    db = LedgerDB(":memory:")
    db.insert_events([_ev("d", "0x1", 0, "SafeClaimRecorded", pid="1", actor="0xA"),
                      _ev("d", "0x2", 1, "SafeClaimRecorded", pid="2", actor="0xB"),
                      _ev("d", "0x3", 2, "DecisionChallenged", pid="2", actor="0xB")])
    assert db.count_events("d", position_id="2") == 2
    assert db.count_events("d", actor="0xb", type_="SafeClaimRecorded") == 1


def test_sessions_users_and_actions():
    db = LedgerDB(":memory:")
    db.record_sign_in("0xABC", "tok")
    db.record_sign_in("0xabc", "tok2")
    assert db.user("0xabc")["sign_ins"] == 2
    assert db.session_address("tok") == "0xabc" and db.session_address("nope") is None
    db.end_session("tok")
    assert db.session_address("tok") is None
    db.log_action("challenge", address="0xABC", position_id=7, gas_used=773609, tx_hash="0xt")
    db.log_action("route", ok=False, detail="TierNotAllowed")
    assert [a["action"] for a in db.actions("0xabc")] == ["challenge"]
    assert len(db.actions()) == 2 and db.summary("d")["actions"] == 2


def test_rpc_proxy_refuses_unlocked_account_and_node_control_methods():
    import main
    ok = {"jsonrpc": "2.0", "id": 1, "method": "eth_sendRawTransaction", "params": ["0x"]}
    assert main._rpc_allowed(ok)
    assert main._rpc_allowed([ok, {"method": "eth_call"}])
    for bad in ("eth_sendTransaction", "eth_sign", "personal_sign", "evm_increaseTime", "hardhat_setBalance"):
        assert not main._rpc_allowed({"method": bad})
    assert not main._rpc_allowed([ok, {"method": "eth_sendTransaction"}])
    assert not main._rpc_allowed([])
