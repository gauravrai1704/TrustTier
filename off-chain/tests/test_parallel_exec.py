"""Unit tests for the parallel-execution simulator (evaluation/parallel_exec.py)."""

import unittest

from evaluation.parallel_exec import greedy_rounds, keysets, list_schedule, optimistic, raw_deps


def tx(reads=(), writes=(), balances=()):
    return {"reads": list(reads), "writes": list(writes), "balances": list(balances)}


class TestDependencies(unittest.TestCase):
    def test_raw_only_from_lower_index(self):
        sets = keysets([tx(writes=["a"]), tx(reads=["a"]), tx(writes=["a"])], "delta")
        self.assertEqual(raw_deps(sets), [set(), {0}, set()])  # write-after-write is not a RAW dependency

    def test_balance_modes(self):
        txs = [tx(balances=["Engine"]), tx(balances=["Engine"])]
        self.assertEqual(raw_deps(keysets(txs, "delta")), [set(), set()])
        self.assertEqual(raw_deps(keysets(txs, "rmw")), [set(), {0}])

    def test_sender_account_is_always_read_modify_write(self):
        txs = [tx(balances=["account:0xa"]), tx(balances=["account:0xa"])]
        self.assertEqual(raw_deps(keysets(txs, "delta")), [set(), {0}])

    def test_strict_rounds(self):
        disjoint = keysets([tx(writes=[k]) for k in "abcd"], "delta")
        self.assertEqual(greedy_rounds(disjoint), 1)
        shared = keysets([tx(reads=["n"], writes=["n"]) for _ in range(4)], "delta")
        self.assertEqual(greedy_rounds(shared), 4)


class TestSchedulers(unittest.TestCase):
    def test_independent_transactions_scale_with_threads(self):
        deps, dur = [set()] * 8, [10.0] * 8
        self.assertEqual(list_schedule(deps, dur, 1), 80.0)
        self.assertEqual(list_schedule(deps, dur, 4), 20.0)
        self.assertEqual(optimistic(deps, dur, 8), (10.0, 0))

    def test_chain_cannot_be_parallelized(self):
        deps, dur = [set()] + [{i} for i in range(7)], [10.0] * 8
        self.assertEqual(list_schedule(deps, dur, 8), 80.0)
        makespan, aborts = optimistic(deps, dur, 8)
        self.assertEqual(aborts, 7)          # every speculative run read a stale value
        self.assertGreaterEqual(makespan, 80.0)

    def test_one_thread_is_sequential(self):
        deps, dur = [set(), {0}, set()], [3.0, 4.0, 5.0]
        self.assertEqual(list_schedule(deps, dur, 1), 12.0)
        self.assertEqual(optimistic(deps, dur, 1), (12.0, 0))


if __name__ == "__main__":
    unittest.main()
