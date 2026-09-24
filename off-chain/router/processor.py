"""
Ties together delta computation, tier decision, risk-model inference, and
the corresponding on-chain call into a single per-position pipeline. This
is the piece both the FastAPI app (main.py) and the CLI demo script
(scripts/run_synthetic_stream.py) call into, so the two entry points can
never drift out of sync on what "processing a position" actually means.
"""

import os
from dataclasses import dataclass, asdict
from typing import Optional

from web3 import Web3

from risk_model.inference import RiskModel
from router.chain_client import ChainClient
from router.commitment import compute_commitment_hash
from router.delta import compute_delta
from router.tiering import decide_tier, Tier

LIQUIDATION_THRESHOLD_DEFAULT = float(os.environ.get("TRUSTTIER_LIQUIDATION_THRESHOLD", "0.80"))


@dataclass
class ProcessingResult:
    position_id: int
    ltv: float
    delta: float
    tier: str
    tier_reason: str
    risk_score: Optional[float]
    model_hash: Optional[str]
    evidence_ref: Optional[str]
    tx_hash: Optional[str]
    gas_used: Optional[int]

    def to_dict(self):
        return asdict(self)


class PositionProcessor:
    def __init__(self, chain_client: ChainClient, risk_model: RiskModel,
                 liquidation_threshold: float = LIQUIDATION_THRESHOLD_DEFAULT):
        self.chain = chain_client
        self.risk_model = risk_model
        self.liquidation_threshold = liquidation_threshold

    def process(self, position_id: int, features: dict) -> ProcessingResult:
        delta_result = compute_delta(features["ltv"], self.liquidation_threshold)
        tier_decision = decide_tier(delta_result)

        risk_score = None
        model_hash = None
        evidence_ref = None
        tx_hash = None
        gas_used = None

        if tier_decision.tier == Tier.HEURISTIC:
            receipt = self.chain.decide_heuristic(position_id)
            tx_hash = receipt.transactionHash.hex()
            gas_used = receipt.gasUsed

        elif tier_decision.tier == Tier.COMMITMENT:
            risk_score = self.risk_model.predict_risk_score(features)
            model_hash = self.risk_model.model_hash
            evidence_ref = compute_commitment_hash(features, risk_score)
            receipt = self.chain.decide_commitment(position_id, model_hash, evidence_ref)
            tx_hash = receipt.transactionHash.hex()
            gas_used = receipt.gasUsed

        elif tier_decision.tier == Tier.ZK_PROOF:
            risk_score = self.risk_model.predict_risk_score(features)
            model_hash = self.risk_model.model_hash
            # No real EZKL proof exists yet (that's Weeks 3-5). This
            # placeholder is opaque bytes MockTier2Verifier accepts by
            # default - see contracts/mocks/MockTier2Verifier.sol. Once the
            # real EZKL verifier is wired in (LiquidationEngine.setTier2Verifier),
            # this line is the only thing that needs to change: proof
            # becomes the actual EZKL-generated proof bytes.
            commitment = compute_commitment_hash(features, risk_score)
            proof = Web3.to_bytes(hexstr=commitment)  # placeholder "proof"
            public_inputs = [int(round(risk_score * 1_000_000))]
            receipt = self.chain.decide_zk_proof(position_id, model_hash, proof, public_inputs)
            tx_hash = receipt.transactionHash.hex()
            gas_used = receipt.gasUsed
            evidence_ref = Web3.keccak(proof).hex()

        return ProcessingResult(
            position_id=position_id,
            ltv=features["ltv"],
            delta=tier_decision.delta,
            tier=tier_decision.tier.name,
            tier_reason=tier_decision.reason,
            risk_score=risk_score,
            model_hash=model_hash,
            evidence_ref=evidence_ref,
            tx_hash=tx_hash,
            gas_used=gas_used,
        )
