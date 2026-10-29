"""
The router's per-position pipeline. Both the FastAPI app (main.py) and the CLI
demo (scripts/run_synthetic_stream.py) call into this, so the two entry points
can never drift apart.

The router supplies NO position data. Per position it:
  1. Reads the engine's own view: q (five quantized features computed by the
     contract from the lending protocol and Chainlink feeds), delta in basis
     points, and the 24-hour-ago price round the call needs.
  2. Picks the weakest tier the chain will accept for that delta
     (decide_tier_bps mirrors the contract's thresholds), then:
     Tier 0: bonded claim; the contract snapshots q.
     Tier 1: bonded, salted keccak commitment to (q, score), opened on-chain
             right away (an unopened commitment forfeits its bond) - unless
             the model flags the position as high risk: a cheap "safe" claim
             would be false and slashable by any watcher, so the router
             escalates.
     Tier 2: a proof on q. Against the real verifier this is a genuine EZKL
             proof (~16 s); against the mock verifier (local demos) a
             placeholder with the same public-input layout. If a feed moves
             while proving, the router anchors the features on-chain and
             proves once more on the anchor, which stays valid for
             ANCHOR_TTL while the position does not get safer. If the model
             says the position is NOT high risk there is nothing to liquidate.
A router that lies about any of this gains nothing: the contract recomputes q
and delta itself, rejects a tier that is too weak, and rejects a proof made on
any other features.
"""

import os
from dataclasses import asdict, dataclass, field
from typing import Optional

from web3 import Web3

from risk_model.inference import RiskModel
from router.chain_client import ChainClient
from router.commitment import _to_fixed_point, compute_commitment_hash, new_salt
from router.prover import EzklProver
from router.tiering import Tier, TierDecision, decide_tier_bps

# "auto": real EZKL proofs when the deployed verifier is real, placeholders
# against the mock. "ezkl" forces real proofs; "mock" forces placeholders.
PROVER_MODE = os.environ.get("TRUSTTIER_PROVER", "auto").lower()
PROBABILITY_SCALE = 2 ** 10  # the circuit's output scale (settings.json model_output_scales)


@dataclass
class ProcessingResult:
    position_id: int
    ltv: float
    delta: float
    delta_bps: int
    features_q: list = field(default_factory=list)
    tier: str = ""
    tier_reason: str = ""
    outcome: str = "APPROVED"          # APPROVED | NOT_LIQUIDATED
    risk_score: Optional[float] = None
    model_hash: Optional[str] = None
    evidence_ref: Optional[str] = None
    tx_hash: Optional[str] = None
    gas_used: Optional[int] = None
    salt: Optional[str] = None         # Tier 1: keep to reveal the commitment later
    proof_kind: Optional[str] = None   # Tier 2: "ezkl" or "mock"
    proving_seconds: Optional[float] = None
    revealed: Optional[bool] = None    # Tier 1: commitment opened on-chain
    anchored: Optional[bool] = None    # Tier 2: proof made on anchored features

    def to_dict(self):
        return asdict(self)


