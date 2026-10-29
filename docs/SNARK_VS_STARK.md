# Tier 2: zk-SNARK vs zk-STARK

TrustTier's Tier 2 currently uses a zk-SNARK (Halo2 with KZG polynomial
commitments, via EZKL). This document is a grounded comparison against the
alternative — a zk-STARK — asking specifically: would TrustTier be better
off with a STARK at Tier 2? The short answer is no, for reasons specific to
*this* system's architecture (unbatched, per-decision, on-chain
verification), not a generic "SNARKs vs STARKs" ranking. The two schemes
make different trade-offs, and which one wins depends entirely on how the
proof is used.

## The two schemes, in brief

| | zk-SNARK (Halo2 + KZG, via EZKL) | zk-STARK |
|---|---|---|
| Trusted setup | Required (KZG needs a structured reference string) | Not required (hash-based, transparent) |
| Post-quantum security | No — relies on elliptic-curve discrete log | Yes — relies only on collision-resistant hashes |
| Proof size | Small (our measured proof: **3,584 bytes** of on-chain calldata) | Large (typically 40 KB – several hundred KB, grows poly-logarithmically with circuit size) |
| Verification cost (single, unbatched proof) | Small (our measured on-chain verification: **621,921 gas**) | Large per-proof — STARK verifiers are comparatively expensive to run on a single proof |
| Verification cost (amortized over a large batch) | Doesn't batch specially — cost is roughly linear in the number of proofs | Very cheap *per underlying statement* once amortized across a large batch (this is STARK rollups' core trick) |
| Proving time | Our measured: **~16 s** for the reference model | Comparable or faster for similar-sized computations, but less mature general-purpose ML tooling |

## Why SNARK fits TrustTier's actual design better

TrustTier's Tier 2 verifies **one liquidation decision at a time, as it
happens**: `decideZkProof` is called once per position, synchronously, and
the result is needed immediately to approve or reject that single
liquidation. This is the unbatched, per-decision, verify-now model.

STARKs' standout real-world efficiency case — the one that makes them
attractive for systems like Starknet — is exactly the opposite shape:
*batch* thousands of transactions together, generate **one** STARK proof
for the whole batch, and verify that one proof on L1 for a cost of roughly
a few hundred thousand gas **total**, amortized across every transaction in
the batch. The STARK verifier itself is not cheap to run per-proof; it's
cheap *per-transaction-in-the-batch* because the fixed verification cost is
spread across potentially thousands of them. Strip away the batching and
verify a single STARK proof on its own, and the per-proof gas and size
numbers are considerably worse than a comparably-sized SNARK's — which is
exactly TrustTier's situation, since each Tier-2 call is a lone, immediate
decision, never a batch collected and proved together.

Our own measured SNARK numbers make the unbatched cost concrete: **3,584
bytes** of proof calldata and **621,921 gas** for the standalone verifier
call (875,489 gas for the full `decideZkProof` path, which also reads the
position and two Chainlink feeds, computes the five features on-chain,
checks them against the proof's public inputs and writes the audit log)
to verify a single decision (`off-chain/evaluation/results/gas_measurements.json`).

### Published evidence for the STARK side

We did not build a STARK version of the circuit, so the STARK side of the
comparison rests on published measurements:

| Source | What it measured | Figure |
|---|---|---|
| Nainwal, Kamble and Awathare, *A Comparative Analysis of zk-SNARKs and zk-STARKs: Theory and Practice*, arXiv:2512.10020 (2025), Table III | Same statement proved with Groth16 and with a STARK | Proof size **384 B (Groth16) vs 68,564 B (STARK)**, ~178x; STARK proving 3.8 s vs 55 ms on an Apple M1, while STARK verification was faster off-chain (472 ms vs 1.8 s) |
| zkSecurity, *stark-evm-adapter* write-up | A Cairo (STARK) proof of a tiny Fibonacci program | **166 KB** proof, split across several L1 transactions for verification |
| Epic Web3, *Why does StarkWare use block packing?* | Verifying one StarkWare proof on Ethereum L1 | **~9 M gas** - affordable only because one proof covers a whole batch |
| RISC Zero documentation, *Recursion* | Production zkVM built on STARKs | Wraps its ~200 KB recursive STARK in a **Groth16** proof for on-chain verification |

Taken together: a lone STARK costs roughly an order of magnitude more
calldata, and on L1 several million gas to verify, against our 3.6 KB and
0.62 M gas. Even STARK-based production systems switch to a SNARK for the
on-chain step. That is the regime TrustTier's Tier 2 is in - one proof per
decision, verified immediately. Note that the 384-byte Groth16 figure is
smaller than our 3.6 KB Halo2 proof: Halo2/KZG trades some proof size for a
universal (circuit-independent) setup and EZKL's tooling.

There's also a practical tooling gap: EZKL (Halo2/KZG-based) has mature,
well-documented support for taking an ONNX model and producing a circuit,
proof, and Solidity verifier with minimal custom work — which is exactly
what made the real, working Tier-2 pipeline in this project possible on a
course timeline. The closest STARK-side equivalent for ML models is
Giza's **Orion** (`gizatechxyz/orion`, ONNX-to-Cairo, which compiles down
to STARK proofs via the Cairo/StarkNet stack) — but it is less mature for
general scikit-learn-style models than EZKL, and Giza's own newer project,
**LuminAIR**, suggests Orion may not even be Giza's primary path going
forward. Given that TrustTier already has a real, measured, working EZKL
pipeline (see the main README's "Measured results from this pipeline"
table), replacing it with a STARK-based equivalent would mean adopting
less mature tooling to gain a property — cheap verification at scale — that
TrustTier's current unbatched usage pattern doesn't exploit anyway.

