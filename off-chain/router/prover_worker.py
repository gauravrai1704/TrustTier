"""
A remote Tier-2 prover worker: the follower side of the router's prover pool
(router/prover_pool.py). Run it on another machine that has the circuit
artifacts (circuits/network.compiled, kzg.srs and pk.key - rebuild pk.key
with circuits/make_proving_key.py), then point the router at it:

    # on the worker machine, in off-chain/
    uvicorn router.prover_worker:app --host 0.0.0.0 --port 8100
    # on the router machine
    TRUSTTIER_PROVER_REMOTES=http://worker-host:8100 uvicorn main:app

It only proves; it holds no keys and sends no transactions. Proofs are
public and verified on-chain, so the router does not need to trust it.
Expose it only on a private network: proving is expensive, and an open
endpoint lets anyone spend the machine's CPU.
"""

import resource
import threading

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from router.prover import EzklProver

app = FastAPI(title="TrustTier prover worker")
_prover = EzklProver()
_busy = threading.Lock()  # one proof at a time: EZKL already uses every core


class ProveRequest(BaseModel):
    q: list[int] = Field(..., min_length=5, max_length=5)


@app.get("/health")
def health():
    return {"status": "ok", "ready": _prover.available()}


@app.post("/prove")
def prove(req: ProveRequest):
    if not _prover.available():
        raise HTTPException(status_code=503, detail="circuit artifacts missing: run circuits/make_proving_key.py")
    try:
        with _busy:
            p = _prover.prove(req.q)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"proof": "0x" + p.proof.hex(), "public_inputs": [str(x) for x in p.public_inputs],
            "seconds": round(p.seconds, 3), "rss_mb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024}
