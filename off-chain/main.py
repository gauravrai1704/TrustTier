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
    GET  /markets              - the deployed markets (feeds, thresholds, prices)
    POST /positions/open       - demo: open a MockLendingPool position (market,
                                  LTV, account age, days since top-up)
    GET  /positions/{id}/features
                                - the engine's own on-chain view: q, delta,
                                  the tier the chain allows, the model's label
    POST /positions/evaluate   - route one existing position: the router reads
                                  q and delta from the chain and decides
    POST /markets/{id}/price   - demo: move a mock price feed (stage a crash)
    POST /simulate             - open and route a synthetic stream of positions
    GET  /deployment           - LiquidationEngine address + ABI, so the
                                  frontend can talk to the contract directly
                                  through the user's own wallet (MetaMask)
                                  instead of only through this backend
    GET  /auth/nonce           - Sign-In-With-Ethereum style auth, step 1
    POST /auth/verify          - SIWE step 2: verify a signed nonce
    GET  /events               - recent on-chain events (decisions,
                                  challenges, bond reclaims, withdrawals),
                                  polled by the frontend's live activity feed
    GET  /positions/{id}/status - on-chain workflow state for one position
                                  (finalized? bonded? challengeable? challenged?)
    POST /positions/{id}/challenge-proof
                                - watcher service: a Tier-2 proof on the
                                  features the Tier 0/1 claim snapshotted, returned
                                  unsigned; the DApp user submits the
                                  challenge from their own wallet

On authentication / sessions / a database (see docs/SECURITY.md and the
frontend README for the fuller reasoning): this project deliberately has
no database. "Authentication" here is Sign-In-With-Ethereum (SIWE) - the
user's wallet signature over a server-issued nonce IS the credential, same
as real DApps (Uniswap, OpenSea, etc.) - and SIWE sessions are tracked in a
small in-memory dict, not persisted, because losing a session on server
restart just means signing in again, which is a fine trade-off at this
scale. Likewise, on-chain events (read live via /events) are TrustTier's
actual source of truth for "what happened" - mirroring that history into a
database would only be justified at a scale where querying the chain
directly becomes too slow, at which point the standard real-world answer
is an indexer (e.g. The Graph) rather than a hand-rolled database synced
from events - not something this project's scope calls for.
"""

import os
import secrets
import time
from typing import Literal, Optional

from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from evaluation.cost_model import GAS_BY_TIER, TIER2_PROVING_SECONDS
from risk_model.inference import RiskModel
from router.chain_client import ChainClient, DEFAULT_NETWORK, DEPLOYMENTS_DIR
from router.position_stream import generate_onchain_stream
from router.tiering import decide_tier_bps
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
# Synthetic-stream position IDs start at a time-based offset so restarts of
# this server against the same chain do not collide with earlier positions.
_next_stream_id = 1_000_000 + int(time.time()) % 1_000_000 * 100


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


class OpenPositionRequest(BaseModel):
    position_id: Optional[int] = Field(None, ge=0, le=2**64 - 1)  # default: a fresh ID
    market: int = Field(0, ge=0)
    ltv: float = Field(..., gt=0, le=1.5)
    account_age_days: int = Field(200, ge=0, le=5000)
    time_since_last_topup_days: int = Field(5, ge=0, le=5000)


class EvaluateRequest(BaseModel):
    position_id: int = Field(..., ge=0, le=2**64 - 1)
    # Demo only: claim this tier regardless of the policy. The chain still
    # refuses a tier too weak for the position's on-chain delta.
    force_tier: Optional[Literal["HEURISTIC", "COMMITMENT", "ZK_PROOF"]] = None


class PriceRequest(BaseModel):
    price: float = Field(..., gt=0)


def _next_id() -> int:
    global _next_stream_id
    _next_stream_id += 1
    return _next_stream_id


def _revert_reason(e: Exception) -> str:
    return getattr(e, "message", None) or str(e)


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


@app.get("/markets")
def markets():
    chain = get_processor().chain
    out = []
    for m in chain.markets:
        price = chain.feed(m["priceFeed"]).functions.latestRoundData().call()[1]
        vol = chain.feed(m["volatilityFeed"]).functions.latestRoundData().call()[1]
        out.append({**m, "price": price / 1e8, "volatility_pct": vol / 1e8})
    return {"markets": out, "position_source": chain.manifest.get("positionSource")}


@app.post("/positions/open")
def open_position(request: OpenPositionRequest):
    """Demo: open a MockLendingPool position with one unit of collateral."""
    processor = get_processor()
    chain = processor.chain
    if request.market >= len(chain.markets):
        raise HTTPException(status_code=400, detail=f"unknown market {request.market}")
    pid = request.position_id if request.position_id is not None else _next_id()
    try:
        chain.refresh_mock_feeds()
        chain.open_demo_position(pid, request.market, request.ltv, request.account_age_days,
                                 request.time_since_last_topup_days)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_revert_reason(e))
    return position_features(pid)


@app.get("/positions/{position_id}/features")
def position_features(position_id: int):
    """The engine's own view of a position - nothing here is supplied by the router."""
    processor = get_processor()
    try:
        processor.chain.refresh_mock_feeds()
        view = processor.chain.current_features(position_id)
    except Exception as e:
        raise HTTPException(status_code=404, detail=_revert_reason(e))
    label, probs = processor.risk_model.predict_q(view["q"])
    pos = view["position"]
    return {
        "position_id": position_id,
        "features_q": view["q"],
        "features": dict(zip(["ltv", "collateral_volatility_30d", "price_momentum_24h",
                              "time_since_last_topup_days", "account_age_days"],
                             _dequantize(view["q"]))),
        "delta_bps": view["delta_bps"],
        "allowed_tier": decide_tier_bps(view["delta_bps"]).tier.name,
        "past_round": view["past_round"],
        "collateral_usd": pos["collateral_usd"] / 1e8,
        "debt_usd": pos["debt_usd"] / 1e8,
        "liquidation_threshold_bps": pos["liquidation_threshold_bps"],
        "model_label": label,
        "model_p_high": round(probs[1], 4),
    }


