"""
One-time setup: registers the trained risk model's on-chain hash via
ModelRegistry, so LiquidationEngine will accept Tier 1/Tier 2 decisions
that reference it. Idempotent - safe to re-run (ChainClient.register_model
no-ops if the hash is already authorized).

Run from the off-chain/ directory, after contracts are deployed:
    python -m scripts.setup_chain
"""

from risk_model.inference import RiskModel
from router.chain_client import ChainClient


def main():
    risk_model = RiskModel()
    chain = ChainClient()

    print(f"Model hash: {risk_model.model_hash}")

    if chain.is_model_authorized(risk_model.model_hash):
        print("Model already registered and authorized on-chain. Nothing to do.")
        return

    receipt = chain.register_model(
        risk_model.model_hash, uri="local://risk_model/artifacts/risk_model.onnx"
    )
    print(f"Registered model on-chain. Tx: {receipt.transactionHash.hex()}, gas used: {receipt.gasUsed}")


if __name__ == "__main__":
    main()
