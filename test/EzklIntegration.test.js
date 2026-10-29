const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deployTrustTier, PAST_ROUND } = require("./helpers/fixture");

// LiquidationEngine wired to the REAL EZKL-generated Halo2 verifier, driven
// by REAL proofs from circuits/build_circuit.py (circuits/samples.json).
//
// Each sample in samples.json was generated from on-chain parameters
// (collateral, debt, threshold, price now / 24 h ago, volatility, top-up and
// position age). Here we recreate exactly those positions in MockLendingPool
// with mock Chainlink feeds, and the engine computes the five quantized
// features itself. The proof is accepted only because the contract's
// features equal the proof's public inputs - nobody "commits" them.
describe("LiquidationEngine + real EzklVerifier (verified on-chain inputs)", function () {
  let samples, modelHash;
  const BOND = ethers.parseEther("0.01");
  const POSITION = 1;

  before(function () {
    const samplesPath = path.join(__dirname, "..", "circuits", "samples.json");
    const metadataPath = path.join(__dirname, "..", "off-chain", "risk_model", "artifacts", "model_metadata.json");
    if (!fs.existsSync(samplesPath) || !fs.existsSync(metadataPath)) this.skip();
    samples = {};
    for (const s of JSON.parse(fs.readFileSync(samplesPath, "utf8")).samples) {
      samples[s.name] = { ...s, inputs: s.public_inputs.map((x) => BigInt(x)) };
    }
    modelHash = JSON.parse(fs.readFileSync(metadataPath, "utf8")).model_hash_keccak256;
  });

  /** Deploy TrustTier with the real verifier and open the sample's position. */
  async function setup(sample, verifier) {
    if (!verifier) verifier = await (await ethers.getContractFactory("Halo2Verifier")).deploy();
    const t = await deployTrustTier({
      verifier: await verifier.getAddress(),
      modelHash,
      price: BigInt(sample.price_now),
      pricePast: BigInt(sample.price_past),
      vol: BigInt(sample.vol_answer),
    });
    const ltv = (Number(sample.debt_usd) / Number(sample.collateral_usd)).toFixed(4);
    await t.openPosition(POSITION, ltv, { ageDays: sample.age_days, topupDays: sample.topup_days_ago });
    return { ...t, verifier };
  }

  describe("high-risk sample", function () {
    let t, s;
    beforeEach(async function () {
      s = samples.high_risk;
      t = await setup(s);
    });

    it("the contract computes the same features the proof was made on", async function () {
      const [q, delta] = await t.engine.currentFeatures(POSITION, PAST_ROUND);
      expect(q.map(BigInt)).to.deep.equal(s.q.map(BigInt));
      expect(s.inputs.slice(0, 5)).to.deep.equal(s.q.map(BigInt));
      expect(s.inputs[5]).to.equal(1n);
      expect(delta).to.equal(8000n - 9300n);
    });

    it("accepts the real proof, approves the Tier-2 liquidation and logs keccak256(proof)", async function () {
      const tx = await t.engine.decideZkProof(POSITION, PAST_ROUND, modelHash, s.proof, s.inputs);
      await expect(tx).to.emit(t.engine, "LiquidationApproved").withArgs(POSITION, 2, modelHash);
      const receipt = await tx.wait();
      console.log(`      (full Tier-2 decideZkProof gas used: ${receipt.gasUsed})`);
      const record = await t.auditLog.decisionByPosition(POSITION);
      expect(record.evidenceRef).to.equal(ethers.keccak256(s.proof));
    });

    it("only Tier 2 is allowed: the chain itself refuses the cheap tiers for this position", async function () {
      await expect(t.engine.decideHeuristic(POSITION, PAST_ROUND, { value: BOND }))
        .to.be.revertedWithCustomError(t.engine, "TierNotAllowed");
      await expect(t.engine.decideCommitment(POSITION, PAST_ROUND, modelHash, ethers.id("c"), { value: BOND }))
        .to.be.revertedWithCustomError(t.engine, "TierNotAllowed");
    });

    it("rejects the proof once the position changes (a top-up)", async function () {
      await t.pool.addCollateral(POSITION, 10n ** 17n);
      await expect(t.engine.decideZkProof(POSITION, PAST_ROUND, modelHash, s.proof, s.inputs))
        .to.be.revertedWithCustomError(t.engine, "ProofNotForPosition");
    });

    it("rejects the proof once the price moves", async function () {
      await t.priceFeed.updateAnswer(BigInt(s.price_now) - 10n ** 8n);
      await expect(t.engine.decideZkProof(POSITION, PAST_ROUND, modelHash, s.proof, s.inputs))
        .to.be.revertedWithCustomError(t.engine, "ProofNotForPosition");
    });

    it("rejects replaying the proof against another position", async function () {
      await t.openPosition(2, "0.50");
      await expect(t.engine.decideZkProof(2, PAST_ROUND, modelHash, s.proof, s.inputs))
        .to.be.revertedWithCustomError(t.engine, "ProofNotForPosition").withArgs(2);
    });

    it("the real verifier rejects tampered outputs", async function () {
      const forged = [...s.inputs];
      forged[6] = 0n; forged[7] = 1024n;
      await expect(t.engine.decideZkProof(POSITION, PAST_ROUND, modelHash, s.proof, forged))
        .to.be.revertedWithCustomError(t.engine, "InvalidZkProof");
      const bytes = ethers.getBytes(s.proof);
      bytes[100] ^= 0xff;
      await expect(t.engine.decideZkProof(POSITION, PAST_ROUND, modelHash, bytes, s.inputs))
        .to.be.revertedWithCustomError(t.engine, "InvalidZkProof");
    });

    it("rejects an unregistered model even with a valid proof", async function () {
      await expect(t.engine.decideZkProof(POSITION, PAST_ROUND, ethers.id("other-model"), s.proof, s.inputs))
        .to.be.revertedWithCustomError(t.engine, "ModelNotAuthorized");
    });

    it("hot-swap mock -> real verifier: garbage proofs stop passing, real ones keep passing", async function () {
      const mock = await (await ethers.getContractFactory("MockTier2Verifier")).deploy();
      const m = await setup(s, mock);
      await m.openPosition(2, "0.93", { ageDays: s.age_days, topupDays: s.topup_days_ago });
      await expect(m.engine.decideZkProof(2, PAST_ROUND, modelHash, "0x1234", s.inputs)).to.not.be.reverted;
      await m.engine.setTier2Verifier(await t.verifier.getAddress(), modelHash);
      await expect(m.engine.decideZkProof(POSITION, PAST_ROUND, modelHash, "0x1234", s.inputs))
        .to.be.revertedWithCustomError(m.engine, "InvalidZkProof");
      await expect(m.engine.decideZkProof(POSITION, PAST_ROUND, modelHash, s.proof, s.inputs)).to.not.be.reverted;
    });
  });

  describe("low-risk sample", function () {
    let t, s, claimant, challenger;
    beforeEach(async function () {
      [, claimant, challenger] = await ethers.getSigners();
      s = samples.low_risk;
      t = await setup(s);
    });

    it("the contract computes the same features the proof was made on", async function () {
      const [q] = await t.engine.currentFeatures(POSITION, PAST_ROUND);
      expect(q.map(BigInt)).to.deep.equal(s.q.map(BigInt));
      expect(s.inputs[5]).to.equal(0n);
    });

    it("a real low-risk proof cannot liquidate", async function () {
      await expect(t.engine.decideZkProof(POSITION, PAST_ROUND, modelHash, s.proof, s.inputs))
        .to.be.revertedWithCustomError(t.engine, "ProofDoesNotShowHighRisk").withArgs(POSITION);
    });

    it("the label cannot be flipped to high risk", async function () {
      const forged = [...s.inputs];
      forged[5] = 1n;
      await expect(t.engine.decideZkProof(POSITION, PAST_ROUND, modelHash, s.proof, forged))
        .to.be.revertedWithCustomError(t.engine, "InvalidZkProof");
    });

    it("an honest Tier-0 claim is not slashed: the real proof on its snapshot says low risk", async function () {
      await t.engine.connect(claimant).decideHeuristic(POSITION, PAST_ROUND, { value: BOND });
      await expect(t.engine.connect(challenger).challengeDecision(POSITION, modelHash, s.proof, s.inputs))
        .to.be.revertedWithCustomError(t.engine, "ChallengeDidNotContradictClaim");
      expect(await t.engine.bondOf(POSITION)).to.equal(BOND);
    });

    it("another position's high-risk proof cannot slash this claim", async function () {
      await t.engine.connect(claimant).decideHeuristic(POSITION, PAST_ROUND, { value: BOND });
      const high = samples.high_risk;
      await expect(t.engine.connect(challenger).challengeDecision(POSITION, modelHash, high.proof, high.inputs))
        .to.be.revertedWithCustomError(t.engine, "ProofNotForPosition");
    });
  });

  describe("watch-band sample: a cheap claim the model contradicts", function () {
    let t, s, claimant, challenger;
    const COMMITMENT = ethers.id("features+score+salt");
    beforeEach(async function () {
      [, claimant, challenger] = await ethers.getSigners();
      s = samples.watch_high;
      if (!s) this.skip();
      t = await setup(s);
    });

    it("the chain allows Tier 1 here (delta 8%) but not Tier 0", async function () {
      const [q, delta] = await t.engine.currentFeatures(POSITION, PAST_ROUND);
      expect(q.map(BigInt)).to.deep.equal(s.q.map(BigInt));
      expect(delta).to.equal(800n);
      await expect(t.engine.decideHeuristic(POSITION, PAST_ROUND, { value: BOND }))
        .to.be.revertedWithCustomError(t.engine, "TierNotAllowed");
    });

    it("a real proof on the snapshot slashes the Tier-1 claim, and then liquidates at Tier 2", async function () {
      await t.engine.connect(claimant).decideCommitment(POSITION, PAST_ROUND, modelHash, COMMITMENT, { value: BOND });
      const tx = await t.engine.connect(challenger).challengeDecision(POSITION, modelHash, s.proof, s.inputs);
      await expect(tx).to.emit(t.engine, "DecisionChallenged").withArgs(POSITION, challenger.address, BOND);
      console.log(`      (challengeDecision gas used: ${(await tx.wait()).gasUsed})`);
      await expect(t.engine.connect(challenger).withdraw()).to.changeEtherBalance(challenger, BOND);
      await expect(t.engine.connect(challenger).decideZkProof(POSITION, PAST_ROUND, modelHash, s.proof, s.inputs))
        .to.emit(t.engine, "LiquidationApproved").withArgs(POSITION, 2, modelHash);
    });

    it("the snapshot still decides the challenge after the claimant tops up", async function () {
      await t.engine.connect(claimant).decideCommitment(POSITION, PAST_ROUND, modelHash, COMMITMENT, { value: BOND });
      await t.pool.addCollateral(POSITION, 10n ** 18n); // the position is now safe...
      // ...but the claim was false when it was made, so the challenge still succeeds.
      await expect(t.engine.connect(challenger).challengeDecision(POSITION, modelHash, s.proof, s.inputs))
        .to.emit(t.engine, "DecisionChallenged");
      // and the proof no longer matches the live position, so it cannot liquidate it
      await expect(t.engine.decideZkProof(POSITION, PAST_ROUND, modelHash, s.proof, s.inputs))
        .to.be.revertedWithCustomError(t.engine, "ProofNotForPosition");
    });
  });
});
