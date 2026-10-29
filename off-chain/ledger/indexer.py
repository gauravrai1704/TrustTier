"""
Indexes TrustTier's on-chain events into the ledger database.

Reads logs of every TrustTier contract in the deployment manifest
(LiquidationEngine, TierAuditLog, ModelRegistry, the lending pool and the
liquidator) from the last indexed block to the head, decodes them with the
contracts' ABIs, and stores each with its transaction's sender and block
time. Re-running is idempotent. If the chain was reset under us (a local
node restarted: the last indexed block is gone or has a different hash), a
new epoch starts, so earlier runs stay in the database, separately.

    python -m ledger.indexer            # one sync, prints a summary
    python -m ledger.indexer --watch    # keep syncing
"""

from __future__ import annotations

import json
import sys
import time

from web3 import Web3
from web3._utils.events import get_event_data

from ledger.db import AMOUNT_FIELDS, LedgerDB

INDEXED_CONTRACTS = ("LiquidationEngine", "TierAuditLog", "ModelRegistry", "MockLendingPool",
                     "TrustTierLiquidator", "PositionSource")
TIER_NAMES = {0: "Heuristic", 1: "Commitment", 2: "ZkProof"}
CHUNK = 2_000


def _jsonable(v):
    if isinstance(v, (bytes, bytearray)):
        return "0x" + bytes(v).hex()
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, int) and abs(v) >= 2 ** 53:
        return str(v)
    return v


class Indexer:
    def __init__(self, chain, db: LedgerDB):
        self.chain = chain
        self.db = db
        engine = chain.liquidation_engine.address.lower()
        self.base = f"{chain.chain_id}:{engine}"
        self._topics = {}
        addresses = set()
        for name in INDEXED_CONTRACTS:
            entry = chain.manifest["contracts"].get(name)
            if not entry:
                continue
            addr = Web3.to_checksum_address(entry["address"])
            if addr in addresses:
                continue
            addresses.add(addr)
            label = "MockLendingPool" if name == "PositionSource" and "MockLendingPool" in chain.manifest["contracts"] else name
            for item in entry["abi"]:
                if item.get("type") != "event":
                    continue
                sig = f"{item['name']}({','.join(i['type'] if i['type'] != 'tuple' else '(' + ','.join(c['type'] for c in i['components']) + ')' for i in item['inputs'])})"
                topic = Web3.keccak(text=sig).hex()
                topic = topic if topic.startswith("0x") else "0x" + topic
                self._topics[(addr.lower(), topic)] = (label, item)
        self.addresses = sorted(addresses)
        self._senders: dict[str, str] = {}
        self._times: dict[int, int] = {}

    @property
    def deployment(self) -> str:
        return f"{self.base}:{self.db.sync_state(self.base)['epoch']}"

    def _sender(self, tx_hash: str) -> str:
        if tx_hash not in self._senders:
            self._senders[tx_hash] = self.chain.w3.eth.get_transaction(tx_hash)["from"].lower()
        return self._senders[tx_hash]

    def _time(self, block: int) -> int:
        if block not in self._times:
            self._times[block] = self.chain.w3.eth.get_block(block)["timestamp"]
        return self._times[block]

    def _decode(self, log, deployment: str) -> dict | None:
        topic = log["topics"][0].hex()
        topic = topic if topic.startswith("0x") else "0x" + topic
        hit = self._topics.get((log["address"].lower(), topic))
        if hit is None:
            return None
        label, abi = hit
        ev = get_event_data(self.chain.w3.codec, abi, log)
        args = {k: _jsonable(v) for k, v in dict(ev["args"]).items()}
        tx = log["transactionHash"].hex()
        tx = tx if tx.startswith("0x") else "0x" + tx
        amount = next((args[f] for f in AMOUNT_FIELDS if f in args), None)
        tier = args.get("tier")
        return {
            "deployment": deployment,
            "block_number": log["blockNumber"],
            "block_time": self._time(log["blockNumber"]),
            "tx_hash": tx,
            "log_index": log["logIndex"],
            "contract": label,
            "type": ev["event"],
            "position_id": str(args["positionId"]) if "positionId" in args else None,
            "actor": self._sender(tx),
            "tier": TIER_NAMES.get(tier, None) if isinstance(tier, int) else None,
            "amount_wei": str(amount) if amount is not None else None,
            "data": json.dumps(args),
        }

    def sync(self) -> int:
        """Index new blocks; returns the number of new events stored."""
        w3 = self.chain.w3
        st = self.db.sync_state(self.base)
        epoch, last = st["epoch"], st["last_block"]
        head = w3.eth.block_number
        if last >= 0:
            try:
                same = head >= last and w3.eth.get_block(last)["hash"].hex().removeprefix("0x") == (st["last_hash"] or "").removeprefix("0x")
            except Exception:
                same = False
            if not same:  # the chain was reset: start a new epoch
                epoch, last = epoch + 1, -1
                self._senders.clear()
                self._times.clear()
        deployment = f"{self.base}:{epoch}"
        added = 0
        start = last + 1
        while start <= head:
            end = min(head, start + CHUNK - 1)
            logs = w3.eth.get_logs({"fromBlock": start, "toBlock": end, "address": self.addresses})
            rows = [r for r in (self._decode(l, deployment) for l in logs) if r]
            added += self.db.insert_events(rows)
            start = end + 1
        if head >= 0:
            h = w3.eth.get_block(head)["hash"].hex()
            self.db.set_sync(self.base, epoch, head, h)
        return added


def main():
    from router.chain_client import ChainClient
    idx = Indexer(ChainClient(), LedgerDB())
    while True:
        n = idx.sync()
        s = idx.db.summary(idx.deployment)
        print(f"+{n} events · {s['events']} indexed for {idx.deployment} · by type {s['by_type']}")
        if "--watch" not in sys.argv:
            break
        time.sleep(3)


if __name__ == "__main__":
    main()
