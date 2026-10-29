// In-browser simulation of the TrustTier protocol, for the hosted demo.
//
// A faithful port of LiquidationEngine's rules - on-chain features and their
// quantization, tier bands, gas-scaled bonds, the challenge window, Tier-1
// reveals, commit-reveal challenges, Tier-2 approvals with a TTL, and soft
// liquidation through the liquidator - over a simulated clock and lending
// pool. Gas figures are the MEASURED ones (off-chain/evaluation/results/
// gas_measurements.json). What it does not do: run an EVM or generate real
// zk proofs (the "proof" is the model's output, labelled as simulated). Every
// method returns the same shape as the live router API (off-chain/main.py),
// so the UI cannot tell the difference except through `mode`.
import GAS from "../../../off-chain/evaluation/results/gas_measurements.json";
import { MODEL_HASH, predict } from "./model";

const DAY = 86_400;
const H = 3_600;
const T0_MIN = 1500;
const T1_MIN = 500;
const MIN_BOND = 10n ** 16n; // 0.01 ETH
const BOND_GAS_COVER = 1_500_000n;
const CHALLENGE_WINDOW = H;
const APPROVAL_TTL = 30 * 60;
const ANCHOR_TTL = 10 * 60;
const REWARD_COOLDOWN = DAY;
const CLOSE_FACTOR = 0.5;
const BONUS = 0.05;
const ROUTER = "0xRouter00000000000000000000000000000000";
const WATCHER = "0xWatcher0000000000000000000000000000000";
const KEEPER = "0xKeeper00000000000000000000000000000000";
const STORE_KEY = "trusttier.sim.v1";
const TIER_NAMES = ["Heuristic", "Commitment", "ZkProof"];
const POLICY = { HEURISTIC: 0, COMMITMENT: 1, ZK_PROOF: 2 };

