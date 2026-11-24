"""
Build a large REAL Aave V2 dataset: daily snapshots of many borrowers' exact
on-chain account state, read from an Ethereum archive node.

Inputs
  - Aave V2 (Ethereum) transactions sent to the LendingPool, from the public
    HuggingFace dataset `kohdified/aave_transactions_blockchain`
    (Ethereum_V2_Transactions.parquet): who borrowed, deposited and when.
  - Hourly ETH/USD prices (Binance klines, HuggingFace
    `zongowo111/v2-crypto-ohlcv-data`, klines/ETHUSDT/ETH_1h.parquet).
  - An archive JSON-RPC endpoint (RPC_URL), queried with
    LendingPool.getUserAccountData(user) at historical blocks: total
    collateral and debt (in ETH), the account's weighted liquidation
    threshold and LTV, and its health factor. These are exactly the values
    Aave itself uses, interest included.

Sampling
  N_USERS borrowers drawn at random (seed 7) among accounts that called
  borrow() directly; for each, one snapshot per day for WINDOW_DAYS days
  from its first borrow (blocks found by interpolating the dataset's own
  block/timestamp pairs).

MODE=liquidated instead samples every account liquidated through a direct
liquidationCall in the transaction data, from 50 days before its first
liquidation (an outcome-stratified sample with many positive labels).

Output: data/aave_v2_snapshots.parquet (or aave_v2_liquidated_snapshots.parquet).

Run from off-chain/:
    RPC_URL=... python -m evaluation.aave_fetch
"""

from __future__ import annotations

import json
import os
import sys
import time

import numpy as np
import pandas as pd
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
TX_PARQUET = os.environ.get("AAVE_TX_PARQUET", os.path.join(DATA, "Ethereum_V2_Transactions.parquet"))
MODE = os.environ.get("MODE", "random")  # "random" or "liquidated"
OUT = os.path.join(DATA, "aave_v2_snapshots.parquet" if MODE == "random" else "aave_v2_liquidated_snapshots.parquet")
LIQ_BEFORE = 50
RPC_URL = os.environ.get("RPC_URL", "https://eth-mainnet.g.alchemy.com/v2")
LENDING_POOL = "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9"
SEL_ACCOUNT_DATA = "0xbf92857c"  # getUserAccountData(address)
N_USERS = int(os.environ.get("N_USERS", "1500"))
WINDOW_DAYS = int(os.environ.get("WINDOW_DAYS", "60"))
BATCH = 50
SEED = 7


def rpc_batch(calls):
    body = [{"jsonrpc": "2.0", "id": i, "method": "eth_call",
             "params": [{"to": LENDING_POOL, "data": SEL_ACCOUNT_DATA + "0" * 24 + user[2:].lower()}, hex(block)]}
            for i, (user, block) in enumerate(calls)]
    for attempt in range(8):
        try:
            r = requests.post(RPC_URL, json=body, timeout=60)
            if r.status_code == 429:
                time.sleep(2 + attempt * 2)
                continue
            r.raise_for_status()
            out = r.json()
            if isinstance(out, dict):  # batch-level error
                raise RuntimeError(out)
            res = {o["id"]: o for o in out}
            if any("error" in o and o["error"].get("code") == 429 for o in out):
                time.sleep(2 + attempt * 2)
                continue
            return [res[i].get("result") for i in range(len(calls))]
        except (requests.RequestException, RuntimeError) as e:
            print("retry", attempt, str(e)[:160], file=sys.stderr)
            time.sleep(2 + attempt * 3)
    raise RuntimeError("RPC failed repeatedly")


def decode(result):
    if not result or result == "0x" or len(result) < 2 + 64 * 6:
        return None
    w = [int(result[2 + 64 * i: 2 + 64 * (i + 1)], 16) for i in range(6)]
    coll, debt, avail, lt, ltv, hf = w
    return coll / 1e18, debt / 1e18, lt / 1e4, ltv / 1e4, hf / 1e18


