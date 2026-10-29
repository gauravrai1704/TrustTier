"""
Concurrency experiments, part 2: parallel execution with 1-64 threads on the
REAL read/write sets that scripts/concurrency_trace.js recorded from opcode
traces of whole blocks of TrustTier decisions.

Three ways to execute a block are simulated; transaction durations are their
measured gas (Tier 2 rescaled to the real-verifier cost):

  rounds      strict optimistic concurrency control: two transactions
              conflict if they touch a common key and at least one writes it
              (the model of concurrency_sim.py, now on traced sets); greedy
              conflict-free rounds.
  schedule    a pre-computed dependency schedule (the miner publishes a
              happens-before graph that validators replay, as in Dickerson et
              al. and Anjana et al.): T threads, list scheduling over the
              block-order dependency DAG.
  optimistic  Block-STM-style: T threads execute transactions speculatively
              in block order, validate them against lower-index writes, and
              re-execute (abort) those that read a value a lower transaction
              wrote after they started. Only read-after-write dependencies
              count, as with multi-version memory.

Account balances moved by bonds (msg.value into LiquidationEngine) are
modelled two ways: as a read-modify-write of the engine's balance (a naive
EVM) or as a commutative delta (how parallel EVMs treat balance increments
and Block-STM treats aggregators). Gas fees paid to the block producer are
always deferred, as every parallel EVM does.

Run from off-chain/ after the trace script:
    python -m evaluation.parallel_exec
"""

import glob
import heapq
import json
import os

RESULTS = os.path.join(os.path.dirname(__file__), "results")
TRACES = os.path.join(RESULTS, "traces")
THREADS = [1, 2, 4, 8, 16, 32, 64]

with open(os.path.join(RESULTS, "gas_measurements.json")) as f:
    _GAS = json.load(f)
REAL_TIER2_GAS = _GAS["decideZkProof"]


def load(name):
    with open(os.path.join(TRACES, f"{name}.json")) as f:
        return json.load(f)


def keysets(txs, balance_mode):
    """Per transaction (reads, writes) over storage slots and balances."""
    out = []
    for t in txs:
        reads, writes = set(t["reads"]), set(t["writes"])
        for b in t["balances"]:
            key = f"BAL:{b}"
            if b.startswith("account:"):
                reads.add(key)          # sender nonce + balance: always read-modify-write
                writes.add(key)
            elif balance_mode == "rmw":
                reads.add(key)
                writes.add(key)
            # "delta": commutative increment, no conflict
        out.append((reads, writes))
    return out


def durations(txs):
    d = []
    for t in txs:
        g = t["gasUsed"]
        if t["kind"] == "tier2" and t["status"] == 1:
            g = REAL_TIER2_GAS  # the mock verifier is cheaper than the real one
        d.append(g)
    return d


def raw_deps(sets):
    """j < i such that i reads a key j writes (read-after-write)."""
    deps = []
    last_writer = {}
    writers_of = {}
    for i, (r, w) in enumerate(sets):
        dep = set()
        for k in r:
            for j in writers_of.get(k, ()):
                dep.add(j)
        deps.append(dep)
        for k in w:
            writers_of.setdefault(k, []).append(i)
            last_writer[k] = i
    return deps


def strict_deps(sets):
    """j < i that conflict in any direction (RAW, WAR, WAW)."""
    deps = []
    for i, (ri, wi) in enumerate(sets):
        dep = set()
        for j in range(i):
            rj, wj = sets[j]
            if (wj & (ri | wi)) or (rj & wi):
                dep.add(j)
        deps.append(dep)
    return deps


def greedy_rounds(sets):
    rounds = []  # list of (reads, writes) unions
    for r, w in sets:
        for rr in rounds:
            if not (w & (rr[0] | rr[1])) and not (r & rr[1]):
                rr[0] |= r
                rr[1] |= w
                break
        else:
            rounds.append([set(r), set(w)])
    return len(rounds)


def list_schedule(deps, dur, threads):
    """Makespan of the dependency DAG on `threads` workers, priority = block order."""
    n = len(dur)
    finish = [0.0] * n
    free = [0.0] * threads
    heapq.heapify(free)
    for i in range(n):  # block order is a topological order
        ready = max((finish[j] for j in deps[i]), default=0.0)
        t = heapq.heappop(free)
        start = max(t, ready)
        finish[i] = start + dur[i]
        heapq.heappush(free, finish[i])
    return max(finish) if n else 0.0