const MARKETS = [
  { name: "ETH", price: 2000, past: 2200, vol: 35, thresholdBps: 8000 },
  { name: "WBTC", price: 60000, past: 59000, vol: 20, thresholdBps: 7500 },
  { name: "LINK", price: 15, past: 14, vol: 60, thresholdBps: 7000 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => "0x" + Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");

function fresh() {
  const t0 = 1_767_225_600; // simulated chain clock
  return {
    time: t0,
    block: 1,
    baseFeeGwei: 8,
    nextId: 1000,
    markets: MARKETS.map((m, i) => ({
      id: i, name: m.name, thresholdBps: m.thresholdBps, vol: m.vol,
      rounds: [{ t: t0 - 25 * H, price: m.past }, { t: t0, price: m.price }],
      mockPriceFeed: true, mockVolatilityFeed: true,
    })),
    positions: {},
    state: {},
    commitments: {},
    anchors: {},
    pending: {},
    rewardPool: 10n ** 18n,
    claimReward: 2n * 10n ** 15n,
    events: [],
  };
}

function serialize(s) {
  return JSON.stringify(s, (_, v) => (typeof v === "bigint" ? { $big: v.toString() } : v));
}

function deserialize(text) {
  return JSON.parse(text, (_, v) => (v && typeof v === "object" && "$big" in v ? BigInt(v.$big) : v));
}

export class SimEngine {
  constructor() {
    this.mode = "sim";
    this.s = null;
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (saved) this.s = deserialize(saved);
    } catch {
      this.s = null;
    }
    if (!this.s) this.s = fresh();
  }

  _save() {
    try {
      localStorage.setItem(STORE_KEY, serialize(this.s));
    } catch {
      /* storage unavailable: the session still works in memory */
    }
  }

  reset() {
    this.s = fresh();
    this._save();
  }

  // ---- chain primitives -------------------------------------------------

  _tick(seconds = 12) {
    this.s.time += seconds;
    this.s.block += Math.max(1, Math.round(seconds / 12));
  }

  _emit(type, fields) {
    this.s.events.push({ type, blockNumber: this.s.block, txHash: hex(64), timestamp: this.s.time, ...fields });
  }

  _price(m, at = this.s.time) {
    let p = m.rounds[0].price;
    for (const r of m.rounds) if (r.t <= at) p = r.price;
    return p;
  }

  _requiredBond() {
    const fee = BigInt(Math.round(this.s.baseFeeGwei * 1e9));
    const g = BOND_GAS_COVER * fee;
    return g > MIN_BOND ? g : MIN_BOND;
  }

  _st(id) {
    if (!this.s.state[id]) {
      this.s.state[id] = {
        claimant: null, bond: 0n, challengeDeadline: 0, approvedAt: 0, lastRewardAt: 0,
        decided: false, liquidationFinal: false, challenged: false, isCommitment: false, revealed: false,
        snapshot: null, tier: null, modelHash: null, commitCount: 0, lastCommitAt: 0,
      };
    }
    return this.s.state[id];
  }

  /** LiquidationEngine.currentFeatures, in integer arithmetic. */
  _features(id) {
    const p = this.s.positions[id];
    if (!p) throw new Error(`unknown position ${id}`);
    const m = this.s.markets[p.market];
    const price = this._price(m);
    const collateralUsd = p.collateral * price;
    const ltv = p.debt / collateralUsd;
    const q = [
      Math.min(Math.floor((ltv * 2048) / 3), 1024),
      Math.min(Math.floor((m.vol * 1024) / 100), 1024),
      Math.min(Math.floor((price * 512) / this._price(m, this.s.time - DAY)), 1024),
      Math.floor((Math.min(Math.floor((this.s.time - p.lastTopUpAt) / DAY), 90) * 1024) / 90),
      Math.floor((Math.min(Math.floor((this.s.time - p.openedAt) / DAY), 2000) * 1024) / 2000),
    ];
    const deltaBps = m.thresholdBps - Math.floor((p.debt * 10_000) / collateralUsd);
    return { q, deltaBps, collateralUsd, ltv, market: m };
  }

  _beginDecision(id, tier2) {
    const st = this._st(id);
    if (st.liquidationFinal) {
      if (this.s.time <= st.approvedAt + APPROVAL_TTL) throw new Error("PositionAlreadyFinalized: a Tier-2 approval is open");
      st.liquidationFinal = false;
      st.approvedAt = 0;
      this._emit("ApprovalExpired", { positionId: id });
    }
    if (st.decided) {
      if (this.s.time <= st.challengeDeadline) {
        if (!tier2) throw new Error("PositionAlreadyFinalized: a claim's challenge window is open");
        this._emit("ClaimSuperseded", { positionId: id, claimant: st.claimant });
        return;
      }
      this._settle(id, st);
      this._emit("PositionReopened", { positionId: id });
    }
    st.decided = true;
  }

  _settle(id, st) {
    if (st.bond === 0n) return 0n;
    const bond = st.bond;
    st.bond = 0n;
    if (st.isCommitment && !st.revealed) {
      this.s.rewardPool += bond;
      this._emit("BondForfeited", { positionId: id, claimant: st.claimant, bond: bond.toString() });
      return 0n;
    }
    let credited = bond;
    const r = this.s.claimReward;
    if (r > 0n && this.s.rewardPool >= r && this.s.time >= st.lastRewardAt + REWARD_COOLDOWN) {
      this.s.rewardPool -= r;
      st.lastRewardAt = this.s.time;
      credited += r;
      this._emit("RewardPaid", { positionId: id, claimant: st.claimant, amount: r.toString() });
    }
    this.s.pending[st.claimant] = (this.s.pending[st.claimant] || 0n) + credited;
    this._emit("BondReclaimed", { positionId: id, claimant: st.claimant, bond: bond.toString() });
    return credited;
  }

  _openClaim(id, q, deltaBps, commitment) {
    const st = this._st(id);
    st.claimant = ROUTER;
    st.bond = this._requiredBond();
    st.challengeDeadline = this.s.time + CHALLENGE_WINDOW;
    st.challenged = false;
    st.isCommitment = commitment;
    st.revealed = false;
    st.snapshot = q.slice();
    this._emit("FeaturesSnapshotted", { positionId: id, features: q, deltaBps });
  }

  // ---- views (live API shapes) -------------------------------------------

  async health() {
    return { status: "ok", mode: "sim" };
  }

  async costModel() {
    return {
      gas_by_tier: {
        HEURISTIC: GAS.decideHeuristic,
        COMMITMENT: GAS.decideCommitment + GAS.revealCommitment,
        ZK_PROOF: GAS.decideZkProof,
      },
      tier2_proving_seconds: 16.1,
    };
  }

  async overview() {
    const e = this.s;
    return {
      protocol: {
        required_bond_wei: this._requiredBond().toString(), min_bond_wei: MIN_BOND.toString(),
        bond_gas_cover: Number(BOND_GAS_COVER), base_fee_wei: String(Math.round(e.baseFeeGwei * 1e9)),
        reward_pool_wei: e.rewardPool.toString(), claim_reward_wei: e.claimReward.toString(),
        challenge_window_s: CHALLENGE_WINDOW, approval_ttl_s: APPROVAL_TTL, anchor_ttl_s: ANCHOR_TTL,
        liquidator: KEEPER, block_number: e.block, block_time: e.time, chain_id: 0,
      },
      positions: Object.keys(e.positions).length,
      verifier_mode: "simulated",
      model_hash: MODEL_HASH,
      network: "in-browser simulation",
    };
  }

  async markets() {
    return {
      markets: this.s.markets.map((m) => ({
        id: m.id, name: m.name, thresholdBps: m.thresholdBps, price: this._price(m), volatility_pct: m.vol,
        price_24h_ago: this._price(m, this.s.time - DAY),
        history: m.rounds.slice(-24).map((r) => ({ t: r.t, price: r.price })),
        mockPriceFeed: true, mockVolatilityFeed: true,
      })),
      position_source: "MockLendingPool (simulated)",
    };
  }

  async getPosition(id) {
    id = Number(id);
    const f = this._features(id);
    const p = this.s.positions[id];
    const st = this._st(id);
    const { label, probs } = predict(f.q);
    const now = this.s.time;
    const challengeable = st.bond > 0n && !st.challenged && now <= st.challengeDeadline;
    const approvalOpen = st.liquidationFinal && now <= st.approvedAt + APPROVAL_TTL;
    let state = "UNDECIDED";
    if (approvalOpen) state = "APPROVED";
    else if (st.liquidationFinal) state = "APPROVAL_EXPIRED";
    else if (st.challenged && !st.decided) state = "SLASHED";
    else if (challengeable) state = "CLAIM_OPEN";
    else if (st.decided) state = st.bond === 0n ? "SETTLED" : "AWAITING_SETTLEMENT";
    const bounds = [[0, 1.5], [0, 1], [-1, 1], [0, 90], [0, 2000]];
    const names = ["ltv", "collateral_volatility_30d", "price_momentum_24h", "time_since_last_topup_days", "account_age_days"];
    return {
      position_id: id, market: p.market, features_q: f.q,
      features: Object.fromEntries(names.map((n, i) => [n, +(bounds[i][0] + (f.q[i] / 1024) * (bounds[i][1] - bounds[i][0])).toFixed(4)])),
      delta_bps: f.deltaBps,
      allowed_tier: f.deltaBps > T0_MIN ? "HEURISTIC" : f.deltaBps > T1_MIN ? "COMMITMENT" : "ZK_PROOF",
      past_round: 1, collateral_usd: f.collateralUsd, debt_usd: p.debt, liquidation_threshold_bps: f.market.thresholdBps,
      model_label: label, model_p_high: +probs[1].toFixed(4),
      state, approval_open: approvalOpen,
      approval_expires_in: approvalOpen ? st.approvedAt + APPROVAL_TTL - now : 0,
      commitment_revealed: st.revealed, snapshot_features_q: st.snapshot,
      tier2_model_hash: MODEL_HASH, finalized: st.decided, tier: st.tier, model_hash: st.modelHash,
      bond_wei: st.bond.toString(), claimant: st.claimant, challenge_deadline: st.challengeDeadline,
      seconds_until_deadline: st.challengeDeadline ? Math.max(0, st.challengeDeadline - now) : 0,
      challenged: st.challenged, challengeable, liquidations: p.liquidations || 0,
    };
  }

  async positionFeatures(id) {
    return this.getPosition(id);
  }

  async positionStatus(id) {
    return this.getPosition(id);
  }

  async listPositions() {
    const ids = Object.keys(this.s.positions).map(Number).sort((a, b) => b - a).slice(0, 60);
    return { positions: await Promise.all(ids.map((id) => this.getPosition(id))) };
  }

  async events() {
    return { events: this.s.events.slice(-300), latest_block: this.s.block };
  }

  async deployment() {
    return { network: "simulation", chainId: 0, verifierMode: "simulated", modelHash: MODEL_HASH, contracts: {} };
  }

  // ---- actions ---------------------------------------------------------

  async openPosition({ market = 0, ltv, account_age_days = 200, time_since_last_topup_days = 5, position_id } = {}) {
    const m = this.s.markets[market];
    if (!m) throw new Error(`unknown market ${market}`);
    const id = position_id ?? ++this.s.nextId;
    if (this.s.positions[id]) throw new Error(`PositionExists(${id})`);
    const price = this._price(m);
    this._tick();
    this.s.positions[id] = {
      market, collateral: 1, debt: price * ltv,
      openedAt: this.s.time - account_age_days * DAY - 60, lastTopUpAt: this.s.time - time_since_last_topup_days * DAY - 60,
      liquidations: 0,
    };
    this._emit("PositionOpened", { positionId: id, market });
    this._save();
    return this.getPosition(id);
  }

  async evaluate(id, forceTier = null) {
    id = Number(id);
    const f = this._features(id);
    const allowed = f.deltaBps > T0_MIN ? "HEURISTIC" : f.deltaBps > T1_MIN ? "COMMITMENT" : "ZK_PROOF";
    let tier = forceTier || allowed;
    if (POLICY[tier] < POLICY[allowed]) {
      throw new Error(`TierNotAllowed(${id}, ${TIER_NAMES[POLICY[tier]]}, ${f.deltaBps}): the chain refuses a tier this weak at delta ${f.deltaBps} bps`);
    }
    const { label, probs } = predict(f.q);
    const result = {
      position_id: id, ltv: f.ltv, delta: f.deltaBps / 10_000, delta_bps: f.deltaBps, features_q: f.q,
      tier, tier_reason: forceTier ? `forced to ${forceTier} (demo; policy said ${allowed})` : bandReason(f.deltaBps),
      outcome: "APPROVED", risk_score: null, model_hash: null, evidence_ref: null, tx_hash: null, gas_used: 0,
      proof_kind: null, proving_seconds: null, revealed: null, anchored: null,
    };
    if (tier === "COMMITMENT" && !forceTier && label === 1) {
      tier = "ZK_PROOF";
      result.tier = tier;
      result.tier_reason += "; escalated to ZK_PROOF because the model flags high risk (a cheap 'safe' claim would be false and slashable)";
    }
    if (tier === "ZK_PROOF") {
      await sleep(1200); // stands in for ~16 s of EZKL proving
      result.proof_kind = "simulated";
      result.proving_seconds = 16.1;
      result.risk_score = probs[1];
      result.model_hash = MODEL_HASH;
      if (label !== 1) {
        result.outcome = "NOT_LIQUIDATED";
        this._save();
        return result;
      }
    }
    this._beginDecision(id, tier === "ZK_PROOF");
    this._tick();
    const st = this._st(id);
    if (tier === "HEURISTIC") {
      this._openClaim(id, f.q, f.deltaBps, false);
      result.gas_used = GAS.decideHeuristic;
    } else if (tier === "COMMITMENT") {
      this._openClaim(id, f.q, f.deltaBps, true);
      result.risk_score = probs[1];
      result.model_hash = MODEL_HASH;
      result.evidence_ref = hex(64);
      result.salt = hex(64);
      result.gas_used = GAS.decideCommitment;
      this.s.commitments[id] = { score: probs[1] };
      if (!forceTier) {
        st.revealed = true;
        result.revealed = true;
        result.gas_used += GAS.revealCommitment;
        this._emit("CommitmentRevealed", { positionId: id, score: probs[1] });
      } else {
        result.revealed = false;
      }
    } else {
      st.liquidationFinal = true;
      st.approvedAt = this.s.time;
      result.gas_used = GAS.decideZkProof;
      result.evidence_ref = hex(64);
    }
    st.tier = TIER_NAMES[POLICY[tier]];
    st.modelHash = tier === "HEURISTIC" ? null : MODEL_HASH;
    result.tx_hash = hex(64);
    this._emit("DecisionLogged", { positionId: id, tier: st.tier, timestamp: this.s.time });
    if (tier === "ZK_PROOF") this._emit("LiquidationApproved", { positionId: id });
    else this._emit("SafeClaimRecorded", { positionId: id, tier: st.tier, claimant: ROUTER, bond: st.bond.toString() });
    this._save();
    return result;
  }

  async challengeProof(id) {
    id = Number(id);
    const st = this._st(id);
    if (!st.snapshot) throw new Error(`no Tier 0/1 claim has been made on position ${id}`);
    await sleep(1200);
    const { label, probs } = predict(st.snapshot);
    return {
      position_id: id, model_hash: MODEL_HASH, proof: hex(64), features_q: st.snapshot,
      public_inputs: [...st.snapshot, label, Math.round(probs[0] * 1024), Math.round(probs[1] * 1024)].map(String),
      label, high_risk: label === 1, proof_kind: "simulated", proving_seconds: 16.1,
    };
  }

  async challenge(id) {
    id = Number(id);
    const proof = await this.challengeProof(id);
    if (!proof.high_risk) return { slashed: false, proof, detail: "the proof on the snapshot shows low risk: the claim holds" };
    const st = this._st(id);
    if (st.challenged) throw new Error("AlreadyChallenged");
    if (st.bond === 0n) throw new Error("NotChallengeable: no bond to slash");
    if (this.s.time > st.challengeDeadline) throw new Error("ChallengeWindowClosed");
    this._tick();
    this._emit("ChallengeCommitted", { positionId: id, challenger: WATCHER });
    this._tick();
    const bond = st.bond;
    st.challenged = true;
    st.bond = 0n;
    if (!st.liquidationFinal) st.decided = false;
    this.s.pending[WATCHER] = (this.s.pending[WATCHER] || 0n) + bond;
    this._emit("DecisionChallenged", { positionId: id, challenger: WATCHER, bond: bond.toString() });
    this._save();
    return { slashed: true, proof, gas_used: GAS.commitChallenge + GAS.revealChallenge, tx_hash: hex(64) };
  }

  async reclaim(id) {
    id = Number(id);
    const st = this._st(id);
    if (this.s.time <= st.challengeDeadline) throw new Error("ChallengeWindowStillOpen");
    if (st.challenged) throw new Error("AlreadyChallenged");
    if (st.bond === 0n) throw new Error("NoBondToReclaim");
    this._tick();
    this._settle(id, st);
    this._save();
    return { gas_used: GAS.reclaimBond, position: await this.getPosition(id) };
  }

  async liquidate(id) {
    id = Number(id);
    const st = this._st(id);
    if (!(st.liquidationFinal && this.s.time <= st.approvedAt + APPROVAL_TTL)) {
      throw new Error("NoOpenApproval: a liquidation needs an open Tier-2 approval");
    }
    st.liquidationFinal = false;
    st.approvedAt = 0;
    const p = this.s.positions[id];
    const price = this._price(this.s.markets[p.market]);
    const repaid = p.debt * CLOSE_FACTOR;
    const seized = Math.min((repaid * (1 + BONUS)) / price, p.collateral);
    p.debt -= repaid;
    p.collateral -= seized;
    p.liquidations = (p.liquidations || 0) + 1;
    this._tick();
    this._emit("ApprovalConsumed", { positionId: id });
    this._emit("PositionLiquidated", { positionId: id, liquidator: KEEPER, debtRepaidUsd: repaid, collateralSeized: seized });
    this._save();
    return { gas_used: GAS.liquidate, position: await this.getPosition(id) };
  }

  async setPrice(market, price) {
    const m = this.s.markets[market];
    this._tick();
    m.rounds.push({ t: this.s.time, price });
    this._emit("PriceUpdated", { market: m.name, price });
    this._save();
    return this.markets();
  }

  async advance(seconds) {
    this._tick(seconds);
    for (const m of this.s.markets) m.rounds.push({ t: this.s.time, price: this._price(m) });
    this._save();
    return { block_time: this.s.time };
  }

  async simulate(n = 9) {
    const results = [];
    for (let i = 0; i < n; i++) {
      const market = i % 3;
      const band = i % 3;
      const ltv = band === 0 ? 0.35 + Math.random() * 0.2 : band === 1 ? 0.68 + Math.random() * 0.06 : 0.76 + Math.random() * 0.12;
      const pos = await this.openPosition({ market, ltv: Math.min(ltv, this.s.markets[market].thresholdBps / 10_000 + 0.1),
        account_age_days: Math.round(30 + Math.random() * 900), time_since_last_topup_days: Math.round(Math.random() * 40) });
      const r = await this.evaluate(pos.position_id);
      results.push({ ...r, market: this.s.markets[market].name });
    }
    const tier_counts = {};
    for (const r of results) tier_counts[r.tier] = (tier_counts[r.tier] || 0) + 1;
    return { results, tier_counts, all_tiers_exercised: Object.keys(tier_counts).length === 3 };
  }
}

function bandReason(d) {
  if (d > T0_MIN) return `on-chain delta ${d} bps > 1500 (far from boundary)`;
  if (d > T1_MIN) return `500 < on-chain delta ${d} bps <= 1500 (approaching boundary)`;
  return `on-chain delta ${d} bps <= 500 (near or past boundary)`;
}
