from evaluation.concurrency_sim import (
    conflicts,
    read_write_sets_old_design,
    read_write_sets_new_design,
    schedule_into_rounds,
)


class TestConflictDetection:
    def test_read_read_never_conflicts(self):
        a = ({"X"}, set())
        b = ({"X"}, set())
        assert conflicts(a, b) is False

    def test_write_write_on_same_key_conflicts(self):
        a = (set(), {"X"})
        b = (set(), {"X"})
        assert conflicts(a, b) is True

    def test_write_read_on_same_key_conflicts(self):
        a = (set(), {"X"})
        b = ({"X"}, set())
        assert conflicts(a, b) is True

    def test_disjoint_keys_never_conflict(self):
        a = ({"X"}, {"Y"})
        b = ({"Z"}, {"W"})
        assert conflicts(a, b) is False


class TestReadWriteSets:
    def test_old_design_always_includes_shared_array_slot(self):
        tx_a = {"position_id": 1, "tier": "HEURISTIC"}
        tx_b = {"position_id": 2, "tier": "ZK_PROOF"}
        _, writes_a = read_write_sets_old_design(tx_a)
        _, writes_b = read_write_sets_old_design(tx_b)
        # Both transactions must share at least one write key (the array
        # slot) even though they target different positions - this is
        # exactly the false-conflict bug being demonstrated.
        assert writes_a & writes_b

    def test_new_design_disjoint_for_different_positions(self):
        tx_a = {"position_id": 1, "tier": "HEURISTIC"}
        tx_b = {"position_id": 2, "tier": "ZK_PROOF"}
        _, writes_a = read_write_sets_new_design(tx_a)
        _, writes_b = read_write_sets_new_design(tx_b)
        assert not (writes_a & writes_b)

    def test_new_design_conflicts_for_same_position(self):
        tx_a = {"position_id": 5, "tier": "HEURISTIC"}
        tx_b = {"position_id": 5, "tier": "ZK_PROOF"}
        _, writes_a = read_write_sets_new_design(tx_a)
        _, writes_b = read_write_sets_new_design(tx_b)
        assert writes_a & writes_b


class TestScheduling:
    def test_old_design_serializes_everything(self):
        txs = [{"position_id": i, "tier": "HEURISTIC"} for i in range(10)]
        rounds = schedule_into_rounds(txs, read_write_sets_old_design)
        assert len(rounds) == 10
        assert all(len(r) == 1 for r in rounds)

    def test_new_design_parallelizes_disjoint_positions(self):
        txs = [{"position_id": i, "tier": "HEURISTIC"} for i in range(10)]
        rounds = schedule_into_rounds(txs, read_write_sets_new_design)
        assert len(rounds) == 1
        assert len(rounds[0]) == 10

    def test_new_design_still_serializes_same_position_collisions(self):
        # Three transactions all racing for position 1 must land in three
        # separate rounds even under the new design - they genuinely
        # conflict, and that's correct, not a bug.
        txs = [{"position_id": 1, "tier": "HEURISTIC"} for _ in range(3)]
        rounds = schedule_into_rounds(txs, read_write_sets_new_design)
        assert len(rounds) == 3

    def test_new_design_mixed_batch(self):
        # 5 transactions on 5 distinct positions, plus 2 more racing for
        # one of those same positions - expect 1 round for the 5 disjoint
        # ones, plus 2 more rounds for the collision.
        txs = [{"position_id": i, "tier": "HEURISTIC"} for i in range(5)]
        txs += [{"position_id": 0, "tier": "COMMITMENT"}, {"position_id": 0, "tier": "ZK_PROOF"}]
        rounds = schedule_into_rounds(txs, read_write_sets_new_design)
        assert len(rounds) == 3
