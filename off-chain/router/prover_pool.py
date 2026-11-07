"""
Parallel Tier-2 proving: a pool of EZKL prover workers.

Inspired by BlockRaFT (Piduguralla et al., ICSA 2026), where a leader hands
work to follower machines so one logical node scales out. Here the router is
the leader and proving - ~16 s per proof on a 2-vCPU machine, the system's
bottleneck - is the work: in a crash, many positions need a Tier-2 proof at
once, and the pool proves them concurrently while the router submits the
transactions in order from its one account.

Two kinds of worker:
  - local: processes on this machine (ProcessPoolExecutor, spawn context).
    Each worker's Halo2 prover gets `threads_per_worker` threads
    (RAYON_NUM_THREADS), so workers x threads should not exceed the cores:
    one EZKL proof already parallelises well internally (23.0 s on 1 thread,
    6.4 s on 4 on our 4-core machine), and oversubscribing only adds
    contention. evaluation/prover_pool.py measures the trade-off.
  - remote: other machines running `python -m router.prover_worker`, reached
    over HTTP; the pool spreads jobs across them. This is where throughput
    scales roughly with the number of machines.

Proofs are public data and are checked on-chain, so a worker needs no trust:
a wrong or forged proof only makes the router's transaction revert.

    TRUSTTIER_PROVER_WORKERS=2 TRUSTTIER_PROVER_THREADS=2 uvicorn main:app
    TRUSTTIER_PROVER_REMOTES=http://10.0.0.5:8100,http://10.0.0.6:8100 uvicorn main:app
"""

from __future__ import annotations

import itertools
import multiprocessing
import os
import threading
from concurrent.futures import Future, ProcessPoolExecutor, ThreadPoolExecutor
from typing import Callable, Optional, Sequence

from router.prover import EzklProver, Tier2Proof

_worker_prover: Optional[EzklProver] = None


def _init_worker(threads: Optional[int], circuits_dir: Optional[str]):
    # Must run before ezkl (and its rayon thread pool) is first imported.
    if threads:
        os.environ["RAYON_NUM_THREADS"] = str(threads)
    global _worker_prover
    _worker_prover = EzklProver(circuits_dir) if circuits_dir else EzklProver()


def _prove_in_worker(q: Sequence[int]) -> tuple[bytes, list[int], float, int]:
    import resource
    p = _worker_prover.prove(q)
    rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
    return p.proof, p.public_inputs, p.seconds, rss_mb


def _prove_remote(url: str, q: Sequence[int], timeout: float = 600) -> tuple[bytes, list[int], float, int]:
    import requests
    r = requests.post(f"{url.rstrip('/')}/prove", json={"q": [int(x) for x in q]}, timeout=timeout)
    r.raise_for_status()
    d = r.json()
    return bytes.fromhex(d["proof"].removeprefix("0x")), [int(x) for x in d["public_inputs"]], float(d["seconds"]), int(d.get("rss_mb", 0))


class ProverPool:
    """Proves many feature vectors concurrently; results come back in order."""

    def __init__(self, workers: int = 1, threads_per_worker: Optional[int] = None,
                 remotes: Sequence[str] = (), circuits_dir: Optional[str] = None):
        if workers < 0 or (workers == 0 and not remotes):
            raise ValueError("need at least one local worker or one remote")
        cores = os.cpu_count() or 1
        self.workers = workers
        self.threads = threads_per_worker or max(1, cores // max(1, workers))
        self.remotes = list(remotes)
        self.peak_rss_mb = 0
        self._local = (ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context("spawn"),
                                           initializer=_init_worker, initargs=(self.threads, circuits_dir))
                       if workers else None)
        self._remote = ThreadPoolExecutor(max_workers=max(1, len(self.remotes))) if self.remotes else None
        # Round-robin over every slot: each local worker and each remote.
        self._slots = itertools.cycle([("local", None)] * workers + [("remote", u) for u in self.remotes])
        self._lock = threading.Lock()

    @classmethod
    def from_env(cls) -> Optional["ProverPool"]:
        workers = int(os.environ.get("TRUSTTIER_PROVER_WORKERS", "0") or 0)
        remotes = [u for u in os.environ.get("TRUSTTIER_PROVER_REMOTES", "").split(",") if u.strip()]
        if workers <= 0 and not remotes:
            return None
        threads = int(os.environ.get("TRUSTTIER_PROVER_THREADS", "0") or 0) or None
        return cls(workers=max(0, workers), threads_per_worker=threads, remotes=remotes)

    def submit(self, q: Sequence[int]) -> Future:
        with self._lock:
            kind, url = next(self._slots)
        raw = (self._local.submit(_prove_in_worker, list(q)) if kind == "local"
               else self._remote.submit(_prove_remote, url, list(q)))
        out: Future = Future()

        def done(f):
            try:
                proof, inputs, seconds, rss = f.result()
                self.peak_rss_mb = max(self.peak_rss_mb, rss)
                out.set_result(Tier2Proof(proof=proof, public_inputs=inputs, seconds=seconds))
            except BaseException as e:  # noqa: BLE001 - re-raised to the caller
                out.set_exception(e)

        raw.add_done_callback(done)
        return out

    def prove(self, q: Sequence[int]) -> Tier2Proof:
        return self.submit(q).result()

    def prove_many(self, qs: Sequence[Sequence[int]], on_done: Optional[Callable[[int, Tier2Proof], None]] = None
                   ) -> list[Tier2Proof]:
        """All proofs, in the order of `qs`. Raises the first failure."""
        futures = [self.submit(q) for q in qs]
        if on_done:
            for i, f in enumerate(futures):
                f.add_done_callback(lambda fut, i=i: fut.exception() is None and on_done(i, fut.result()))
        return [f.result() for f in futures]

    def warm_up(self, q: Sequence[int] = (512, 512, 512, 512, 512)):
        """Start every local worker process (spawn + imports) before timing."""
        if self._local:
            list(self._local.map(_prove_in_worker, [list(q)] * self.workers))

    def close(self):
        if self._local:
            self._local.shutdown(wait=True, cancel_futures=True)
        if self._remote:
            self._remote.shutdown(wait=True, cancel_futures=True)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def describe(self) -> dict:
        return {"local_workers": self.workers, "threads_per_worker": self.threads, "remotes": self.remotes,
                "cores": os.cpu_count()}