def optimistic(deps, dur, threads):
    """Block-STM-like speculative execution. A transaction runs as soon as a
    thread is free (lowest index first). When it finishes it is valid only if
    every RAW predecessor had already committed its final write when it
    started; otherwise it aborts and re-executes once those predecessors
    have committed. Returns (makespan, aborts)."""
    n = len(dur)
    final_finish = [None] * n
    pending = list(range(n))  # waiting for a first execution, in order
    heapq.heapify(pending)
    retry = []  # (earliest start, index)
    running = []  # (finish, index, start)
    free_threads = threads
    now = 0.0
    aborts = 0

    def committed_by(j, t):
        return final_finish[j] is not None and final_finish[j] <= t

    while pending or retry or running:
        # Start work on free threads: retries whose deps are committed first, else new txs.
        started = True
        while free_threads and started:
            started = False
            ready_retry = [x for x in retry if all(committed_by(j, now) for j in deps[x[1]])]
            if ready_retry:
                item = min(ready_retry, key=lambda x: x[1])
                retry.remove(item)
                heapq.heappush(running, (now + dur[item[1]], item[1], now))
                free_threads -= 1
                started = True
            elif pending:
                i = heapq.heappop(pending)
                heapq.heappush(running, (now + dur[i], i, now))
                free_threads -= 1
                started = True
        if not running:
            # Only retries blocked on deps that are still running elsewhere - cannot happen
            # without running work; advance defensively.
            now = min((final_finish[j] or now) for x in retry for j in deps[x[1]]) if retry else now
            continue
        fin, i, start = heapq.heappop(running)
        now = fin
        free_threads += 1
        if all(committed_by(j, start) for j in deps[i]):
            final_finish[i] = fin
        else:
            aborts += 1
            retry.append((fin, i))
    return max(final_finish) if n else 0.0, aborts


def analyse(name, balance_mode="delta"):
    d = load(name)
    txs = d["txs"]
    sets = keysets(txs, balance_mode)
    dur = durations(txs)
    seq = float(sum(dur))
    rd = raw_deps(sets)
    sd = strict_deps(sets)
    res = {
        "scenario": name, "balance_mode": balance_mode, "txs": len(txs),
        "succeeded": sum(t["status"] == 1 for t in txs),
        "reverted": sum(t["status"] != 1 for t in txs),
        "rounds_strict": greedy_rounds(sets),
        "raw_edges": sum(len(x) for x in rd),
        "critical_path_speedup": round(seq / list_schedule(rd, dur, len(dur)), 2),
        "speedup_schedule": {}, "speedup_optimistic": {}, "aborts": {},
        "keys_written_by_more_than_one_tx": shared_writes(sets),
    }
    for t in THREADS:
        res["speedup_schedule"][t] = round(seq / list_schedule(rd, dur, t), 2)
        mk, ab = optimistic(rd, dur, t)
        res["speedup_optimistic"][t] = round(seq / mk, 2)
        res["aborts"][t] = ab
    _ = sd
    return res


def shared_writes(sets):
    count = {}
    for _, w in sets:
        for k in w:
            count[k] = count.get(k, 0) + 1
    hot = sorted(((v, k) for k, v in count.items() if v > 1), reverse=True)[:3]
    return [f"{k.split('#')[0]} slot ({v} txs)" for v, k in hot]


def main():
    names = sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(TRACES, "*.json")))
    rows = []
    for nm in names:
        rows.append(analyse(nm, "delta"))
        if nm.startswith(("final_n", "legacy_n", "deposit_n", "final_contention")):
            rows.append(analyse(nm, "rmw"))
    with open(os.path.join(RESULTS, "parallel_exec.json"), "w") as f:
        json.dump(rows, f, indent=1)
    write_report(rows)
    for r in rows:
        print(f"{r['scenario']:<24} {r['balance_mode']:<5} txs={r['txs']:<4} rounds={r['rounds_strict']:<4} "
              f"S16 sched={r['speedup_schedule'][16]:<6} opt={r['speedup_optimistic'][16]:<6} "
              f"aborts16={r['aborts'][16]:<4} reverted={r['reverted']}")


def write_report(rows):
    L = ["# Parallel execution on traced read/write sets", "",
         "Generated by `off-chain/evaluation/parallel_exec.py` from the opcode traces written by "
         "`scripts/concurrency_trace.js` (one block per scenario). Speedup = sequential gas / makespan.", "",
         "| Scenario | Balances | Txs | Reverted | Strict rounds | Speedup 4 thr (sched / opt) | 16 thr | 64 thr | Aborts @16 | Hot shared writes |",
         "|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        s, o = r["speedup_schedule"], r["speedup_optimistic"]
        L.append(f"| {r['scenario']} | {r['balance_mode']} | {r['txs']} | {r['reverted']} | {r['rounds_strict']} | "
                 f"{s[4]} / {o[4]} | {s[16]} / {o[16]} | {s[64]} / {o[64]} | {r['aborts'][16]} | "
                 f"{'; '.join(r['keys_written_by_more_than_one_tx']) or '-'} |")
    with open(os.path.join(RESULTS, "parallel_report.md"), "w") as f:
        f.write("\n".join(L) + "\n")


if __name__ == "__main__":
    main()
