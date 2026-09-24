"""
Thin web3.py wrapper around the deployed TrustTier contracts.

Reads contract addresses and ABIs from the deployment manifest that
scripts/deploy.js writes (../deployments/<network>.json), so this module
never hardcodes an address or duplicates an ABI by hand - if contracts are
redeployed, only the manifest changes, not this code.

For local development, the manifest is deployments/localhost.json, written
by running:
    npx hardhat node                                    (in one terminal)
    npx hardhat run scripts/deploy.js --network localhost   (in another)
"""

import json
import os

from web3 import Web3

DEFAULT_RPC_URL = os.environ.get("TRUSTTIER_RPC_URL", "http://127.0.0.1:8545")
DEFAULT_NETWORK = os.environ.get("TRUSTTIER_NETWORK", "localhost")

# Hardhat's well-known default account #0 private key. Safe to hardcode as
# a *default* only because it is a publicly documented test-only key with
# no value on any real network - never used for Sepolia or mainnet.
HARDHAT_DEFAULT_PRIVATE_KEY = (
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
)

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEPLOYMENTS_DIR = os.path.join(REPO_ROOT, "deployments")


class ChainClient:
    def __init__(
        self,
        rpc_url: str = DEFAULT_RPC_URL,
        network: str = DEFAULT_NETWORK,
        private_key: str = None,
    ):
        self.w3 = Web3(Web3.HTTPProvider(rpc_url))

        if not self.w3.is_connected():
            raise ConnectionError(
                f"Could not connect to a chain at {rpc_url}. "
                f"Is `npx hardhat node` running?"
            )

        manifest_path = os.path.join(DEPLOYMENTS_DIR, f"{network}.json")
        if not os.path.exists(manifest_path):
            raise FileNotFoundError(
                f"No deployment manifest at {manifest_path}. "
                f"Run `npx hardhat run scripts/deploy.js --network {network}` first."
            )
        with open(manifest_path) as f:
            manifest = json.load(f)

        self.account = self.w3.eth.account.from_key(private_key or HARDHAT_DEFAULT_PRIVATE_KEY)

        self.model_registry = self._load_contract(manifest, "ModelRegistry")
        self.audit_log = self._load_contract(manifest, "TierAuditLog")
        self.liquidation_engine = self._load_contract(manifest, "LiquidationEngine")
        # Generic key regardless of whether the deployed verifier is the
        # mock (local dev) or the real EZKL-generated Halo2Verifier
        # (sepolia) - see scripts/deploy.js's writeDeploymentManifest call.
        self.tier2_verifier = self._load_contract(manifest, "Tier2Verifier")

    def _load_contract(self, manifest: dict, name: str):
        entry = manifest["contracts"][name]
        return self.w3.eth.contract(address=entry["address"], abi=entry["abi"])

    def _send(self, function_call):
        """Build, sign, and send a transaction from self.account; wait for the receipt."""
        tx = function_call.build_transaction(
            {
                "from": self.account.address,
                "nonce": self.w3.eth.get_transaction_count(self.account.address),
            }
        )
        signed = self.w3.eth.account.sign_transaction(tx, private_key=self.account.key)
        raw_tx = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        tx_hash = self.w3.eth.send_raw_transaction(raw_tx)
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash)
        return receipt

    # ---- ModelRegistry ----

    def is_model_authorized(self, model_hash: str) -> bool:
        return self.model_registry.functions.isAuthorized(model_hash).call()

    def register_model(self, model_hash: str, uri: str = ""):
        if self.is_model_authorized(model_hash):
            return None  # already registered; no-op, keeps setup scripts idempotent
        return self._send(self.model_registry.functions.registerModel(model_hash, uri))

    # ---- LiquidationEngine ----

    def decide_heuristic(self, position_id: int):
        return self._send(self.liquidation_engine.functions.decideHeuristic(position_id))

    def decide_commitment(self, position_id: int, model_hash: str, commitment_hash: str):
        return self._send(
            self.liquidation_engine.functions.decideCommitment(
                position_id, model_hash, commitment_hash
            )
        )

    def decide_zk_proof(self, position_id: int, model_hash: str, proof: bytes, public_inputs: list):
        return self._send(
            self.liquidation_engine.functions.decideZkProof(
                position_id, model_hash, proof, public_inputs
            )
        )

    # ---- TierAuditLog (read-only helpers, useful for the demo/report) ----
    #
    # No on-chain decisionCount()/decisions(i) exists anymore - see the
    # concurrency design note in TierAuditLog.sol: a shared counter or
    # array would reintroduce exactly the false-conflict problem that was
    # removed. Query a specific position directly, or use
    # get_decisions_via_events() to reconstruct history off-chain from logs.

    def has_decision(self, position_id: int) -> bool:
        return self.audit_log.functions.hasDecision(position_id).call()

    def get_decision(self, position_id: int):
        return self.audit_log.functions.decisionByPosition(position_id).call()

    def get_decisions_via_events(self, from_block: int = 0, to_block="latest") -> list:
        """
        Reconstructs decision history by querying the DecisionLogged event
        log, rather than any on-chain counter/array. This is the
        off-chain-aggregation approach TierAuditLog's docstring recommends -
        the whole point of removing the on-chain array was to eliminate a
        shared write that serialized every transaction regardless of which
        position it touched; event logs carry no such cost since they are
        not contract storage.
        """
        events = self.audit_log.events.DecisionLogged.get_logs(fromBlock=from_block, toBlock=to_block)
        return [dict(e["args"]) for e in events]
