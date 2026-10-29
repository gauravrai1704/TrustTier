"""
TrustTier's off-chain database: a SQLite index of everything that happened.

The chain stays the source of truth. This database holds
  - events:   every event the TrustTier contracts emitted, decoded, with the
              sender of its transaction and the block time (rebuildable at
              any time by re-indexing the chain - see ledger/indexer.py);
  - actions:  every action requested through the router's API, with who
              asked (the signed-in address), the outcome and the gas;
  - users / sessions: Sign-In-With-Ethereum accounts and their sessions.

Events are keyed by deployment ("<chainId>:<engine address>:<epoch>"): a
local Hardhat chain that restarts gets a new epoch, so the history of earlier
runs is kept and never mixed with the current one.

Path: $TRUSTTIER_DB, default off-chain/data/trusttier.db.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time

DEFAULT_PATH = os.environ.get(
    "TRUSTTIER_DB", os.path.join(os.path.dirname(__file__), "..", "data", "trusttier.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment    TEXT NOT NULL,
    block_number  INTEGER NOT NULL,
    block_time    INTEGER NOT NULL,
    tx_hash       TEXT NOT NULL,
    log_index     INTEGER NOT NULL,
    contract      TEXT NOT NULL,
    type          TEXT NOT NULL,
    position_id   TEXT,
    actor         TEXT,
    tier          TEXT,
    amount_wei    TEXT,
    data          TEXT NOT NULL,
    UNIQUE (deployment, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS events_by_type     ON events (deployment, type);
CREATE INDEX IF NOT EXISTS events_by_position ON events (deployment, position_id);
CREATE INDEX IF NOT EXISTS events_by_actor    ON events (deployment, actor);

CREATE TABLE IF NOT EXISTS sync_state (
    base        TEXT PRIMARY KEY,   -- "<chainId>:<engine address>"
    epoch       INTEGER NOT NULL,
    last_block  INTEGER NOT NULL,
    last_hash   TEXT
);

CREATE TABLE IF NOT EXISTS actions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    deployment    TEXT,
    address       TEXT,             -- signed-in user, if any
    action        TEXT NOT NULL,
    position_id   TEXT,
    ok            INTEGER NOT NULL,
    detail        TEXT,
    tx_hash       TEXT,
    gas_used      INTEGER
);
CREATE INDEX IF NOT EXISTS actions_by_address ON actions (address);

CREATE TABLE IF NOT EXISTS users (
    address     TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    sign_ins    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    address     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
"""

SESSION_TTL_SECONDS = 7 * 24 * 3600

# Events that move money, and the argument holding the amount.
AMOUNT_FIELDS = ("bond", "amount", "bondForfeited", "bondCredited")


