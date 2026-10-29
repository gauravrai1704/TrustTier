"""
Concurrency experiments, part 3: competing liquidator bots on a live node.

K liquidator bots - each a separate thread with its own account and its own
RPC connection - race to decide the same set of positions on a running
Hardhat node that mines a block every second (so racing transactions land in
the same blocks, as on a real chain). Bots skip gas estimation, as racing
bots do, so losing transactions are mined and revert.

Checks and measures, for K = 1, 2, 4, 8, 16:
  exactly-once  every position ends with exactly one decision on-chain
  reverted      losing attempts (PositionAlreadyFinalized), and the gas they burn
  throughput    decisions recorded per block, and wall-clock time

Prerequisites (from the repository root):
    npx hardhat node
    VERIFIER_MODE=mock npx hardhat run scripts/deploy.js --network localhost
Then from off-chain/:
    python -m evaluation.liquidator_race
Writes results/liquidator_race.{json,md}.
"""

import json
import os
import random
import threading
import time

from eth_account import Account
from web3 import Web3

from router.chain_client import ChainClient

RESULTS = os.path.join(os.path.dirname(__file__), "results")
BOTS = [1, 2, 4, 8, 16]
POSITIONS_PER_RUN = 30
BOND = 10**16
GAS_LIMIT = 1_500_000


def setup_positions(chain: ChainClient, start_id: int):
    """Half safe (Tier 0 allowed), half risky (Tier 2 only), on market 0."""
    chain.refresh_mock_feeds()
    plan = []
    for i in range(POSITIONS_PER_RUN):
        pid = start_id + i
        tier = 0 if i % 2 == 0 else 2
        chain.open_demo_position(pid, 0, 0.45 if tier == 0 else 0.93, age_days=300, topup_days=10)
        plan.append((pid, tier))
    view = {pid: chain.current_features(pid) for pid, _ in plan}
    return plan, view


def run(chain: ChainClient, k: int, start_id: int):
    plan, view = setup_positions(chain, start_id)
    w3 = chain.w3
    rpc = chain.w3.provider.endpoint_uri
    engine_addr, engine_abi = chain.liquidation_engine.address, chain.liquidation_engine.abi
    model = chain.tier2_model_hash()
    bots = [Account.create() for _ in range(k)]
    for b in bots:
        w3.provider.make_request("hardhat_setBalance", [b.address, hex(10**21)])

    # Interval mining: concurrent submissions share blocks, as on a real chain.
    w3.provider.make_request("evm_setAutomine", [False])
    w3.provider.make_request("evm_setIntervalMining", [1000])
    sent, lock = [], threading.Lock()

    def bot(acct, seed):
        bw3 = Web3(Web3.HTTPProvider(rpc))
        eng = bw3.eth.contract(address=engine_addr, abi=engine_abi)
        nonce = bw3.eth.get_transaction_count(acct.address)
        order = plan[:]
        random.Random(seed).shuffle(order)
        for pid, tier in order:
            v = view[pid]
            if tier == 0:
                fn, value = eng.functions.decideHeuristic(pid, v["past_round"]), BOND
            else:
                inputs = v["q"] + [1, 3, 1021]
                fn, value = eng.functions.decideZkProof(pid, v["past_round"], model, b"\x01", inputs), 0
            tx = fn.build_transaction({"from": acct.address, "nonce": nonce, "gas": GAS_LIMIT,
                                       "gasPrice": bw3.to_wei(2, "gwei"), "value": value, "chainId": chain.chain_id})
            signed = acct.sign_transaction(tx)
            h = bw3.eth.send_raw_transaction(getattr(signed, "raw_transaction", None) or signed.rawTransaction)
            nonce += 1
            with lock:
                sent.append((h, pid))

    t0 = time.time()
    threads = [threading.Thread(target=bot, args=(b, i)) for i, b in enumerate(bots)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    receipts = [(w3.eth.wait_for_transaction_receipt(h, timeout=120), pid) for h, pid in sent]
    wall = time.time() - t0
    w3.provider.make_request("evm_setIntervalMining", [0])
    w3.provider.make_request("evm_setAutomine", [True])

    wins = {}
    reverted, wasted = 0, 0
    blocks = set()
    for r, pid in receipts:
        blocks.add(r.blockNumber)
        if r.status == 1:
            wins[pid] = wins.get(pid, 0) + 1
        else:
            reverted += 1
            wasted += r.gasUsed
    exactly_once = all(wins.get(pid, 0) == 1 for pid, _ in plan)
    recorded = sum(1 for pid, _ in plan if chain.has_decision(pid))
    return {
        "bots": k, "positions": len(plan), "attempts": len(receipts), "succeeded": sum(wins.values()),
        "reverted": reverted, "wasted_gas": wasted,
        "wasted_gas_per_position": round(wasted / len(plan)),
        "exactly_once": exactly_once and recorded == len(plan),
        "blocks": len(blocks), "decisions_per_block": round(len(plan) / max(1, len(blocks)), 1),
        "wall_seconds": round(wall, 1),
    }


def main():
    chain = ChainClient()
    rows = []
    base = 7_000_000 + int(time.time()) % 100_000 * 100
    for i, k in enumerate(BOTS):
        r = run(chain, k, base + i * 1000)
        rows.append(r)
        print(r)
    with open(os.path.join(RESULTS, "liquidator_race.json"), "w") as f:
        json.dump(rows, f, indent=1)
    L = ["# Competing liquidator bots on a live node", "",
         "Generated by `off-chain/evaluation/liquidator_race.py` (Hardhat node, 1-second blocks, "
         f"{POSITIONS_PER_RUN} positions per run: half Tier 0, half Tier 2).", "",
         "| Bots (threads) | Attempts | Succeeded | Reverted | Wasted gas / position | Exactly once | Blocks | Wall time (s) |",
         "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        L.append(f"| {r['bots']} | {r['attempts']} | {r['succeeded']} | {r['reverted']} | {r['wasted_gas_per_position']:,} | "
                 f"{'yes' if r['exactly_once'] else 'NO'} | {r['blocks']} | {r['wall_seconds']} |")
    with open(os.path.join(RESULTS, "liquidator_race.md"), "w") as f:
        f.write("\n".join(L) + "\n")


if __name__ == "__main__":
    main()
