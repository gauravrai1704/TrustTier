"""
FastAPI service exposing the TrustTier off-chain router.

Run from the off-chain/ directory, after contracts are deployed and the
model is registered:
    uvicorn main:app --reload --port 8000

Endpoints:
    GET  /health
    GET  /cost-model           - measured per-tier gas constants (Weeks 3-6),
                                  used by the frontend's cost comparison panel
                                  so it never duplicates these numbers
    POST /positions/evaluate   - process a single position through the
                                  delta -> tier -> on-chain pipeline
    POST /simulate             - generate and process a synthetic position
                                  stream in one call (the milestone demo,
                                  reachable over HTTP instead of the CLI)
"""

from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from evaluation.cost_model import GAS_BY_TIER, TIER2_PROVING_SECONDS
from risk_model.inference import RiskModel
from router.chain_client import ChainClient
from router.position_stream import generate_position_stream
from router.processor import PositionProcessor

app = FastAPI(title="TrustTier Off-Chain Router", version="0.1.0")

# The frontend dev server (Vite, Weeks 7-8) normally reaches this API
# through Vite's own /api proxy - see frontend/vite.config.js - which
# avoids needing CORS at all in the common case. This middleware is kept
# as a fallback for anyone running the frontend build directly against
# this server from a different origin (e.g. `vite preview`, or a
# deployed static build) without going through that proxy.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# Initialized lazily so `uvicorn main:app` fails fast with a clear error if
# contracts aren't deployed / the model isn't trained yet, rather than at
# import time (which would break automatic reload / testing without a chain).
_risk_model: Optional[RiskModel] = None
_chain_client: Optional[ChainClient] = None
_processor: Optional[PositionProcessor] = None


def get_processor() -> PositionProcessor:
    global _risk_model, _chain_client, _processor
    if _processor is None:
        try:
            _risk_model = RiskModel()
            _chain_client = ChainClient()
            _processor = PositionProcessor(chain_client=_chain_client, risk_model=_risk_model)
        except (FileNotFoundError, ConnectionError) as e:
            raise HTTPException(
                status_code=503,
                detail=(
                    f"Router not ready: {e}. Ensure `npx hardhat node` is running, "
                    f"contracts are deployed, and the risk model is trained."
                ),
            )
    return _processor


class PositionFeatures(BaseModel):
    ltv: float = Field(..., ge=0, le=1.5)
    collateral_volatility_30d: float = Field(..., ge=0, le=1.0)
    price_momentum_24h: float = Field(..., ge=-1.0, le=1.0)
    time_since_last_topup_days: float = Field(..., ge=0, le=90)
    account_age_days: float = Field(..., ge=0, le=5000)


class EvaluateRequest(BaseModel):
    position_id: int
    features: PositionFeatures


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/cost-model")
def cost_model():
    """
    The measured (not estimated) per-tier gas costs from
    evaluation/cost_model.py, plus real Tier-2 proving time. Exposed as an
    endpoint so the frontend's cost-comparison panel reads the same source
    of truth as evaluate.py and concurrency_sim.py, rather than
    hardcoding a second copy of these numbers in JavaScript.
    """
    return {
        "gas_by_tier": GAS_BY_TIER,
        "tier2_proving_seconds": TIER2_PROVING_SECONDS,
    }


@app.post("/positions/evaluate")
def evaluate_position(request: EvaluateRequest):
    processor = get_processor()
    result = processor.process(request.position_id, request.features.model_dump())
    return result.to_dict()


@app.post("/simulate")
def simulate(n_positions: int = 12):
    processor = get_processor()
    positions = generate_position_stream(n_positions=n_positions)
    results = [processor.process(p.position_id, p.to_features()) for p in positions]

    tier_counts = {}
    for r in results:
        tier_counts[r.tier] = tier_counts.get(r.tier, 0) + 1

    return {
        "results": [r.to_dict() for r in results],
        "tier_counts": tier_counts,
        "all_tiers_exercised": len(tier_counts) == 3,
    }

