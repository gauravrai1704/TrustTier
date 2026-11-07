# Prover pool throughput

`python -m evaluation.prover_pool` - 12 real EZKL proofs per configuration on a
4-core machine; workers warmed up before timing; every proof's features and label checked.

| workers x threads | threads | wall (s) | proofs/min | vs 1 worker | latency per proof (s) | peak RSS per worker (MB) |
|---|---|---|---|---|---|---|
| 1 x 4 | 4 | 77.8 | 9.25 | 1.0x | 6.48 | 1761 |
| 2 x 2 | 4 | 72.2 | 9.97 | 1.08x | 12.03 | 1590 |
| 4 x 1 | 4 | 68.84 | 10.46 | 1.13x | 22.83 | 1514 |
| 2 x 4 | 8 | 71.98 | 10.0 | 1.08x | 11.99 | 1620 |
| 4 x 4 | 16 | 70.45 | 10.22 | 1.1x | 23.42 | 1750 |

A single EZKL proof already parallelises well inside Halo2, so on one machine
splitting the cores among workers trades latency for throughput: each proof
takes longer, the batch finishes sooner by the gain shown above, and every
worker needs its own copy of the proving key in memory. Oversubscribing the
cores only adds contention. The pool's real lever is more machines: a remote
worker (`router/prover_worker.py`) proved through HTTP in 6.9 s
(correct: True).

**Scale-out over HTTP** (emulated machines: one remote worker per disjoint core set, `taskset`):

| machines | wall (s) | proofs/min | vs 1 machine | latency per proof (s) |
|---|---|---|---|---|
| 1 x 2 cores | 142.6 | 5.05 | 1.0x | 11.88 |
| 2 x 2 cores | 73.89 | 9.74 | 1.93x | 12.28 |

**Crash backlog.** Proving the 165 Tier-2 positions of the evaluation set takes
17.8 min with one worker and 15.8 min with the best local split;
projected with remote workers at the best local rate per machine: 1 machine: 15.8 min, 2 machines: 7.9 min, 4 machines: 3.9 min, 8 machines: 2.0 min.
