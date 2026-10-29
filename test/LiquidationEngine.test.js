const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  deployTrustTier, increaseTime, now, DAY, PRICE, VOL, PAST_ROUND,
} = require("./helpers/fixture");

// Positions used below (collateral $2,000, liquidation threshold 0.80):
//   SAFE  LTV 0.50  -> delta 30%  : any tier allowed
//   WATCH LTV 0.70  -> delta 10%  : Tier 1 or 2 (Tier 0 refused)
//   RISKY LTV 0.93  -> delta -13% : Tier 2 only
describe("LiquidationEngine (verified on-chain inputs)", function () {
  let t, engine, registry, auditLog, pool, priceFeed, volFeed, mockVerifier, MODEL;
  let owner, other, challenger;
  const UNREGISTERED = ethers.keccak256(ethers.toUtf8Bytes("unregistered-model"));
  const COMMITMENT = ethers.keccak256(ethers.toUtf8Bytes("features+score+salt"));
  const PROOF = ethers.toUtf8Bytes("mock-proof");
  const BOND = ethers.parseEther("0.01");
  const Tier = { Heuristic: 0, Commitment: 1, ZkProof: 2 };
  const SAFE = 1, WATCH = 2, RISKY = 3;

  beforeEach(async function () {
    [owner, other, challenger] = await ethers.getSigners();
    t = await deployTrustTier();
    ({ engine, registry, auditLog, pool, priceFeed, volFeed, mockVerifier } = t);
    MODEL = t.modelHash;
    await t.openPosition(SAFE, "0.50");
    await t.openPosition(WATCH, "0.70");
    await t.openPosition(RISKY, "0.93");
  });

  const tier0 = (id, from = owner, value = BOND) => engine.connect(from).decideHeuristic(id, PAST_ROUND, { value });
  const tier1 = (id, from = owner, model = MODEL) =>
    engine.connect(from).decideCommitment(id, PAST_ROUND, model, COMMITMENT, { value: BOND });
  const tier2 = async (id, from = owner, label = 1, model = MODEL) =>
    engine.connect(from).decideZkProof(id, PAST_ROUND, model, PROOF, await t.inputs(id, label));

  describe("on-chain features and delta", function () {
    it("computes the five quantized features exactly as the off-chain mirror does", async function () {
      const [q, delta] = await engine.currentFeatures(RISKY, PAST_ROUND);
      // ltv 0.93: 1860e8 * 2048 / (3 * 2000e8) = 634
      expect(q[0]).to.equal(634n);
      // volatility 35%: 35e8 * 1024 / (100 * 1e8) = 358
      expect(q[1]).to.equal(358n);
      // momentum: 2000 * 512 / 2200 = 465
      expect(q[2]).to.equal(465n);
      // top-up 5 days ago: 5 * 1024 / 90 = 56 ; age 200 days: 200 * 1024 / 2000 = 102
      expect(q[3]).to.equal(56n);
      expect(q[4]).to.equal(102n);
      expect(delta).to.equal(8000n - 9300n);
    });

    it("updates when the lending position changes (a top-up resets time-since-top-up)", async function () {
      await pool.addCollateral(RISKY, 10n ** 18n); // collateral doubles: LTV 0.465
      const [q, delta] = await engine.currentFeatures(RISKY, PAST_ROUND);
      expect(q[0]).to.equal(317n);
      expect(q[3]).to.equal(0n);
      expect(delta).to.equal(8000n - 4650n);
    });

    it("clamps features to their bounds (LTV above 1.5 -> 1024)", async function () {
      await t.openPosition(9, "1.80");
      const [q] = await engine.currentFeatures(9, PAST_ROUND);
      expect(q[0]).to.equal(1024n);
    });

    it("rejects a stale price feed", async function () {
      await increaseTime(4 * 60 * 60); // older than MAX_PRICE_AGE (3 h)
      await expect(engine.currentFeatures(SAFE, PAST_ROUND)).to.be.revertedWithCustomError(engine, "StaleFeed");
    });

    it("rejects a stale volatility feed", async function () {
      await increaseTime(3 * DAY);
      await priceFeed.updateAnswer(PRICE); // keep the price fresh
      await expect(engine.currentFeatures(SAFE, 2)).to.be.revertedWithCustomError(engine, "StaleFeed");
    });

    it("rejects a momentum round that was not the one in effect 24 hours ago", async function () {
      // Round 2 is current, so it was not in effect 24 h ago.
      await expect(engine.currentFeatures(SAFE, 2))
        .to.be.revertedWithCustomError(engine, "BadMomentumRound").withArgs(2);
      // A newer round 1h later makes round 1 no longer the right one only if
      // round 2's timestamp were <= now-24h; here it is not, so round 1 stays valid.
      await priceFeed.updateAnswer(PRICE);
      await expect(engine.currentFeatures(SAFE, PAST_ROUND)).to.not.be.reverted;
    });

    it("rejects a round that is older than the one in effect 24 hours ago", async function () {
      await increaseTime(2 * DAY);
      await priceFeed.updateAnswer(PRICE);
      await volFeed.updateAnswer(VOL);
      // Now round 2 (2 days ago) was in effect 24 h ago, not round 1.
      await expect(engine.currentFeatures(SAFE, PAST_ROUND))
        .to.be.revertedWithCustomError(engine, "BadMomentumRound").withArgs(PAST_ROUND);
      await expect(engine.currentFeatures(SAFE, 2)).to.not.be.reverted;
    });

    it("reverts for an unknown position", async function () {
      await expect(engine.currentFeatures(999, PAST_ROUND)).to.be.revertedWithCustomError(pool, "UnknownPosition");
    });
  });

  describe("tier enforcement from on-chain delta", function () {
    it("allows Tier 0 only when delta > 15%", async function () {
      await expect(tier0(SAFE)).to.emit(engine, "SafeClaimRecorded")
        .withArgs(SAFE, Tier.Heuristic, ethers.ZeroHash, owner.address, BOND);
      await expect(tier0(WATCH))
        .to.be.revertedWithCustomError(engine, "TierNotAllowed").withArgs(WATCH, Tier.Heuristic, 1000);
      await expect(tier0(RISKY)).to.be.revertedWithCustomError(engine, "TierNotAllowed");
    });

    it("allows Tier 1 only when delta > 5%", async function () {
      await expect(tier1(WATCH)).to.emit(engine, "SafeClaimRecorded")
        .withArgs(WATCH, Tier.Commitment, MODEL, owner.address, BOND);
      await expect(tier1(RISKY))
        .to.be.revertedWithCustomError(engine, "TierNotAllowed").withArgs(RISKY, Tier.Commitment, -1300);
    });

    it("allows Tier 2 at any delta (a stronger tier is always acceptable)", async function () {
      await expect(tier2(SAFE)).to.not.be.reverted;
      await expect(tier2(RISKY)).to.emit(engine, "LiquidationApproved").withArgs(RISKY, Tier.ZkProof, MODEL);
    });

    it("a source timestamp in the future counts as zero days instead of reverting", async function () {
      const t0 = await now();
      await pool.setTimestamps(SAFE, t0 + 10 * DAY, t0 + 10 * DAY);
      const [q] = await engine.currentFeatures(SAFE, PAST_ROUND);
      expect(q[3]).to.equal(0n);
      expect(q[4]).to.equal(0n);
    });

    it("re-evaluates the tier when the position changes: a borrow can make Tier 0 illegal", async function () {
      await pool.setDebt(SAFE, 1860n * 10n ** 8n);
      await expect(tier0(SAFE)).to.be.revertedWithCustomError(engine, "TierNotAllowed");
    });

    it("a refused attempt does not consume the position", async function () {
      await expect(tier0(WATCH)).to.be.reverted;
      expect(await engine.positionFinalized(WATCH)).to.equal(false);
      await expect(tier1(WATCH)).to.not.be.reverted;
    });
  });

  describe("Tier 0 and Tier 1 claims", function () {
    it("snapshot the features the claim was made on and log them as evidence", async function () {
      const q = await t.features(SAFE);
      const tx = await tier0(SAFE);
      await expect(tx).to.emit(engine, "FeaturesSnapshotted");
      const expected = ethers.solidityPackedKeccak256(["uint256[5]"], [q]);
      expect(await engine.featureSnapshot(SAFE)).to.equal(expected);
      const record = await auditLog.decisionByPosition(SAFE);
      expect(record.tier).to.equal(Tier.Heuristic);
      expect(record.evidenceRef).to.equal(expected);
    });

    it("require a bond of at least MIN_BOND", async function () {
      await expect(tier0(SAFE, owner, 0)).to.be.revertedWithCustomError(engine, "InsufficientBond").withArgs(SAFE, BOND, 0);
      await expect(tier0(SAFE, owner, BOND - 1n)).to.be.revertedWithCustomError(engine, "InsufficientBond");
      await expect(tier0(SAFE, owner, BOND * 2n)).to.not.be.reverted;
      expect(await engine.bondOf(SAFE)).to.equal(BOND * 2n);
    });

    it("record the claimant and open a 1-hour challenge window", async function () {
      const tx = await tier0(SAFE, other);
      const block = await ethers.provider.getBlock(tx.blockNumber);
      expect(await engine.claimant(SAFE)).to.equal(other.address);
      expect(await engine.challengeDeadline(SAFE)).to.equal(block.timestamp + 3600);
    });

    it("Tier 1 stores its commitment and needs an authorized model and a non-zero commitment", async function () {
      await tier1(WATCH);
      expect(await engine.tier1Commitments(WATCH)).to.equal(COMMITMENT);
      await t.openPosition(10, "0.70");
      await expect(tier1(10, owner, UNREGISTERED)).to.be.revertedWithCustomError(engine, "ModelNotAuthorized");
      await expect(engine.decideCommitment(10, PAST_ROUND, MODEL, ethers.ZeroHash, { value: BOND }))
        .to.be.revertedWithCustomError(engine, "CommitmentRequired");
      await registry.revokeModel(MODEL);
      await expect(tier1(10)).to.be.revertedWithCustomError(engine, "ModelNotAuthorized");
    });
  });

  describe("Tier 2 decisions", function () {
    it("approve with a proof on the current on-chain features and log keccak256(proof)", async function () {
      await tier2(RISKY);
      expect(await engine.liquidationFinal(RISKY)).to.equal(true);
      const record = await auditLog.decisionByPosition(RISKY);
      expect(record.tier).to.equal(Tier.ZkProof);
      expect(record.evidenceRef).to.equal(ethers.keccak256(PROOF));
      expect(await engine.bondOf(RISKY)).to.equal(0);
    });

    it("reject a proof computed on features other than the on-chain ones", async function () {
      const forged = await t.inputs(RISKY);
      forged[0] += 1n; // a slightly different LTV
      await expect(engine.decideZkProof(RISKY, PAST_ROUND, MODEL, PROOF, forged))
        .to.be.revertedWithCustomError(engine, "ProofNotForPosition").withArgs(RISKY);
    });

    it("reject replaying another position's proof", async function () {
      await expect(engine.decideZkProof(SAFE, PAST_ROUND, MODEL, PROOF, await t.inputs(RISKY)))
        .to.be.revertedWithCustomError(engine, "ProofNotForPosition");
    });

    it("reject a proof made before the price moved", async function () {
      const before = await t.inputs(RISKY);
      await priceFeed.updateAnswer(1900n * 10n ** 8n);
      await expect(engine.decideZkProof(RISKY, PAST_ROUND, MODEL, PROOF, before))
        .to.be.revertedWithCustomError(engine, "ProofNotForPosition");
    });

    it("reject a valid proof whose label is low risk", async function () {
      await expect(tier2(RISKY, owner, 0)).to.be.revertedWithCustomError(engine, "ProofDoesNotShowHighRisk");
    });

    it("reject an invalid proof without consuming the position", async function () {
      await mockVerifier.setShouldVerify(false);
      await expect(tier2(RISKY)).to.be.revertedWithCustomError(engine, "InvalidZkProof").withArgs(RISKY);
      expect(await engine.positionFinalized(RISKY)).to.equal(false);
      await mockVerifier.setShouldVerify(true);
      await expect(tier2(RISKY)).to.not.be.reverted;
    });

    it("reject unregistered models and models the verifier does not encode", async function () {
      await expect(tier2(RISKY, owner, 1, UNREGISTERED)).to.be.revertedWithCustomError(engine, "ModelNotAuthorized");
      const OTHER = ethers.keccak256(ethers.toUtf8Bytes("risk-model-v2"));
      await registry.registerModel(OTHER, "");
      await expect(tier2(RISKY, owner, 1, OTHER)).to.be.revertedWithCustomError(engine, "ModelNotBoundToVerifier");
    });
  });

  describe("per-position lock and lifecycle", function () {
    it("rejects a second cheap claim while a claim's window is open", async function () {
      await tier0(SAFE);
      await expect(tier0(SAFE)).to.be.revertedWithCustomError(engine, "PositionAlreadyFinalized").withArgs(SAFE);
      await expect(tier1(SAFE)).to.be.revertedWithCustomError(engine, "PositionAlreadyFinalized");
    });

    it("a Tier-2 liquidation supersedes an open cheap claim, which stays challengeable", async function () {
      await tier1(WATCH, other);
      await pool.setDebt(WATCH, 1900n * 10n ** 8n); // the position becomes risky inside the window
      await expect(tier2(WATCH, challenger))
        .to.emit(engine, "ClaimSuperseded").withArgs(WATCH, other.address)
        .and.to.emit(engine, "LiquidationApproved").withArgs(WATCH, Tier.ZkProof, MODEL);
      expect(await engine.liquidationFinal(WATCH)).to.equal(true);
      expect(await engine.bondOf(WATCH)).to.equal(BOND); // the claim's bond is untouched
    });

    it("a superseded claim that was false is still slashed, and the liquidation stays final", async function () {
      await tier1(WATCH, other);
      const atClaim = await t.inputs(WATCH, 1);   // the model said high risk at claim time
      await pool.setDebt(WATCH, 1900n * 10n ** 8n);
      await tier2(WATCH);
      await expect(engine.connect(challenger).challengeDecision(WATCH, MODEL, PROOF, atClaim))
        .to.emit(engine, "DecisionChallenged").withArgs(WATCH, challenger.address, BOND);
      expect(await engine.positionFinalized(WATCH)).to.equal(true);
      expect(await engine.liquidationFinal(WATCH)).to.equal(true);
      await expect(tier2(WATCH)).to.be.revertedWithCustomError(engine, "PositionAlreadyFinalized");
    });

    it("a superseded honest claim reclaims its bond after the window", async function () {
      await tier0(SAFE, other);
      await pool.setDebt(SAFE, 1900n * 10n ** 8n);
      await tier2(SAFE);
      await increaseTime(3601);
      await expect(engine.reclaimBond(SAFE)).to.emit(engine, "BondReclaimed").withArgs(SAFE, other.address, BOND);
    });

    it("a Tier-2 approval blocks every decision until it expires, then the position re-opens", async function () {
      await tier2(RISKY);
      await expect(tier2(RISKY)).to.be.revertedWithCustomError(engine, "PositionAlreadyFinalized");
      expect(await engine.approvalOpen(RISKY)).to.equal(true);
      await increaseTime(31 * 60); // APPROVAL_TTL = 30 min
      await priceFeed.updateAnswer(PRICE);
      expect(await engine.approvalOpen(RISKY)).to.equal(false);
      await expect(tier2(RISKY)).to.emit(engine, "ApprovalExpired").withArgs(RISKY)
        .and.to.emit(engine, "LiquidationApproved");
    });

    it("after an unchallenged window the position can be re-decided, crediting the old bond", async function () {
      await tier0(SAFE, other);
      await increaseTime(3601);
      await expect(tier2(SAFE)).to.emit(engine, "PositionReopened").withArgs(SAFE, BOND);
      expect(await engine.pendingWithdrawals(other.address)).to.equal(BOND);
      await expect(engine.reclaimBond(SAFE)).to.be.revertedWithCustomError(engine, "NoBondToReclaim");
    });

    it("a position that became risky after an honest claim can then be liquidated", async function () {
      await tier0(SAFE);
      await increaseTime(3601);
      await pool.setDebt(SAFE, 1900n * 10n ** 8n); // the borrower borrowed more
      await expect(tier0(SAFE)).to.be.revertedWithCustomError(engine, "TierNotAllowed");
      await expect(tier2(SAFE)).to.emit(engine, "LiquidationApproved").withArgs(SAFE, Tier.ZkProof, MODEL);
    });

    it("different positions never block each other", async function () {
      await tier0(SAFE);
      await expect(tier1(WATCH)).to.not.be.reverted;
      await expect(tier2(RISKY)).to.not.be.reverted;
    });
  });

  describe("challengeDecision", function () {
    it("slashes a false claim with a proof on the snapshotted features and re-opens the position", async function () {
      await tier1(WATCH, other); // Tier 1 is legal here, but suppose the model says high risk
      const proofInputs = await t.inputs(WATCH, 1);
      await expect(engine.connect(challenger).challengeDecision(WATCH, MODEL, PROOF, proofInputs))
        .to.emit(engine, "DecisionChallenged").withArgs(WATCH, challenger.address, BOND);
      expect(await engine.pendingWithdrawals(challenger.address)).to.equal(BOND);
      expect(await engine.positionFinalized(WATCH)).to.equal(false);
      // the same proof now liquidates it
      await expect(engine.connect(challenger).decideZkProof(WATCH, PAST_ROUND, MODEL, PROOF, proofInputs))
        .to.emit(engine, "LiquidationApproved").withArgs(WATCH, Tier.ZkProof, MODEL);
    });

    it("judges the claim on its snapshot: a proof on later prices cannot slash an honest claimant", async function () {
      await tier0(SAFE, other);
      await priceFeed.updateAnswer(1500n * 10n ** 8n); // prices crash after the claim
      const later = await t.inputs(SAFE, 1);
      await expect(engine.connect(challenger).challengeDecision(SAFE, MODEL, PROOF, later))
        .to.be.revertedWithCustomError(engine, "ProofNotForPosition").withArgs(SAFE);
      expect(await engine.bondOf(SAFE)).to.equal(BOND);
    });

    it("does not slash when the proof on the snapshot says low risk", async function () {
      await tier0(SAFE, other);
      await expect(engine.connect(challenger).challengeDecision(SAFE, MODEL, PROOF, await t.inputs(SAFE, 0)))
        .to.be.revertedWithCustomError(engine, "ChallengeDidNotContradictClaim");
    });

    it("rejects malformed inputs, invalid proofs, wrong models, closed windows and repeats", async function () {
      await tier0(SAFE, other);
      const good = await t.inputs(SAFE, 1);
      await expect(engine.challengeDecision(SAFE, MODEL, PROOF, []))
        .to.be.revertedWithCustomError(engine, "ProofNotForPosition");
      await expect(engine.challengeDecision(SAFE, UNREGISTERED, PROOF, good))
        .to.be.revertedWithCustomError(engine, "ModelNotAuthorized");
      await mockVerifier.setShouldVerify(false);
      await expect(engine.challengeDecision(SAFE, MODEL, PROOF, good)).to.be.revertedWithCustomError(engine, "InvalidZkProof");
      await mockVerifier.setShouldVerify(true);
      await engine.connect(challenger).challengeDecision(SAFE, MODEL, PROOF, good);
      await expect(engine.challengeDecision(SAFE, MODEL, PROOF, good)).to.be.revertedWithCustomError(engine, "AlreadyChallenged");

      await tier1(WATCH, other);
      await increaseTime(3601);
      await expect(engine.challengeDecision(WATCH, MODEL, PROOF, await t.inputs(WATCH, 1)))
        .to.be.revertedWithCustomError(engine, "ChallengeWindowClosed");
    });

    it("cannot challenge a Tier-2 decision or an undecided position", async function () {
      await tier2(RISKY);
      await expect(engine.challengeDecision(RISKY, MODEL, PROOF, await t.inputs(RISKY)))
        .to.be.revertedWithCustomError(engine, "NotChallengeable");
      await expect(engine.challengeDecision(SAFE, MODEL, PROOF, await t.inputs(SAFE)))
        .to.be.revertedWithCustomError(engine, "NotChallengeable");
    });

    it("a new claim after a successful challenge is challengeable again", async function () {
      await tier0(SAFE, other);
      const inputs = await t.inputs(SAFE, 1);
      await engine.connect(challenger).challengeDecision(SAFE, MODEL, PROOF, inputs);
      await tier0(SAFE, other);
      expect(await engine.challenged(SAFE)).to.equal(false);
      await expect(engine.connect(challenger).challengeDecision(SAFE, MODEL, PROOF, inputs)).to.emit(engine, "DecisionChallenged");
      expect(await engine.pendingWithdrawals(challenger.address)).to.equal(BOND * 2n);
    });
  });

  describe("deposit-funded bonds", function () {
    it("a claim without ETH draws MIN_BOND from the claimant's deposit", async function () {
      await expect(engine.connect(other).deposit({ value: BOND * 3n })).to.emit(engine, "Deposited").withArgs(other.address, BOND * 3n);
      await expect(engine.connect(other).decideHeuristic(SAFE, PAST_ROUND)).to.emit(engine, "SafeClaimRecorded");
      expect(await engine.bondOf(SAFE)).to.equal(BOND);
      expect(await engine.claimant(SAFE)).to.equal(other.address);
      expect(await engine.pendingWithdrawals(other.address)).to.equal(BOND * 2n);
      await engine.connect(other).decideCommitment(WATCH, PAST_ROUND, MODEL, COMMITMENT);
      expect(await engine.pendingWithdrawals(other.address)).to.equal(BOND);
    });

    it("reverts without enough deposit, and a challenge still slashes a deposit-funded bond", async function () {
      await expect(engine.connect(other).decideHeuristic(SAFE, PAST_ROUND))
        .to.be.revertedWithCustomError(engine, "InsufficientBond").withArgs(SAFE, BOND, 0);
      await engine.connect(other).deposit({ value: BOND });
      await engine.connect(other).decideCommitment(WATCH, PAST_ROUND, MODEL, COMMITMENT);
      await expect(engine.connect(challenger).challengeDecision(WATCH, MODEL, PROOF, await t.inputs(WATCH, 1)))
        .to.emit(engine, "DecisionChallenged").withArgs(WATCH, challenger.address, BOND);
      expect(await engine.pendingWithdrawals(other.address)).to.equal(0);
    });

    it("reclaimed bonds are recycled into the next claim", async function () {
      await tier0(SAFE, other);
      await increaseTime(3601);
      await priceFeed.updateAnswer(PRICE);
      await engine.reclaimBond(SAFE);
      await expect(engine.connect(other).decideCommitment(WATCH, PAST_ROUND, MODEL, COMMITMENT)).to.not.be.reverted;
      expect(await engine.pendingWithdrawals(other.address)).to.equal(0);
    });
  });

  describe("reclaimBond and withdraw", function () {
    it("credits the claimant (not the caller) after the window, once", async function () {
      await tier0(SAFE, other);
      await expect(engine.reclaimBond(SAFE)).to.be.revertedWithCustomError(engine, "ChallengeWindowStillOpen");
      await increaseTime(3601);
      await expect(engine.reclaimBond(SAFE)).to.emit(engine, "BondReclaimed").withArgs(SAFE, other.address, BOND);
      await expect(engine.reclaimBond(SAFE)).to.be.revertedWithCustomError(engine, "NoBondToReclaim");
      await expect(engine.connect(other).withdraw()).to.changeEtherBalance(other, BOND);
      await expect(engine.connect(other).withdraw()).to.be.revertedWithCustomError(engine, "NothingToWithdraw");
    });

    it("refuses to reclaim a slashed bond", async function () {
      await tier0(SAFE, other);
      await engine.connect(challenger).challengeDecision(SAFE, MODEL, PROOF, await t.inputs(SAFE, 1));
      await increaseTime(3601);
      await expect(engine.reclaimBond(SAFE)).to.be.revertedWithCustomError(engine, "AlreadyChallenged");
      await expect(engine.connect(challenger).withdraw()).to.emit(engine, "Withdrawn").withArgs(challenger.address, BOND);
    });
  });

  describe("owner configuration", function () {
    it("only the owner can change the verifier, position source or feed ages", async function () {
      await expect(engine.connect(other).setTier2Verifier(other.address, MODEL))
        .to.be.revertedWithCustomError(engine, "OwnableUnauthorizedAccount");
      await expect(engine.connect(other).setPositionSource(other.address))
        .to.be.revertedWithCustomError(engine, "OwnableUnauthorizedAccount");
      await expect(engine.connect(other).setMaxFeedAges(1, 1))
        .to.be.revertedWithCustomError(engine, "OwnableUnauthorizedAccount");
    });

    it("a verifier swap takes effect immediately and is evented", async function () {
      const strict = await (await ethers.getContractFactory("MockTier2Verifier")).deploy();
      await strict.setShouldVerify(false);
      await expect(engine.setTier2Verifier(await strict.getAddress(), MODEL))
        .to.emit(engine, "Tier2VerifierUpdated").withArgs(await strict.getAddress(), MODEL);
      await expect(tier2(RISKY)).to.be.revertedWithCustomError(engine, "InvalidZkProof");
    });

    it("feed age limits are configurable", async function () {
      await expect(engine.setMaxFeedAges(60, 60)).to.emit(engine, "MaxFeedAgesUpdated").withArgs(60, 60);
      await increaseTime(120);
      await expect(engine.currentFeatures(SAFE, PAST_ROUND)).to.be.revertedWithCustomError(engine, "StaleFeed");
    });
  });
});