def _dequantize(q):
    from risk_model.features import FEATURE_BOUNDS
    out = []
    for x, (lo, hi) in zip(q, FEATURE_BOUNDS):
        out.append(round(lo + x / 1024 * (hi - lo), 4))
    return out


@app.post("/positions/evaluate")
def evaluate_position(request: EvaluateRequest):
    processor = get_processor()
    try:
        result = processor.process(request.position_id, request.force_tier)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_revert_reason(e))
    return result.to_dict()


@app.post("/positions/{position_id}/challenge-proof")
def challenge_proof(position_id: int):
    """Build (but do not submit) a Tier-2 proof on the features the
    position's Tier 0/1 claim snapshotted. ~16 s against the real verifier."""
    processor = get_processor()
    try:
        return processor.challenge_proof(position_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/markets/{market}/price")
def set_price(market: int, request: PriceRequest):
    """Demo: push a new price to a mock feed (e.g. a 20% crash)."""
    chain = get_processor().chain
    if market >= len(chain.markets):
        raise HTTPException(status_code=400, detail=f"unknown market {market}")
    try:
        chain.set_market_price(market, int(round(request.price * 1e8)))
    except Exception as e:
        raise HTTPException(status_code=400, detail=_revert_reason(e))
    return markets()


@app.post("/simulate")
def simulate(n_positions: int = 12):
    global _next_stream_id
    processor = get_processor()
    chain = processor.chain
    chain.refresh_mock_feeds()
    specs = generate_onchain_stream(chain.markets, n_positions=n_positions, seed=_next_stream_id % 2**32,
                                    start_id=_next_stream_id + 1)
    _next_stream_id += n_positions + 1
    results = []
    for s in specs:
        chain.open_demo_position(s.position_id, s.market, s.ltv, s.age_days, s.topup_days)
        r = processor.process(s.position_id).to_dict()
        r["market"] = chain.markets[s.market]["name"]
        results.append(r)

    tier_counts = {}
    for r in results:
        tier_counts[r["tier"]] = tier_counts.get(r["tier"], 0) + 1
    return {"results": results, "tier_counts": tier_counts, "all_tiers_exercised": len(tier_counts) == 3}


# ---------------------------------------------------------------------------
# Deployment info - lets the frontend talk to the contract directly through
# the user's own wallet, rather than only through this backend's account.
# ---------------------------------------------------------------------------

@app.get("/deployment")
def deployment():
    import json

    manifest_path = os.path.join(DEPLOYMENTS_DIR, f"{DEFAULT_NETWORK}.json")
    if not os.path.exists(manifest_path):
        raise HTTPException(
            status_code=503,
            detail=f"No deployment manifest at {manifest_path}. Deploy contracts first.",
        )
    with open(manifest_path) as f:
        manifest = json.load(f)

    engine = manifest["contracts"]["LiquidationEngine"]
    return {
        "network": manifest["network"],
        "liquidationEngine": {"address": engine["address"], "abi": engine["abi"]},
    }


# ---------------------------------------------------------------------------
# Sign-In-With-Ethereum style authentication.
#
# Step 1 (GET /auth/nonce): server generates a one-time nonce tied to the
# claimed address, valid for a short window.
# Step 2 (POST /auth/verify): the frontend has the user's wallet sign a
# message containing that nonce; the server recovers the signer from the
# signature and checks it matches the claimed address. A matching signature
# IS the proof of wallet ownership - no password, no separate credential -
# exactly how real DApps (Uniswap, OpenSea, etc.) authenticate wallets.
#
# Sessions are an in-memory dict, deliberately not a database - see this
# file's module docstring for why. A server restart invalidates all
# sessions, which just means signing in again.
# ---------------------------------------------------------------------------

_NONCE_TTL_SECONDS = 300
_pending_nonces: dict[str, tuple[str, float]] = {}  # address -> (nonce, issued_at)
_sessions: dict[str, str] = {}  # session_token -> address


class NonceRequest(BaseModel):
    address: str


class VerifyRequest(BaseModel):
    address: str
    signature: str


def _siwe_message(address: str, nonce: str) -> str:
    return (
        f"Sign in to TrustTier.\n\n"
        f"Address: {address}\n"
        f"Nonce: {nonce}\n"
        f"This signature only proves wallet ownership and never authorizes "
        f"any transaction or spending."
    )


@app.get("/auth/nonce")
def auth_nonce(address: str):
    address = address.lower()
    nonce = secrets.token_hex(16)
    _pending_nonces[address] = (nonce, time.time())
    return {"message": _siwe_message(address, nonce)}


@app.post("/auth/verify")
def auth_verify(request: VerifyRequest):
    address = request.address.lower()
    entry = _pending_nonces.get(address)
    if entry is None:
        raise HTTPException(status_code=400, detail="No pending nonce for this address. Request one first.")

    nonce, issued_at = entry
    if time.time() - issued_at > _NONCE_TTL_SECONDS:
        del _pending_nonces[address]
        raise HTTPException(status_code=400, detail="Nonce expired. Request a new one.")

    message = _siwe_message(address, nonce)
    try:
        recovered = Account.recover_message(encode_defunct(text=message), signature=request.signature)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not recover signer: {e}")

    if recovered.lower() != address:
        raise HTTPException(status_code=401, detail="Signature does not match the claimed address.")

    del _pending_nonces[address]  # one-time use
    session_token = secrets.token_hex(24)
    _sessions[session_token] = address
    return {"session_token": session_token, "address": address}


# ---------------------------------------------------------------------------
# Live on-chain activity feed and per-position workflow status.
# ---------------------------------------------------------------------------

# Mirrors LiquidationEngine.Tier / TierAuditLog.Tier ordering.
_TIER_NAMES = {0: "Heuristic", 1: "Commitment", 2: "ZkProof"}


@app.get("/events")
def events(from_block: int = 0):
    """Recent on-chain activity (decisions + challenges + bond reclaims +
    withdrawals), for the frontend's live activity feed. Reads events
    directly from the chain - this endpoint holds no state of its own."""
    chain = get_processor().chain

    out = []
    for e in chain.audit_log.events.DecisionLogged.get_logs(fromBlock=from_block):
        args = e["args"]
        out.append(
            {
                "type": "DecisionLogged",
                "blockNumber": e["blockNumber"],
                "txHash": e["transactionHash"].hex(),
                "positionId": args["positionId"],
                "tier": _TIER_NAMES.get(args["tier"], str(args["tier"])),
                "timestamp": args["timestamp"],
            }
        )
    for e in chain.liquidation_engine.events.DecisionChallenged.get_logs(fromBlock=from_block):
        args = e["args"]
        out.append(
            {
                "type": "DecisionChallenged",
                "blockNumber": e["blockNumber"],
                "txHash": e["transactionHash"].hex(),
                "positionId": args["positionId"],
                "challenger": args["challenger"],
                "bond": str(args["bond"]),
            }
        )
    for e in chain.liquidation_engine.events.BondReclaimed.get_logs(fromBlock=from_block):
        args = e["args"]
        out.append(
            {
                "type": "BondReclaimed",
                "blockNumber": e["blockNumber"],
                "txHash": e["transactionHash"].hex(),
                "positionId": args["positionId"],
                "claimant": args["claimant"],
                "bond": str(args["bond"]),
            }
        )
    for e in chain.liquidation_engine.events.Withdrawn.get_logs(fromBlock=from_block):
        args = e["args"]
        out.append(
            {
                "type": "Withdrawn",
                "blockNumber": e["blockNumber"],
                "txHash": e["transactionHash"].hex(),
                "account": args["account"],
                "amount": str(args["amount"]),
            }
        )

    out.sort(key=lambda x: x["blockNumber"])
    return {"events": out, "latest_block": chain.w3.eth.block_number}


@app.get("/positions/{position_id}/status")
def position_status(position_id: int):
    """On-chain workflow state for one position - drives the frontend's
    tier-to-liquidation-boundary workflow stepper."""
    chain = get_processor().chain
    engine = chain.liquidation_engine

    finalized = engine.functions.positionFinalized(position_id).call()
    has_decision = chain.has_decision(position_id)
    tier = None
    model_hash = None
    if has_decision:
        record = chain.get_decision(position_id)
        tier = _TIER_NAMES.get(record[1], str(record[1]))
        model_hash = record[2].hex() if hasattr(record[2], "hex") else record[2]
        if model_hash and not str(model_hash).startswith("0x"):
            model_hash = "0x" + model_hash

    bond = engine.functions.bondOf(position_id).call()
    claimant = engine.functions.claimant(position_id).call()
    deadline = engine.functions.challengeDeadline(position_id).call()
    challenged = engine.functions.challenged(position_id).call()

    now = chain.w3.eth.get_block("latest")["timestamp"]
    challengeable = bond > 0 and not challenged and now <= deadline

    return {
        "position_id": position_id,
        "snapshot_features_q": chain.feature_snapshot(position_id),
        "tier2_model_hash": chain.tier2_model_hash(),
        "finalized": finalized,
        "tier": tier,
        "model_hash": model_hash,
        "bond_wei": str(bond),
        "claimant": claimant,
        "challenge_deadline": deadline,
        "seconds_until_deadline": max(0, deadline - now) if deadline else 0,
        "challenged": challenged,
        "challengeable": challengeable,
    }