class LedgerDB:
    def __init__(self, path: str = DEFAULT_PATH):
        self.path = path
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    # ---- low level -------------------------------------------------------

    def _exec(self, sql: str, params=()):
        with self._lock:
            cur = self._conn.execute(sql, params)
            self._conn.commit()
            return cur

    def _all(self, sql: str, params=()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, params).fetchall()]

    def _one(self, sql: str, params=()):
        rows = self._all(sql, params)
        return rows[0] if rows else None

    # ---- sync state --------------------------------------------------------

    def sync_state(self, base: str) -> dict:
        row = self._one("SELECT * FROM sync_state WHERE base = ?", (base,))
        if row is None:
            self._exec("INSERT INTO sync_state (base, epoch, last_block, last_hash) VALUES (?, 1, -1, NULL)", (base,))
            row = {"base": base, "epoch": 1, "last_block": -1, "last_hash": None}
        return row

    def set_sync(self, base: str, epoch: int, last_block: int, last_hash: str | None):
        self._exec("UPDATE sync_state SET epoch = ?, last_block = ?, last_hash = ? WHERE base = ?",
                   (epoch, last_block, last_hash, base))

    # ---- events --------------------------------------------------------------

    def insert_events(self, rows: list[dict]) -> int:
        """Insert decoded events; duplicates (same deployment, tx, log) are ignored."""
        if not rows:
            return 0
        with self._lock:
            before = self._conn.total_changes
            self._conn.executemany(
                """INSERT OR IGNORE INTO events (deployment, block_number, block_time, tx_hash, log_index,
                   contract, type, position_id, actor, tier, amount_wei, data)
                   VALUES (:deployment, :block_number, :block_time, :tx_hash, :log_index, :contract, :type,
                           :position_id, :actor, :tier, :amount_wei, :data)""",
                rows)
            self._conn.commit()
            return self._conn.total_changes - before

    def events(self, deployment: str | None, type_: str | None = None, position_id: str | None = None,
               actor: str | None = None, limit: int = 100, offset: int = 0) -> list[dict]:
        where, params = [], []
        if deployment:
            where.append("deployment = ?"); params.append(deployment)
        if type_:
            where.append("type = ?"); params.append(type_)
        if position_id:
            where.append("position_id = ?"); params.append(str(position_id))
        if actor:
            where.append("actor = ?"); params.append(actor.lower())
        sql = "SELECT * FROM events" + (" WHERE " + " AND ".join(where) if where else "")
        sql += " ORDER BY block_number DESC, log_index DESC LIMIT ? OFFSET ?"
        rows = self._all(sql, (*params, int(limit), int(offset)))
        for r in rows:
            r["data"] = json.loads(r["data"])
        return rows

    def count_events(self, deployment: str | None, **filters) -> int:
        rows = self.events(deployment, limit=10**9, **filters)
        return len(rows)

    def summary(self, deployment: str) -> dict:
        by_type = {r["type"]: r["n"] for r in self._all(
            "SELECT type, COUNT(*) n FROM events WHERE deployment = ? GROUP BY type", (deployment,))}
        claims_by_tier = {r["tier"]: r["n"] for r in self._all(
            "SELECT tier, COUNT(*) n FROM events WHERE deployment = ? AND type = 'DecisionLogged' GROUP BY tier",
            (deployment,))}

        def total(type_: str) -> int:
            return sum(int(r["amount_wei"] or 0) for r in self._all(
                "SELECT amount_wei FROM events WHERE deployment = ? AND type = ?", (deployment, type_)))

        debt = sum(float(json.loads(r["data"]).get("debtRepaidUsd", 0) or 0) / 1e8 for r in self._all(
            "SELECT data FROM events WHERE deployment = ? AND type = 'PositionLiquidated'", (deployment,)))
        meta = self._one("""SELECT COUNT(*) n, COUNT(DISTINCT actor) actors, COUNT(DISTINCT position_id) positions,
                            MIN(block_time) first, MAX(block_time) last, MAX(block_number) block
                            FROM events WHERE deployment = ?""", (deployment,))
        return {
            "deployment": deployment,
            "events": meta["n"], "actors": meta["actors"], "positions": meta["positions"],
            "first_block_time": meta["first"], "last_block_time": meta["last"], "indexed_block": meta["block"],
            "by_type": by_type, "decisions_by_tier": claims_by_tier,
            "slashed_wei": str(total("DecisionChallenged")),
            "rewards_wei": str(total("RewardPaid")),
            "forfeited_wei": str(total("BondForfeited") + total("CommitmentContradicted")),
            "debt_repaid_usd": round(debt, 2),
            "actions": self._one("SELECT COUNT(*) n FROM actions")["n"],
            "users": self._one("SELECT COUNT(*) n FROM users")["n"],
        }

    def leaderboard(self, deployment: str, limit: int = 10) -> dict:
        def rank(sql: str):
            rows = self._all(sql, (deployment, limit))
            for r in rows:
                r["amount_wei"] = str(r["amount_wei"] or 0)
            return rows
        return {
            "watchers": rank("""SELECT actor AS address, COUNT(*) AS count,
                                SUM(CAST(amount_wei AS INTEGER)) AS amount_wei FROM events
                                WHERE deployment = ? AND type = 'DecisionChallenged'
                                GROUP BY actor ORDER BY amount_wei DESC, count DESC LIMIT ?"""),
            "claimants": rank("""SELECT actor AS address, COUNT(*) AS count, 0 AS amount_wei FROM events
                                 WHERE deployment = ? AND type = 'SafeClaimRecorded'
                                 GROUP BY actor ORDER BY count DESC LIMIT ?"""),
            "liquidators": rank("""SELECT actor AS address, COUNT(*) AS count, 0 AS amount_wei FROM events
                                   WHERE deployment = ? AND type = 'PositionLiquidated'
                                   GROUP BY actor ORDER BY count DESC LIMIT ?"""),
        }

    def deployments(self) -> list[dict]:
        return self._all("""SELECT deployment, COUNT(*) AS events, MIN(block_time) AS first, MAX(block_time) AS last
                            FROM events GROUP BY deployment ORDER BY last DESC""")

    # ---- actions -------------------------------------------------------------

    def log_action(self, action: str, *, deployment: str | None = None, address: str | None = None,
                   position_id=None, ok: bool = True, detail: str | None = None,
                   tx_hash: str | None = None, gas_used: int | None = None):
        self._exec("""INSERT INTO actions (ts, deployment, address, action, position_id, ok, detail, tx_hash, gas_used)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                   (int(time.time()), deployment, address.lower() if address else None, action,
                    None if position_id is None else str(position_id), 1 if ok else 0,
                    (detail or "")[:500] or None, tx_hash, gas_used))

    def actions(self, address: str | None = None, limit: int = 100) -> list[dict]:
        if address:
            return self._all("SELECT * FROM actions WHERE address = ? ORDER BY id DESC LIMIT ?", (address.lower(), limit))
        return self._all("SELECT * FROM actions ORDER BY id DESC LIMIT ?", (limit,))

    # ---- users and sessions --------------------------------------------------

    def record_sign_in(self, address: str, token: str) -> dict:
        now = int(time.time())
        address = address.lower()
        self._exec("""INSERT INTO users (address, created_at, last_seen, sign_ins) VALUES (?, ?, ?, 1)
                      ON CONFLICT(address) DO UPDATE SET last_seen = excluded.last_seen, sign_ins = sign_ins + 1""",
                   (address, now, now))
        self._exec("INSERT INTO sessions (token, address, created_at, expires_at) VALUES (?, ?, ?, ?)",
                   (token, address, now, now + SESSION_TTL_SECONDS))
        return self.user(address)

    def session_address(self, token: str | None) -> str | None:
        if not token:
            return None
        row = self._one("SELECT address, expires_at FROM sessions WHERE token = ?", (token,))
        if row is None or row["expires_at"] < time.time():
            return None
        return row["address"]

    def end_session(self, token: str):
        self._exec("DELETE FROM sessions WHERE token = ?", (token,))

    def user(self, address: str) -> dict | None:
        return self._one("SELECT * FROM users WHERE address = ?", (address.lower(),))
