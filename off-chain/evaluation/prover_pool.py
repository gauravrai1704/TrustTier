"""
Throughput of the Tier-2 prover pool (router/prover_pool.py) on this machine.

The same batch of real EZKL proofs is generated under several splits of the
machine's cores into workers x Halo2 threads per worker, after warming every
worker up (process start and imports are not timed). For each split: wall
time, proofs per minute, the latency of an individual proof, and peak memory
per worker. Every proof's public features must equal its input and its label
must equal the model's.

Scale-out across machines is measured by emulation: k remote prover workers
(router/prover_worker.py, over HTTP, as on separate machines), each pinned with
taskset to its own disjoint set of cores, against one such worker. The
"machines" still share this host's memory bandwidth and caches, so real
separate machines can only do as well or better.

    python -m evaluation.prover_pool [--proofs 12]   -> results/prover_pool.{json,md}
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import socket
import subprocess
import sys
import time

import numpy as np

from risk_model.inference import RiskModel
from router.prover_pool import ProverPool

RESULTS = os.path.join(os.path.dirname(__file__), "results")
# (workers, threads per worker); None = cores // workers. The last two oversubscribe the cores.
CONFIGS = [(1, None), (2, None), (4, None), (2, "4"), (4, "4")]
CRASH_TIER2 = 165  # Tier-2 positions in the 374-position evaluation set


def batch(n: int, seed: int = 11) -> list[list[int]]:
    rng = np.random.default_rng(seed)
    return [[int(x) for x in rng.integers(0, 1025, 5)] for _ in range(n)]


def run_config(qs, workers: int, threads: int, model: RiskModel) -> dict:
    with ProverPool(workers=workers, threads_per_worker=threads) as pool:
        pool.warm_up()
        t0 = time.perf_counter()
        proofs = pool.prove_many(qs)
        wall = time.perf_counter() - t0
        rss = pool.peak_rss_mb
    for q, p in zip(qs, proofs):
        assert p.features == q, "proof is not about its input"
        assert p.label == model.predict_q(q)[0], "proven label differs from the model's"
    lat = [p.seconds for p in proofs]
    return {"workers": workers, "threads_per_worker": threads, "threads_total": workers * threads,
            "proofs": len(qs), "wall_s": round(wall, 2), "proofs_per_min": round(60 * len(qs) / wall, 2),
            "latency_mean_s": round(float(np.mean(lat)), 2), "latency_max_s": round(float(np.max(lat)), 2),
            "peak_rss_mb_per_worker": rss}


def remote_check(q) -> dict:
    """Start one prover worker over HTTP on a free port and prove through it."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "router.prover_worker:app", "--port", str(port)],
                            cwd=os.path.dirname(os.path.dirname(__file__)), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        import requests
        url = f"http://127.0.0.1:{port}"
        for _ in range(60):
            try:
                if requests.get(f"{url}/health", timeout=1).ok:
                    break
            except requests.RequestException:
                time.sleep(0.5)
        with ProverPool(workers=0, remotes=[url]) as pool:
            t0 = time.perf_counter()
            p = pool.prove(q)
            return {"ok": p.features == list(q), "seconds": round(time.perf_counter() - t0, 2)}
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def _start_worker(cpus: str, threads: int) -> tuple[subprocess.Popen, str]:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = {**os.environ, "RAYON_NUM_THREADS": str(threads)}
    proc = subprocess.Popen(["taskset", "-c", cpus, sys.executable, "-m", "uvicorn", "router.prover_worker:app",
                             "--port", str(port)], cwd=os.path.dirname(os.path.dirname(__file__)), env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import requests
    url = f"http://127.0.0.1:{port}"
    for _ in range(120):
        try:
            if requests.get(f"{url}/health", timeout=1).ok:
                return proc, url
        except requests.RequestException:
            time.sleep(0.5)
    proc.terminate()
    raise RuntimeError("prover worker did not start")


def scale_out(qs, cores_per_machine: int = 2) -> list[dict]:
    """1..k emulated machines of `cores_per_machine` cores each, over HTTP."""
    cores = os.cpu_count() or 1
    rows = []
    for k in range(1, cores // cores_per_machine + 1):
        procs = []
        try:
            urls = []
            for m in range(k):
                lo = m * cores_per_machine
                proc, url = _start_worker(f"{lo}-{lo + cores_per_machine - 1}", cores_per_machine)
                procs.append(proc)
                urls.append(url)
            with ProverPool(workers=0, remotes=urls) as pool:
                for _ in urls:  # warm every worker (first proof loads ezkl)
                    pool.prove(qs[0])
                t0 = time.perf_counter()
                proofs = pool.prove_many(qs)
                wall = time.perf_counter() - t0
            assert all(p.features == q for p, q in zip(proofs, qs))
            rows.append({"machines": k, "cores_per_machine": cores_per_machine, "proofs": len(qs), "wall_s": round(wall, 2),
                         "proofs_per_min": round(60 * len(qs) / wall, 2),
                         "latency_mean_s": round(float(np.mean([p.seconds for p in proofs])), 2)})
            print(rows[-1], flush=True)
        finally:
            for p in procs:
                p.terminate()
                p.wait(timeout=10)
    for r in rows:
        r["speedup_vs_one_machine"] = round(rows[0]["wall_s"] / r["wall_s"], 2)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--proofs", type=int, default=12)
    ap.add_argument("--scale-out-only", action="store_true", help="re-measure only scale-out; keep the rest")
    args = ap.parse_args()
    if args.scale_out_only:
        path = os.path.join(RESULTS, "prover_pool.json")
        with open(path) as f:
            report = json.load(f)
        report["scale_out"] = scale_out(batch(args.proofs))
        with open(path, "w") as f:
            json.dump(report, f, indent=2)
        with open(os.path.join(RESULTS, "prover_pool.md"), "w") as f:
            f.write(markdown(report))
        print(markdown(report))
        return
    cores = os.cpu_count() or 1
    qs = batch(args.proofs)
    model = RiskModel()
    rows = []
    for workers, t in CONFIGS:
        if workers > cores:
            continue
        threads = max(1, cores // workers) if t is None else int(t)
        r = run_config(qs, workers, threads, model)
        print(r, flush=True)
        rows.append(r)
    base = rows[0]
    for r in rows:
        r["speedup_vs_one_worker"] = round(base["wall_s"] / r["wall_s"], 2)
    best = max(rows, key=lambda r: r["proofs_per_min"])
    remote = remote_check(qs[0])
    scale = scale_out(qs)
    machines = [1, 2, 4, 8]
    report = {
        "machine": {"cores": cores, "python": platform.python_version(), "cpu": platform.processor() or platform.machine()},
        "proofs_per_config": args.proofs, "configs": rows, "best": best, "remote_worker": remote, "scale_out": scale,
        "crash_backlog": {
            "tier2_positions": CRASH_TIER2,
            "minutes_one_worker": round(CRASH_TIER2 / base["proofs_per_min"], 1),
            "minutes_best_local": round(CRASH_TIER2 / best["proofs_per_min"], 1),
            "minutes_projected_by_machines": {m: round(CRASH_TIER2 / (best["proofs_per_min"] * m), 1) for m in machines},
        },
    }
    with open(os.path.join(RESULTS, "prover_pool.json"), "w") as f:
        json.dump(report, f, indent=2)
    with open(os.path.join(RESULTS, "prover_pool.md"), "w") as f:
        f.write(markdown(report))
    print(markdown(report))


def markdown(r: dict) -> str:
    rows = "\n".join(
        f"| {c['workers']} x {c['threads_per_worker']} | {c['threads_total']} | {c['wall_s']} | {c['proofs_per_min']} | "
        f"{c['speedup_vs_one_worker']}x | {c['latency_mean_s']} | {c['peak_rss_mb_per_worker']} |" for c in r["configs"])
    cb = r["crash_backlog"]
    so = r.get("scale_out") or []
    so_rows = "\n".join(f"| {x['machines']} x {x['cores_per_machine']} cores | {x['wall_s']} | {x['proofs_per_min']} | "
                        f"{x['speedup_vs_one_machine']}x | {x['latency_mean_s']} |" for x in so)
    proj = ", ".join(f"{m} machine{'s' if int(m) > 1 else ''}: {v} min" for m, v in cb["minutes_projected_by_machines"].items())
    return f"""# Prover pool throughput

`python -m evaluation.prover_pool` - {r['proofs_per_config']} real EZKL proofs per configuration on a
{r['machine']['cores']}-core machine; workers warmed up before timing; every proof's features and label checked.

| workers x threads | threads | wall (s) | proofs/min | vs 1 worker | latency per proof (s) | peak RSS per worker (MB) |
|---|---|---|---|---|---|---|
{rows}

A single EZKL proof already parallelises well inside Halo2, so on one machine
splitting the cores among workers trades latency for throughput: each proof
takes longer, the batch finishes sooner by the gain shown above, and every
worker needs its own copy of the proving key in memory. Oversubscribing the
cores only adds contention. The pool's real lever is more machines: a remote
worker (`router/prover_worker.py`) proved through HTTP in {r['remote_worker']['seconds']} s
(correct: {r['remote_worker']['ok']}).

**Scale-out over HTTP** (emulated machines: one remote worker per disjoint core set, `taskset`):

| machines | wall (s) | proofs/min | vs 1 machine | latency per proof (s) |
|---|---|---|---|---|
{so_rows}

**Crash backlog.** Proving the {cb['tier2_positions']} Tier-2 positions of the evaluation set takes
{cb['minutes_one_worker']} min with one worker and {cb['minutes_best_local']} min with the best local split;
projected with remote workers at the best local rate per machine: {proj}.
"""


if __name__ == "__main__":
    main()