## Where STARKs genuinely would help

This conclusion is specific to TrustTier's *current* design, not a
blanket claim that SNARKs are always better. If TrustTier were extended so
that Tier-2 decisions for many positions were collected and proved
**together as one batch** (e.g. a periodic "settlement" proof covering
every Tier-2 escalation in the last N blocks, rather than one proof per
position per transaction), a STARK's batched-verification economics would
start to look attractive, and its lack of a trusted setup would remove the
self-generated-SRS caveat documented in the main README and
`circuits/build_circuit.py`. That would be a genuine architectural change
— moving Tier 2 from synchronous per-decision verification to an
optimistic-batched model — and is noted as realistic future work rather
than something this project's scope or timeline supports today.

## Post-quantum security: a real but currently low-priority trade-off

STARKs' hash-based security is post-quantum; KZG-based SNARKs are not (a
sufficiently large quantum computer could break the elliptic-curve
discrete-log assumption KZG relies on). For a course project targeting
Sepolia testnet deployment, this is a theoretical rather than practical
concern on any realistic timeline. For a real production deployment
securing real liquidation decisions over a period of years, it would be a
legitimate reason to revisit this choice — flagged here for completeness,
consistent with this project's broader practice of documenting
deployment-readiness gaps (see `docs/SECURITY.md`) rather than treating
coursework-scale decisions as production-final ones.

## Conclusion

| Criterion | Winner for TrustTier | Why |
|---|---|---|
| Unbatched, single-decision verification cost | **SNARK** | STARKs' efficiency case depends on amortizing across large batches; TrustTier verifies one decision at a time |
| Tooling maturity for ONNX risk models | **SNARK** (EZKL) | Orion/Cairo tooling is comparatively less mature for this use case |
| Trusted setup | STARK (no setup needed) | Real but currently mitigated by documenting the self-generated-SRS limitation; not a blocker for coursework scope |
| Post-quantum security | STARK | Relevant for a real deployment, not for this project's timeline |
| **Net fit for TrustTier's current architecture** | **zk-SNARK (Halo2/KZG via EZKL)** | Matches the unbatched, synchronous, per-decision verification model TrustTier actually uses |

Sources: [arXiv:2512.10020](https://arxiv.org/html/2512.10020v1) ·
[zkSecurity: stark-evm-adapter](https://blog.zksecurity.xyz/posts/stark-evm-adapter/) ·
[Epic Web3: block packing](https://epicweb3.substack.com/p/why-does-starkware-use-block-packing) ·
[RISC Zero: recursion](https://dev.risczero.com/api/recursion)

TrustTier keeps Halo2/KZG via EZKL for Tier 2. A STARK-based Tier 2 is
identified as realistic future work specifically if TrustTier is extended
to batch multiple Tier-2 decisions into a single settlement proof.
