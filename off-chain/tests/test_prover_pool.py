"""The prover pool's scheduling and the router's batch path, without EZKL
(the real-proof throughput is measured by evaluation/prover_pool.py)."""

import time
from concurrent.futures import Future

import pytest

from router.prover import Tier2Proof
from router.prover_pool import ProverPool


class _InlinePool(ProverPool):
    """ProverPool whose local workers are threads running a fake prover, so the
    test needs neither EZKL nor the 575 MB proving key."""

    def __init__(self, workers, delay=0.05, fail_on=None):
        from concurrent.futures import ThreadPoolExecutor
        import itertools, threading
        self.workers, self.threads, self.remotes, self.peak_rss_mb = workers, 1, [], 0
        self._local, self._remote = ThreadPoolExecutor(max_workers=workers), None
        self._slots = itertools.cycle([("local", None)] * workers)
        self._lock = threading.Lock()
        self.delay, self.fail_on, self.calls = delay, fail_on, []

    def submit(self, q):
        def work():
            self.calls.append(list(q))
            time.sleep(self.delay)
            if self.fail_on is not None and list(q) == self.fail_on:
                raise RuntimeError("prover failed")
            return Tier2Proof(proof=bytes(q), public_inputs=list(q) + [1, 3, 1021], seconds=self.delay)
        return self._local.submit(work)


def test_results_keep_the_order_of_the_inputs():
    qs = [[i, 1, 2, 3, 4] for i in range(8)]
    with _InlinePool(workers=4, delay=0.02) as pool:
        out = pool.prove_many(qs)
    assert [p.features for p in out] == qs


def test_workers_run_in_parallel():
    qs = [[i, 0, 0, 0, 0] for i in range(8)]
    with _InlinePool(workers=4, delay=0.1) as pool:
        t0 = time.perf_counter()
        pool.prove_many(qs)
        wall = time.perf_counter() - t0
    assert wall < 0.5  # 8 jobs x 0.1 s on 4 workers ~ 0.2 s, sequentially 0.8 s


def test_a_failed_proof_is_raised_not_swallowed():
    with _InlinePool(workers=2, fail_on=[9, 9, 9, 9, 9]) as pool:
        with pytest.raises(RuntimeError):
            pool.prove_many([[1, 1, 1, 1, 1], [9, 9, 9, 9, 9]])


def test_pool_needs_a_worker_and_reads_its_size_from_the_environment(monkeypatch):
    with pytest.raises(ValueError):
        ProverPool(workers=0)
    monkeypatch.delenv("TRUSTTIER_PROVER_WORKERS", raising=False)
    monkeypatch.delenv("TRUSTTIER_PROVER_REMOTES", raising=False)
    assert ProverPool.from_env() is None


def test_router_batch_proves_tier2_in_parallel_and_submits_in_order(monkeypatch):
    """process_batch: cheap claims are submitted while proofs run, Tier-2
    decisions follow in input order, and every proof comes from the pool."""
    from router import processor as proc
    from router.tiering import Tier

    sent = []

    class Chain:
        verifier_mode = "real"
        def refresh_mock_feeds(self): return 0
        def current_features(self, pid):
            delta = {1: 3000, 2: 200, 3: 3000, 4: 100}[pid]
            return {"q": [pid, 2, 3, 4, 5], "delta_bps": delta, "past_round": 1,
                    "position": {"debt_usd": 1, "collateral_usd": 2}}
        def decide_heuristic(self, pid, past):
            sent.append(("T0", pid)); return _Receipt()
        def decide_zk_proof(self, pid, past, mh, proof, inputs):
            sent.append(("T2", pid)); return _Receipt()

    class _Receipt:
        gasUsed = 1
        transactionHash = bytes(32)

    class Model:
        model_hash = "0x" + "11" * 32
        def predict_q(self, q): return 1, [0.1, 0.9]

    monkeypatch.setattr(proc, "PROVER_MODE", "ezkl")
    pool = _InlinePool(workers=2, delay=0.05)
    p = proc.PositionProcessor(Chain(), Model(), pool=pool)
    # Proofs must not be regenerated inline: the inline prover is not available.
    p.prover = None
    out = p.process_batch([1, 2, 3, 4])
    pool.close()
    assert [r.position_id for r in out] == [1, 2, 3, 4]
    assert [r.tier for r in out] == ["HEURISTIC", "ZK_PROOF", "HEURISTIC", "ZK_PROOF"]
    assert sent == [("T0", 1), ("T0", 3), ("T2", 2), ("T2", 4)]
    assert sorted(c[0] for c in pool.calls) == [2, 4]