class PositionProcessor:
    def __init__(self, chain_client: ChainClient, risk_model: RiskModel, prover: Optional[EzklProver] = None):
        self.chain = chain_client
        self.risk_model = risk_model
        self.prover = prover or EzklProver()

    def _use_real_prover(self) -> bool:
        if PROVER_MODE == "ezkl":
            return True
        if PROVER_MODE == "mock":
            return False
        return self.chain.verifier_mode == "real"

    def tier2_proof(self, q: list[int]):
        """(proof bytes, public inputs, proven label, kind, seconds) for features q."""
        if self._use_real_prover():
            p = self.prover.prove(q)
            return p.proof, p.public_inputs, p.label, "ezkl", p.seconds
        # Placeholder for the mock verifier, with the real circuit's layout:
        # [q_ltv, q_vol, q_mom, q_topup, q_age, label, P(low), P(high)].
        label, probs = self.risk_model.predict_q(q)
        public_inputs = list(q) + [label] + [int(round(p * PROBABILITY_SCALE)) for p in probs]
        proof = Web3.keccak(text=f"mock-proof:{q}")
        return proof, public_inputs, label, "mock", 0.0

    def challenge_proof(self, position_id: int) -> dict:
        """Watcher service: a Tier-2 proof on the features the position's
        Tier 0/1 claim snapshotted on-chain. The caller (e.g. a DApp user)
        submits challengeDecision with it from their own wallet if it shows
        high risk."""
        q = self.chain.feature_snapshot(position_id)
        if q is None:
            raise KeyError(f"no Tier 0/1 claim has been made on position {position_id}")
        proof, public_inputs, label, kind, seconds = self.tier2_proof(q)
        return {
            "position_id": position_id,
            "model_hash": self.chain.tier2_model_hash(),
            "proof": "0x" + bytes(proof).hex(),
            "public_inputs": [str(x) for x in public_inputs],
            "features_q": q,
            "label": label,
            "high_risk": label == 1,
            "proof_kind": kind,
            "proving_seconds": round(seconds, 2),
        }

    def process(self, position_id: int, force_tier: Optional[str] = None) -> ProcessingResult:
        """Route one position. `force_tier` (demo only) makes the router claim
        a different tier than the policy picks - the chain still refuses a
        tier too weak for the position's delta, and the challenge window
        punishes a cheap claim the model contradicts."""
        self.chain.refresh_mock_feeds()
        view = self.chain.current_features(position_id)
        q, delta_bps, past_round, pos = view["q"], view["delta_bps"], view["past_round"], view["position"]
        decision = decide_tier_bps(delta_bps)
        if force_tier is not None:
            decision = TierDecision(Tier[force_tier], decision.delta,
                                    f"forced to {force_tier} (demo; policy said {decision.tier.name})")

        result = ProcessingResult(
            position_id=position_id, ltv=pos["debt_usd"] / pos["collateral_usd"],
            delta=decision.delta, delta_bps=delta_bps, features_q=q,
            tier=decision.tier.name, tier_reason=decision.reason,
        )
        label, probs = self.risk_model.predict_q(q)

        if decision.tier == Tier.COMMITMENT and force_tier is None and label == 1:
            result.tier_reason = (f"{decision.reason}; escalated to ZK_PROOF because the model flags "
                                  "high risk (a cheap 'safe' claim would be false and slashable)")
            decision = TierDecision(Tier.ZK_PROOF, decision.delta, result.tier_reason)
            result.tier = Tier.ZK_PROOF.name

        if decision.tier == Tier.HEURISTIC:
            receipt = self.chain.decide_heuristic(position_id, past_round)

        elif decision.tier == Tier.COMMITMENT:
            result.risk_score = probs[1]
            result.model_hash = self.risk_model.model_hash
            salt = new_salt()
            result.salt = "0x" + salt.hex()
            result.evidence_ref = compute_commitment_hash(q, result.risk_score, salt)
            receipt = self.chain.decide_commitment(position_id, past_round, result.model_hash, result.evidence_ref)
            if force_tier is None:
                # An honest claimant opens at once; a forced (dishonest) demo
                # claim stays closed, to be slashed by a watcher instead.
                reveal = self.chain.reveal_commitment(position_id, q, _to_fixed_point(result.risk_score), salt)
                result.revealed = True
                result.gas_used = receipt.gasUsed + reveal.gasUsed
            else:
                result.revealed = False

        else:  # Tier.ZK_PROOF
            result.risk_score = probs[1]
            result.model_hash = self.risk_model.model_hash
            proof, public_inputs, proven_label, kind, seconds = self.tier2_proof(q)
            result.proof_kind, result.proving_seconds = kind, round(seconds, 2)
            if proven_label != 1:
                # A valid proof that the position is NOT high risk approves
                # nothing on-chain (the engine would revert), so submit nothing.
                result.outcome = "NOT_LIQUIDATED"
                return result
            extra_gas = 0
            if kind == "ezkl" and self.chain.current_features(position_id)["q"] != q:
                # A feed moved during proving: anchor, then prove on the anchor.
                q, anchor_receipt = self.chain.anchor_features(position_id, past_round)
                extra_gas = anchor_receipt.gasUsed
                proof, public_inputs, proven_label, kind, seconds2 = self.tier2_proof(q)
                result.features_q, result.anchored = q, True
                result.proving_seconds = round(seconds + seconds2, 2)
                if proven_label != 1:
                    result.outcome = "NOT_LIQUIDATED"
                    return result
            receipt = self.chain.decide_zk_proof(position_id, past_round, result.model_hash, proof, public_inputs)
            receipt_gas = receipt.gasUsed + extra_gas
            ev = Web3.keccak(proof).hex()
            result.evidence_ref = ev if ev.startswith("0x") else "0x" + ev

        tx = receipt.transactionHash.hex()
        result.tx_hash = tx if tx.startswith("0x") else "0x" + tx
        if result.gas_used is None:
            result.gas_used = receipt_gas if decision.tier == Tier.ZK_PROOF else receipt.gasUsed
        return result