def main():
    txs = pd.read_parquet(TX_PARQUET, columns=["BlockNumber", "timeStamp", "From", "FunctionName", "isError"])
    txs = txs[txs.isError == 0].copy()
    txs["block"] = txs.BlockNumber.astype(int)
    txs["fn"] = txs.FunctionName.str.split("(").str[0]
    txs["user"] = txs.From.str.lower()
    blocks = txs[["timeStamp", "block"]].drop_duplicates("block").sort_values("timeStamp")

    def block_at(ts):
        return int(np.interp(ts, blocks.timeStamp.values, blocks.block.values))

    first_borrow = txs[txs.fn == "borrow"].groupby("user").timeStamp.min()
    last_ts = int(blocks.timeStamp.max())
    if MODE == "liquidated":
        # Outcome-stratified sample: every account liquidated through a direct
        # liquidationCall(collateral, debt, user, debtToCover, receiveAToken),
        # followed from LIQ_BEFORE days before its first liquidation.
        liq = txs[txs.fn == "liquidationCall"].copy()
        inp = pd.read_parquet(TX_PARQUET, columns=["TxHash", "InputData"]).set_index("TxHash").InputData
        full = pd.read_parquet(TX_PARQUET, columns=["TxHash", "FunctionName", "isError", "timeStamp"])
        full = full[(full.isError == 0) & full.FunctionName.str.startswith("liquidationCall", na=False)]
        victims = {}
        for h, ts in zip(full.TxHash.values, full.timeStamp.values):
            data = inp[h]
            if isinstance(data, pd.Series):
                data = data.iloc[0]
            user = "0x" + data[10 + 64 * 2 + 24: 10 + 64 * 3]
            victims[user] = min(victims.get(user, ts), ts)
        starts = {u: int(t) - LIQ_BEFORE * 86400 for u, t in victims.items()}
        users = list(starts)
        print(f"{len(users)} liquidated accounts x {WINDOW_DAYS} days", flush=True)
    else:
        eligible = first_borrow[first_borrow < last_ts - WINDOW_DAYS * 86400]
        rng = np.random.default_rng(SEED)
        users = rng.choice(eligible.index.values, size=min(N_USERS, len(eligible)), replace=False)
        starts = {u: int(first_borrow[u]) for u in users}
        print(f"{len(first_borrow)} borrowers, sampling {len(users)} x {WINDOW_DAYS} days", flush=True)

    jobs = []
    for u in users:
        t0 = starts[u]
        for d in range(WINDOW_DAYS):
            ts = t0 + d * 86400
            if ts > last_ts:
                break
            jobs.append((u, d, ts, block_at(ts)))

    done = set()
    rows = []
    partial = OUT + ".partial.jsonl"
    if os.path.exists(partial):
        for line in open(partial):
            r = json.loads(line)
            rows.append(r)
            done.add((r["user"], r["day"]))
    todo = [j for j in jobs if (j[0], j[1]) not in done]
    print(f"{len(todo)} snapshots to fetch ({len(done)} cached)", flush=True)
    t_start = time.time()
    with open(partial, "a") as f:
        for i in range(0, len(todo), BATCH):
            chunk = todo[i:i + BATCH]
            res = rpc_batch([(u, b) for u, _, _, b in chunk])
            for (u, d, ts, b), r in zip(chunk, res):
                v = decode(r)
                row = {"user": u, "day": d, "ts": ts, "block": b}
                if v:
                    row.update(dict(zip(["collateral_eth", "debt_eth", "liq_threshold", "max_ltv", "health_factor"], v)))
                f.write(json.dumps(row) + "\n")
                rows.append(row)
            if (i // BATCH) % 40 == 0:
                rate = (i + len(chunk)) / max(1e-9, time.time() - t_start)
                print(f"  {i + len(chunk)}/{len(todo)}  {rate:.1f}/s", flush=True)
            time.sleep(0.15)
    df = pd.DataFrame(rows)
    df.to_parquet(OUT)
    print("wrote", OUT, df.shape)


if __name__ == "__main__":
    main()
