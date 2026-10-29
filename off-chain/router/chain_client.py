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

MOMENTUM_WINDOW = 24 * 60 * 60  # LiquidationEngine.MOMENTUM_WINDOW

DEFAULT_RPC_URL = os.environ.get("TRUSTTIER_RPC_URL", "http://127.0.0.1:8545")
DEFAULT_NETWORK = os.environ.get("TRUSTTIER_NETWORK", "localhost")
DEFAULT_PRIVATE_KEY = os.environ.get("TRUSTTIER_PRIVATE_KEY")

# Chain IDs of local development chains (Hardhat, Anvil/Ganache) - the only
# chains on which the public Hardhat test key may be used.
LOCAL_CHAIN_IDS = {31337, 1337}

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
        private_key: str = DEFAULT_PRIVATE_KEY,
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

        self.manifest = manifest
        self.chain_id = self.w3.eth.chain_id
        if not private_key:
            # The default key is publicly known: anyone could drain or
            # impersonate an account using it. Refuse it outside local chains.
            if self.chain_id not in LOCAL_CHAIN_IDS:
                raise ValueError(
                    f"Chain {self.chain_id} is not a local dev chain: set TRUSTTIER_PRIVATE_KEY "
                    "(the public Hardhat test key is only allowed on local chains)."
                )
            private_key = HARDHAT_DEFAULT_PRIVATE_KEY
        self.account = self.w3.eth.account.from_key(private_key)

        self.model_registry = self._load_contract(manifest, "ModelRegistry")
        self.audit_log = self._load_contract(manifest, "TierAuditLog")
        self.liquidation_engine = self._load_contract(manifest, "LiquidationEngine")
        # Generic key regardless of whether the deployed verifier is the
        # mock (local dev) or the real EZKL-generated Halo2Verifier.
        self.tier2_verifier = self._load_contract(manifest, "Tier2Verifier")
        # Where the engine reads positions from: MockLendingPool (demo) or
        # the Aave V3 adapter. The engine's own pointer is authoritative.
        self.position_source = self._load_contract(manifest, "PositionSource")
        self.lending_pool = (self._load_contract(manifest, "MockLendingPool")
                             if "MockLendingPool" in manifest["contracts"] else None)
        # The consumer that executes Tier-2 approvals (demo pool deployments).
        self.liquidator = (self._load_contract(manifest, "TrustTierLiquidator")
                           if "TrustTierLiquidator" in manifest["contracts"] else None)
        self._aggregator_abi = manifest["aggregatorAbi"]
        self.markets = manifest.get("markets", [])

    def _load_contract(self, manifest: dict, name: str):
        entry = manifest["contracts"][name]
        return self.w3.eth.contract(address=entry["address"], abi=entry["abi"])

    def _send(self, function_call, value: int = 0, gas: int | None = None):
        """Build, sign, and send a transaction from self.account; wait for the
        receipt. `gas` skips estimation (needed when a call is only valid in
        a later block than the one estimation simulates, e.g. revealChallenge)."""
        params = {
            "from": self.account.address,
            "nonce": self.w3.eth.get_transaction_count(self.account.address),
            "value": value,
        }
        if gas is not None:
            params["gas"] = gas
        tx = function_call.build_transaction(params)
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

    def min_bond(self) -> int:
        return self.liquidation_engine.functions.MIN_BOND().call()

    def required_bond(self) -> int:
        """Bond a Tier 0/1 claim needs now: max(MIN_BOND, BOND_GAS_COVER * basefee).
        Evaluated on the pending block, with 25% headroom for a base-fee rise
        before inclusion (any excess is returned with the bond)."""
        base = self.liquidation_engine.functions.requiredBond().call(block_identifier="pending")
        return base if base == self.min_bond() else base * 5 // 4

    def protocol_state(self) -> dict:
        e = self.liquidation_engine.functions
        latest = self.w3.eth.get_block("latest")
        return {
            "required_bond_wei": e.requiredBond().call(),
            "min_bond_wei": e.MIN_BOND().call(),
            "bond_gas_cover": e.BOND_GAS_COVER().call(),
            "base_fee_wei": latest.get("baseFeePerGas", 0),
            "reward_pool_wei": e.rewardPool().call(),
            "claim_reward_wei": e.claimReward().call(),
            "challenge_window_s": e.CHALLENGE_WINDOW().call(),
            "approval_ttl_s": e.APPROVAL_TTL().call(),
            "anchor_ttl_s": e.ANCHOR_TTL().call(),
            "liquidator": e.liquidator().call(),
            "block_number": latest["number"],
            "block_time": latest["timestamp"],
            "chain_id": self.chain_id,
        }

    @property
    def verifier_mode(self) -> str:
        """"mock" or "real", as recorded by scripts/deploy.js."""
        return self.manifest.get("verifierMode", "mock")

    def tier2_model_hash(self) -> str:
        return "0x" + self.liquidation_engine.functions.tier2ModelHash().call().hex().removeprefix("0x")

    def max_feed_ages(self) -> tuple[int, int]:
        e = self.liquidation_engine.functions
        return e.maxPriceAge().call(), e.maxVolatilityAge().call()

    # ---- On-chain features (read, never supplied) ----

    def feed(self, address: str):
        return self.w3.eth.contract(address=Web3.to_checksum_address(address), abi=self._aggregator_abi)

    def block_time(self) -> int:
        return self.w3.eth.get_block("latest")["timestamp"]

    def get_position(self, position_id: int) -> dict:
        p = self.position_source.functions.getPosition(position_id).call()
        keys = ["collateral_usd", "debt_usd", "liquidation_threshold_bps", "opened_at", "last_topup_at",
                "price_feed", "volatility_feed"]
        return dict(zip(keys, p))

    def find_past_round(self, feed_address: str, now: int | None = None) -> int:
        """The round of `feed_address` that was in effect MOMENTUM_WINDOW ago:
        the last round updated at or before now - 24 h. Exponential walk back
        from the latest round, then binary search (round timestamps are
        monotonic). The engine re-checks the answer, so a wrong round can
        only make the transaction revert, never mis-price it.

        Chainlink round IDs are (phaseId << 64) | aggregatorRoundId; the
        search stays inside the current phase."""
        f = self.feed(feed_address).functions
        target = (now if now is not None else self.block_time()) - MOMENTUM_WINDOW
        latest_id, _, _, latest_at, _ = f.latestRoundData().call()

        def updated_at(rid: int) -> int:
            try:
                return f.getRoundData(rid).call()[3]
            except Exception:
                return 0  # no such round

        if latest_at <= target:
            return latest_id
        phase_base = (latest_id >> 64) << 64
        hi, step = latest_id, 1          # hi: a round known to be too new
        lo = latest_id - step
        while True:
            if lo <= phase_base:
                lo = phase_base + 1
                if updated_at(lo) == 0 or updated_at(lo) > target:
                    raise LookupError(f"feed {feed_address} has no round older than 24 h")
                break
            t = updated_at(lo)
            if 0 < t <= target:
                break
            hi, step = lo, step * 2
            lo = latest_id - step
        while hi - lo > 1:               # invariant: updated_at(lo) <= target < updated_at(hi)
            mid = (lo + hi) // 2
            t = updated_at(mid)
            if 0 < t <= target:
                lo = mid
            else:
                hi = mid
        return lo

    def current_features(self, position_id: int) -> dict:
        """The engine's own view of a position: q, delta and the momentum
        round to pass to decide*."""
        pos = self.get_position(position_id)
        # The 24-hour round only changes when a feed updates or time passes:
        # cache it per (feed, latest round, block time) for list views.
        key = (pos["price_feed"], self.feed(pos["price_feed"]).functions.latestRoundData().call()[0], self.block_time())
        cache = self.__dict__.setdefault("_past_round_cache", {})
        if key not in cache:
            cache.clear() if len(cache) > 64 else None
            cache[key] = self.find_past_round(pos["price_feed"])
        past_round = cache[key]
        q, delta_bps = self.liquidation_engine.functions.currentFeatures(position_id, past_round).call()
        return {"q": [int(x) for x in q], "delta_bps": int(delta_bps), "past_round": past_round,
                "position": pos}

    def feature_snapshot(self, position_id: int) -> list[int] | None:
        """q recorded by the latest Tier 0/1 claim on the position (from the
        FeaturesSnapshotted event), i.e. what a challenge proof must use."""
        logs = self.liquidation_engine.events.FeaturesSnapshotted.get_logs(
            fromBlock=0, argument_filters={"positionId": position_id})
        if not logs:
            return None
        return [int(x) for x in logs[-1]["args"]["features"]]

    # ---- Demo helpers (MockLendingPool and mock feeds only) ----

    def refresh_mock_feeds(self) -> int:
        """Local demos: re-post the latest answer of any mock feed older than
        half its allowed age, so the engine's staleness check passes. Returns
        the number of feeds refreshed. Never touches real Chainlink feeds."""
        max_price_age, max_vol_age = self.max_feed_ages()
        now = self.block_time()
        refreshed = 0
        for m in self.markets:
            feeds = []
            if m.get("mockPriceFeed"):
                feeds.append((m["priceFeed"], max_price_age))
            if m.get("mockVolatilityFeed"):
                feeds.append((m["volatilityFeed"], max_vol_age))
            for addr, max_age in feeds:
                f = self.feed(addr).functions
                _, answer, _, updated, _ = f.latestRoundData().call()
                if now - updated > max_age // 2:
                    self._send(f.updateAnswer(answer))
                    refreshed += 1
        return refreshed

    def _require_pool(self):
        if self.lending_pool is None:
            raise RuntimeError("this deployment reads a real lending protocol; demo positions need MockLendingPool")

    def open_demo_position(self, position_id: int, market: int, ltv: float,
                           age_days: int = 200, topup_days: int = 5):
        """Open a MockLendingPool position with one unit of collateral at the
        given LTV and back-dated history (demo only)."""
        self._require_pool()
        m = self.markets[market]
        price = self.feed(m["priceFeed"]).functions.latestRoundData().call()[1]
        debt = price * round(ltv * 10_000) // 10_000
        self._send(self.lending_pool.functions.openPosition(position_id, market, 10**18, debt))
        now = self.block_time()
        return self._send(self.lending_pool.functions.setTimestamps(
            position_id, now - age_days * 86_400 - 60, now - topup_days * 86_400 - 60))

    def add_collateral(self, position_id: int, amount_wei: int):
        self._require_pool()
        return self._send(self.lending_pool.functions.addCollateral(position_id, amount_wei))

    def set_market_price(self, market: int, price: int):
        """Push a new mock price (8 decimals), e.g. to stage a crash."""
        m = self.markets[market]
        if not m.get("mockPriceFeed"):
            raise RuntimeError("real price feeds cannot be moved")
        return self._send(self.feed(m["priceFeed"]).functions.updateAnswer(price))

    def advance_time(self, seconds: int) -> int:
        """Local demo chains only: move block time forward (e.g. past a
        challenge window) and mine a block. Returns the new block time."""
        if self.chain_id not in LOCAL_CHAIN_IDS:
            raise RuntimeError("time travel is only available on a local dev chain")
        self.w3.provider.make_request("evm_increaseTime", [int(seconds)])
        self.w3.provider.make_request("evm_mine", [])
        return self.block_time()

    def demo_position_ids(self) -> list[int]:
        """Every position opened in the demo pool (from PositionOpened logs)."""
        if self.lending_pool is None:
            return []
        logs = self.lending_pool.events.PositionOpened.get_logs(fromBlock=0)
        return [int(e["args"]["positionId"]) for e in logs]

    # ---- Decisions ----

    def decide_heuristic(self, position_id: int, past_round: int, bond: int = None):
        """Tier 0: allowed by the chain only if delta > 15%; bonded."""
        return self._send(
            self.liquidation_engine.functions.decideHeuristic(position_id, past_round),
            value=bond if bond is not None else self.required_bond(),
        )

    def decide_commitment(self, position_id: int, past_round: int, model_hash: str, commitment_hash: str,
                          bond: int = None):
        """Tier 1: allowed by the chain only if delta > 5%; bonded."""
        return self._send(
            self.liquidation_engine.functions.decideCommitment(position_id, past_round, model_hash, commitment_hash),
            value=bond if bond is not None else self.required_bond(),
        )

    def reveal_commitment(self, position_id: int, q: list[int], score_fixed: int, salt: bytes):
        """Open a Tier-1 commitment (must happen inside the challenge window,
        or the bond is forfeited)."""
        return self._send(
            self.liquidation_engine.functions.revealCommitment(position_id, [int(x) for x in q], score_fixed, salt)
        )

    def anchor_features(self, position_id: int, past_round: int) -> tuple[list[int], object]:
        """Fix the position's features for ANCHOR_TTL; returns (q, receipt)."""
        receipt = self._send(self.liquidation_engine.functions.anchorFeatures(position_id, past_round))
        ev = self.liquidation_engine.events.FeaturesAnchored().process_receipt(receipt)[0]
        return [int(x) for x in ev["args"]["features"]], receipt

    def commit_and_reveal_challenge(self, position_id: int, model_hash: str, proof: bytes, public_inputs: list):
        """Front-running-proof challenge: commit to keccak(proof) bound to this
        account and the claim's snapshot, then reveal in a later block."""
        from eth_abi import encode
        snapshot = self.liquidation_engine.functions.featureSnapshot(position_id).call()
        commitment = Web3.keccak(encode(["address", "uint256", "bytes32", "bytes32"],
                                        [self.account.address, position_id, snapshot, Web3.keccak(proof)]))
        c = self._send(self.liquidation_engine.functions.commitChallenge(position_id, commitment))
        r = self._send(self.liquidation_engine.functions.revealChallenge(position_id, model_hash, proof, public_inputs),
                       gas=2_000_000)
        if r.status != 1:
            raise RuntimeError("revealChallenge reverted")
        return c, r

    def liquidate(self, position_id: int):
        """Execute an open Tier-2 approval through TrustTierLiquidator."""
        if self.liquidator is None:
            raise RuntimeError("this deployment has no TrustTierLiquidator")
        return self._send(self.liquidator.functions.liquidate(position_id))

    def decide_zk_proof(self, position_id: int, past_round: int, model_hash: str, proof: bytes,
                        public_inputs: list):
        """Tier 2: the proof's first five public inputs must equal the
        features the engine computes in the same transaction."""
        return self._send(
            self.liquidation_engine.functions.decideZkProof(position_id, past_round, model_hash, proof, public_inputs)
        )

    def challenge_decision(self, position_id: int, model_hash: str, proof: bytes, public_inputs: list):
        """Submit a real Tier-2 proof to challenge (and, if it contradicts
        the original claim, slash) a Tier 0/1 decision's bond."""
        return self._send(
            self.liquidation_engine.functions.challengeDecision(
                position_id, model_hash, proof, public_inputs
            )
        )

    def reclaim_bond(self, position_id: int):
        """Reclaim an unchallenged Tier 0/1 bond once the challenge window has closed."""
        return self._send(self.liquidation_engine.functions.reclaimBond(position_id))

    def withdraw(self):
        """Pull-payment withdrawal of any pending balance owed to self.account."""
        return self._send(self.liquidation_engine.functions.withdraw())

    def pending_withdrawal(self, address: str) -> int:
        return self.liquidation_engine.functions.pendingWithdrawals(address).call()

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
