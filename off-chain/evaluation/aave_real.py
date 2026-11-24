"""
Turn the fetched Aave V2 snapshots (evaluation/aave_fetch.py) into
TrustTier's five features and an outcome label.

Each snapshot is one borrower on one day, with Aave's own numbers read from
an archive node: collateral and debt (ETH), the account's weighted
liquidation threshold, and its health factor.

Features (the same five, with the same bounds, as the contract and circuit):
  ltv                         debt / collateral
  collateral_volatility_30d   annualised realised volatility of ETH/USD over
                              the 30 days before the snapshot (hourly closes);
                              ETH is the dominant Aave V2 collateral, and the
                              account's per-asset mix is not part of
                              getUserAccountData, so ETH stands in for it
  price_momentum_24h          ETH/USD return over the previous 24 hours
  time_since_last_topup_days  days since the account's collateral last grew by
                              more than 2% between two daily snapshots, or since
                              its last direct deposit() in the transaction data,
                              whichever is later
  account_age_days            days since the account's first Aave V2 transaction

Label: 1 if the account becomes liquidatable (health factor < 1) on any of the
next HORIZON_DAYS daily snapshots - the outcome an early, soft liquidation
is meant to pre-empt. Snapshots that are already liquidatable, or that lack
HORIZON_DAYS of future, are kept for the cost replay but not for training.

Run from off-chain/:
    python -m evaluation.aave_real
Writes data/aave_v2_training.npz (normalised X, y, user groups) and
data/aave_v2_positions.parquet (every snapshot with its features).
"""

from __future__ import annotations

import os

import numpy as np
import pandas as pd

from risk_model.features import normalize_vector

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
SNAPSHOTS = os.path.join(DATA, "aave_v2_snapshots.parquet")
LIQ_SNAPSHOTS = os.path.join(DATA, "aave_v2_liquidated_snapshots.parquet")
TXS = os.path.join(DATA, "Ethereum_V2_Transactions.parquet")
ETH = os.path.join(DATA, "ETH_1h.parquet")
OUT_NPZ = os.path.join(DATA, "aave_v2_training.npz")
OUT_POS = os.path.join(DATA, "aave_v2_positions.parquet")
HORIZON_DAYS = 7
MIN_DEBT_ETH = 0.05   # ignore dust positions (about $100 or less)
TOPUP_GROWTH = 0.02


def _load(path):
    if os.path.exists(path):
        return pd.read_parquet(path)
    if os.path.exists(path + ".partial.jsonl"):
        return pd.read_json(path + ".partial.jsonl", lines=True)
    return None


def load_snapshots():
    """Both samples: random borrowers ("random") and liquidated accounts ("liquidated").
    An account in both keeps its random-sample rows (the two windows can differ)."""
    parts = []
    for path, name in ((SNAPSHOTS, "random"), (LIQ_SNAPSHOTS, "liquidated")):
        d = _load(path)
        if d is not None:
            d["sample"] = name
            d["user"] = d["user"].str.lower()
            parts.append(d)
    df = pd.concat(parts, ignore_index=True)
    if len(parts) == 2:
        rnd = set(df[df["sample"] == "random"].user)
        df = df[(df["sample"] == "random") | ~df.user.isin(rnd)]
    return df


def eth_market():
    px = pd.read_parquet(ETH, columns=["open_time", "close"]).copy()
    px["ts"] = pd.to_datetime(px.open_time).astype("int64") // 10**9
    px = px.sort_values("ts").drop_duplicates("ts")
    r = np.log(px.close).diff()
    px["vol30"] = r.rolling(30 * 24, min_periods=24 * 20).std() * np.sqrt(24 * 365)
    px["mom24"] = px.close / px.close.shift(24) - 1
    return px[["ts", "close", "vol30", "mom24"]].dropna()


def main():
    snap = load_snapshots()
    snap = snap.dropna(subset=["health_factor"])
    snap = snap.sort_values(["user", "day"]).reset_index(drop=True)

    mkt = eth_market()
    snap = pd.merge_asof(snap.sort_values("ts"), mkt, on="ts", direction="backward").sort_values(["user", "day"])

    txs = pd.read_parquet(TXS, columns=["timeStamp", "From", "FunctionName", "isError"])
    txs = txs[txs.isError == 0]
    txs["user"] = txs.From.str.lower()
    first_seen = txs.groupby("user").timeStamp.min()
    deposits = txs[txs.FunctionName.str.startswith("deposit", na=False)][["user", "timeStamp"]].sort_values("timeStamp")

    rows = []
    for user, g in snap.groupby("user", sort=False):
        g = g.sort_values("day")
        coll, debt, hf, ts = g.collateral_eth.values, g.debt_eth.values, g.health_factor.values, g.ts.values
        dep_ts = deposits[deposits.user == user].timeStamp.values
        last_topup = first_seen.get(user, ts[0])
        for i in range(len(g)):
            if i > 0 and coll[i - 1] > 0 and coll[i] > coll[i - 1] * (1 + TOPUP_GROWTH):
                last_topup = ts[i]
            direct = dep_ts[dep_ts <= ts[i]]
            if len(direct):
                last_topup = max(last_topup, int(direct[-1]))
            future = hf[i + 1:i + 1 + HORIZON_DAYS]
            rows.append({
                "user": user, "sample": g["sample"].values[i], "day": int(g.day.values[i]), "ts": int(ts[i]), "block": int(g.block.values[i]),
                "collateral_eth": coll[i], "debt_eth": debt[i], "liq_threshold": g.liq_threshold.values[i],
                "health_factor": hf[i],
                "ltv": debt[i] / coll[i] if coll[i] > 0 else np.nan,
                "collateral_volatility_30d": g.vol30.values[i],
                "price_momentum_24h": g.mom24.values[i],
                "time_since_last_topup_days": max(0.0, (ts[i] - last_topup) / 86400),
                "account_age_days": max(0.0, (ts[i] - first_seen.get(user, ts[i])) / 86400),
                "eth_usd": g.close.values[i],
                "full_horizon": len(future) == HORIZON_DAYS and not np.isnan(future).any(),
                "label": int((future < 1.0).any()) if len(future) else 0,
            })
    df = pd.DataFrame(rows)
    df = df[(df.debt_eth >= MIN_DEBT_ETH) & (df.collateral_eth > 0)].dropna(subset=["ltv", "collateral_volatility_30d"])
    df["delta"] = df.liq_threshold - df.ltv
    df.to_parquet(OUT_POS)

    train = df[df.full_horizon & (df.health_factor >= 1.0)]
    feats = ["ltv", "collateral_volatility_30d", "price_momentum_24h", "time_since_last_topup_days", "account_age_days"]
    X = np.array([normalize_vector(r) for r in train[feats].values.tolist()])
    y = train.label.values.astype(int)
    groups = train.user.values
    np.savez(OUT_NPZ, X=X, y=y, groups=groups, sample=train["sample"].values)
    print(f"snapshots {len(snap):,}; positions with debt {len(df):,} from {df.user.nunique():,} accounts")
    for s, g in df.groupby("sample"):
        tr = g[g.full_horizon & (g.health_factor >= 1.0)]
        print(f"  {s}: {len(g):,} positions, {g.user.nunique():,} accounts, {len(tr):,} training rows, "
              f"positive rate {tr.label.mean():.3%}, accounts ever liquidatable {g[g.health_factor < 1].user.nunique():,}")
    print(f"training rows {len(train):,} ({train.user.nunique():,} accounts); positive rate {y.mean():.3%}; "
          f"accounts ever liquidatable {df[df.health_factor < 1].user.nunique():,}")


if __name__ == "__main__":
    main()
