# Prover pool throughput

`python -m evaluation.prover_pool` - 12 real EZKL proofs per configuration on a
4-core machine; workers warmed up before timing; every proof's features and label checked.

| workers x threads | threads | wall (s) | proofs/min | vs 1 worker | latency per proof (s) | peak RSS per worker (MB) |
|---|---|---|---|---|---|---|
| 1 x 4 | 4 | 123.85 | 5.81 | 1.0x | 10.32 | 2151 |
| 2 x 2 | 4 | 114.72 | 6.28 | 1.08x | 18.87 | 1909 |
| 4 x 1 | 4 | 115.54 | 6.23 | 1.07x | 38.06 | 1884 |
| 2 x 4 | 8 | 111.39 | 6.46 | 1.11x | 18.56 | 2146 |
| 4 x 4 | 16 | 109.26 | 6.59 | 1.13x | 36.1 | 2150 |

A single EZKL proof already parallelises well inside Halo2, so on one machine
splitting the cores among workers trades latency for throughput: each proof
takes longer, the batch finishes sooner by the gain shown above, and every
worker needs its own copy of the proving key in memory. Oversubscribing the
cores only adds contention. The pool's real lever is more machines: a remote
worker (`router/prover_worker.py`) proved through HTTP in 10.43 s
(correct: True).

**Scale-out over HTTP** (emulated machines: one remote worker per disjoint core set, `taskset`):

| machines | wall (s) | proofs/min | vs 1 machine | latency per proof (s) |
|---|---|---|---|---|
| 1 x 2 cores | 203.72 | 3.53 | 1.0x | 16.97 |
| 2 x 2 cores | 112.13 | 6.42 | 1.82x | 18.66 |

**Crash backlog.** Proving the 155 Tier-2 positions of the evaluation set takes
26.7 min with one worker and 23.5 min with the best local split;
projected with remote workers at the best local rate per machine: 1 machine: 23.5 min, 2 machines: 11.8 min, 4 machines: 5.9 min, 8 machines: 2.9 min.
