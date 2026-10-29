const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { deployTrustTier, increaseTime, now, PRICE, VOL, PAST_ROUND, ONE } = require("./helpers/fixture");

// Positions (collateral $2,000, liquidation threshold 0.80):
//   SAFE  LTV 0.50 -> delta 30%   WATCH LTV 0.70 -> delta 10%   RISKY LTV 0.93 -> delta -13%
describe("Incentives, consumer and robustness", function () {
  let t, engine, pool, priceFeed, MODEL, owner, other, challenger, keeper;
  const PROOF = ethers.toUtf8Bytes("mock-proof");
  const BOND = ethers.parseEther("0.01");
  const SAFE = 1, WATCH = 2, RISKY = 3;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const tier0 = (id, from = owner, value = BOND) => engine.connect(from).decideHeuristic(id, PAST_ROUND, { value });
  const tier2 = async (id, from = owner, label = 1) =>
    engine.connect(from).decideZkProof(id, PAST_ROUND, MODEL, PROOF, await t.inputs(id, label));
  const commitmentOf = (q, score, salt) =>
    ethers.keccak256(coder.encode(["uint256[]", "int256", "bytes32"], [q, score, salt]));

  beforeEach(async function () {
    [owner, other, challenger, keeper] = await ethers.getSigners();
    t = await deployTrustTier();
    ({ engine, pool, priceFeed } = t);
    MODEL = t.modelHash;
    await t.openPosition(SAFE, "0.50");
    await t.openPosition(WATCH, "0.70");
    await t.openPosition(RISKY, "0.93");
  });

  describe("gas-scaled bonds", function () {
    it("requires max(MIN_BOND, BOND_GAS_COVER * basefee)", async function () {
      const fee = ethers.parseUnits("40", "gwei"); // 1.5M gas * 40 gwei = 0.06 ETH
      await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x" + fee.toString(16)]);
      await expect(tier0(SAFE, owner, BOND)).to.be.revertedWithCustomError(engine, "InsufficientBond")
        .withArgs(SAFE, 1_500_000n * fee, BOND);
      await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x" + fee.toString(16)]);
      await expect(tier0(SAFE, owner, 1_500_000n * fee)).to.emit(engine, "SafeClaimRecorded");
      expect(await engine.bondOf(SAFE)).to.equal(1_500_000n * fee);
    });

    it("deposit-funded claims draw exactly the required bond", async function () {
      await engine.connect(other).deposit({ value: ethers.parseEther("1") });
      const fee = ethers.parseUnits("20", "gwei");
      await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x" + fee.toString(16)]);
      await engine.connect(other).decideHeuristic(SAFE, PAST_ROUND, { maxFeePerGas: fee * 2n });
      expect(await engine.bondOf(SAFE)).to.equal(1_500_000n * fee);
    });
  });

  describe("reward pool", function () {
    beforeEach(async function () {
      await engine.connect(keeper).fundRewards({ value: ethers.parseEther("0.01") });
      await engine.setClaimReward(ethers.parseEther("0.004"));
    });

    it("pays an honest claim on reclaim, once per position per cooldown", async function () {
      await tier0(SAFE, other);
      await increaseTime(3601);
      await priceFeed.updateAnswer(PRICE);
      await expect(engine.reclaimBond(SAFE)).to.emit(engine, "RewardPaid").withArgs(SAFE, other.address, ethers.parseEther("0.004"));
      expect(await engine.pendingWithdrawals(other.address)).to.equal(BOND + ethers.parseEther("0.004"));
      // a second claim on the same position inside the cooldown earns no reward
      await tier0(SAFE, other);
      await increaseTime(3601);
      await priceFeed.updateAnswer(PRICE);
      await expect(engine.reclaimBond(SAFE)).to.not.emit(engine, "RewardPaid");
    });

    it("pays when the next decision settles the claim, and never more than the pool holds", async function () {
      await tier0(SAFE, other);
      await increaseTime(3601);
      await priceFeed.updateAnswer(PRICE);
      await expect(tier0(SAFE)).to.emit(engine, "RewardPaid");
      await engine.setClaimReward(ethers.parseEther("1"));
      await increaseTime(3601);
      await priceFeed.updateAnswer(PRICE);
      await expect(engine.reclaimBond(SAFE)).to.not.emit(engine, "RewardPaid");
    });

    it("a slashed claim earns nothing", async function () {
      await tier0(SAFE, other);
      await engine.connect(challenger).challengeDecision(SAFE, MODEL, PROOF, await t.inputs(SAFE, 1));
      expect(await engine.rewardPool()).to.equal(ethers.parseEther("0.01"));
    });
  });

  describe("Tier-1 commitments must be opened", function () {
    const SALT = ethers.keccak256(ethers.toUtf8Bytes("salt"));

    async function commitWatch(score) {
      const q = await t.features(WATCH);
      await engine.connect(other).decideCommitment(WATCH, PAST_ROUND, MODEL, commitmentOf(q, score, SALT), { value: BOND });
      return q;
    }

    it("an honest opening lets the claimant reclaim the bond", async function () {
      const q = await commitWatch(120_000);
      await expect(engine.revealCommitment(WATCH, q, 120_000, SALT)).to.emit(engine, "CommitmentRevealed").withArgs(WATCH, 120_000);
      await expect(engine.revealCommitment(WATCH, q, 120_000, SALT)).to.be.revertedWithCustomError(engine, "AlreadyRevealed");
      await increaseTime(3601);
      await expect(engine.reclaimBond(WATCH)).to.emit(engine, "BondReclaimed").withArgs(WATCH, other.address, BOND);
    });

    it("a committed high-risk score contradicts the claim: bond forfeited, position re-opened", async function () {
      const q = await commitWatch(910_000);
      await expect(engine.revealCommitment(WATCH, q, 910_000, SALT))
        .to.emit(engine, "CommitmentContradicted").withArgs(WATCH, 910_000, BOND);
      expect(await engine.rewardPool()).to.equal(BOND);
      expect(await engine.positionFinalized(WATCH)).to.equal(false);
    });

    it("an unopened commitment is forfeited after the window", async function () {
      await commitWatch(120_000);
      await increaseTime(3601);
      await expect(engine.reclaimBond(WATCH)).to.emit(engine, "BondForfeited").withArgs(WATCH, other.address, BOND);
      expect(await engine.pendingWithdrawals(other.address)).to.equal(0);
      expect(await engine.rewardPool()).to.equal(BOND);
    });

    it("rejects openings with the wrong score, salt or features, and after the window", async function () {
      const q = await commitWatch(120_000);
      await expect(engine.revealCommitment(WATCH, q, 120_001, SALT)).to.be.revertedWithCustomError(engine, "BadReveal");
      await expect(engine.revealCommitment(WATCH, q, 120_000, ethers.ZeroHash)).to.be.revertedWithCustomError(engine, "BadReveal");
      await expect(engine.revealCommitment(SAFE, q, 120_000, SALT)).to.be.revertedWithCustomError(engine, "NotACommitmentClaim");
      await increaseTime(3601);
      await expect(engine.revealCommitment(WATCH, q, 120_000, SALT)).to.be.revertedWithCustomError(engine, "ChallengeWindowClosed");
    });
  });

  describe("commit-reveal challenges", function () {
    const commitmentFor = async (who, id) =>
      ethers.keccak256(coder.encode(["address", "uint256", "bytes32", "bytes32"],
        [who.address, id, await engine.featureSnapshot(id), ethers.keccak256(PROOF)]));

    it("a committed challenger slashes a block later; copying the proof is useless", async function () {
      await tier0(SAFE, other);
      const inputs = await t.inputs(SAFE, 1);
      await expect(engine.connect(challenger).commitChallenge(SAFE, await commitmentFor(challenger, SAFE)))
        .to.emit(engine, "ChallengeCommitted").withArgs(SAFE, challenger.address);
      // a front-runner who copies the proof can use neither path
      await expect(engine.connect(keeper).challengeDecision(SAFE, MODEL, PROOF, inputs))
        .to.be.revertedWithCustomError(engine, "ChallengeMustBeCommitted");
      await expect(engine.connect(keeper).revealChallenge(SAFE, MODEL, PROOF, inputs))
        .to.be.revertedWithCustomError(engine, "BadChallengeCommit");
      await expect(engine.connect(challenger).revealChallenge(SAFE, MODEL, PROOF, inputs))
        .to.emit(engine, "DecisionChallenged").withArgs(SAFE, challenger.address, BOND);
    });

    it("rejects a reveal in the commit's own block or with a different proof", async function () {
      await tier0(SAFE, other);
      const inputs = await t.inputs(SAFE, 1);
      await network.provider.send("evm_setAutomine", [false]);
      await engine.connect(challenger).commitChallenge(SAFE, await commitmentFor(challenger, SAFE));
      const sameBlock = await engine.connect(challenger).revealChallenge(SAFE, MODEL, PROOF, inputs, { gasLimit: 2_000_000 });
      await network.provider.send("evm_mine");
      await network.provider.send("evm_setAutomine", [true]);
      let mined = true;
      try { await sameBlock.wait(); } catch { mined = false; }
      expect(mined).to.equal(false); // reverted: the commit was in the same block
      await expect(engine.connect(challenger).revealChallenge(SAFE, MODEL, ethers.toUtf8Bytes("other"), inputs))
        .to.be.revertedWithCustomError(engine, "BadChallengeCommit");
    });

    it("cannot commit to an undecided position or after the window", async function () {
      await expect(engine.commitChallenge(SAFE, ethers.ZeroHash)).to.be.revertedWithCustomError(engine, "NotChallengeable");
      await tier0(SAFE, other);
      await increaseTime(3601);
      await expect(engine.commitChallenge(SAFE, ethers.ZeroHash)).to.be.revertedWithCustomError(engine, "ChallengeWindowClosed");
    });
  });

  describe("feature anchors for slow proofs", function () {
    it("accepts a proof on anchored features after the price moves against the borrower", async function () {
      await engine.anchorFeatures(RISKY, PAST_ROUND);
      const anchored = await t.inputs(RISKY, 1);
      await priceFeed.updateAnswer(1950n * 10n ** 8n); // worse for the borrower while proving
      await expect(engine.decideZkProof(RISKY, PAST_ROUND, MODEL, PROOF, anchored)).to.emit(engine, "LiquidationApproved");
    });

    it("rejects it if the position became safer, or once the anchor expired", async function () {
      await engine.anchorFeatures(RISKY, PAST_ROUND);
      const anchored = await t.inputs(RISKY, 1);
      await priceFeed.updateAnswer(2100n * 10n ** 8n); // recovery: safer than at the anchor
      await expect(engine.decideZkProof(RISKY, PAST_ROUND, MODEL, PROOF, anchored))
        .to.be.revertedWithCustomError(engine, "ProofNotForPosition");
      await priceFeed.updateAnswer(1950n * 10n ** 8n);
      await increaseTime(11 * 60);
      await priceFeed.updateAnswer(1950n * 10n ** 8n);
      await expect(engine.decideZkProof(RISKY, PAST_ROUND, MODEL, PROOF, anchored))
        .to.be.revertedWithCustomError(engine, "ProofNotForPosition");
    });
  });

  describe("TrustTierLiquidator (the consumer)", function () {
    let liq;
    beforeEach(async function () {
      liq = await (await ethers.getContractFactory("TrustTierLiquidator")).deploy(await engine.getAddress(), await pool.getAddress());
      await engine.setLiquidator(await liq.getAddress());
      await pool.setLiquidator(await liq.getAddress());
    });

    it("executes a soft liquidation only on an open Tier-2 approval, exactly once", async function () {
      await expect(liq.connect(keeper).liquidate(RISKY)).to.be.revertedWithCustomError(engine, "NoOpenApproval");
      await tier2(RISKY);
      const debt = (await pool.accounts(RISKY)).debtUsd;
      await expect(liq.connect(keeper).liquidate(RISKY))
        .to.emit(liq, "LiquidationExecuted")
        .and.to.emit(engine, "ApprovalConsumed").withArgs(RISKY, await liq.getAddress());
      const after = await pool.accounts(RISKY);
      expect(after.debtUsd).to.equal(debt / 2n);
      // 930 USD repaid * 1.05 / 2000 USD = 0.48825 collateral units
      expect(await pool.seizedCollateral(keeper.address, 0)).to.equal((ONE * 48825n) / 100000n);
      await expect(liq.connect(keeper).liquidate(RISKY)).to.be.revertedWithCustomError(engine, "NoOpenApproval");
    });

    it("an expired approval cannot be executed", async function () {
      await tier2(RISKY);
      await increaseTime(31 * 60);
      await expect(liq.liquidate(RISKY)).to.be.revertedWithCustomError(engine, "NoOpenApproval");
    });

    it("nobody but the liquidator can consume approvals or liquidate in the pool", async function () {
      await tier2(RISKY);
      await expect(engine.consumeApproval(RISKY)).to.be.revertedWithCustomError(engine, "NotLiquidator");
      await expect(pool.executeLiquidation(RISKY, owner.address)).to.be.revertedWithCustomError(pool, "NotLiquidator");
      await expect(pool.connect(other).setLiquidator(other.address)).to.be.revertedWithCustomError(pool, "NotOwner");
    });

    it("a pre-emptive liquidation of a WATCH position pulls it back from the boundary", async function () {
      await tier2(WATCH);
      await liq.liquidate(WATCH);
      const [, delta] = await engine.currentFeatures(WATCH, PAST_ROUND);
      expect(delta).to.be.greaterThan(1500n); // LTV 0.70 -> ~0.56: far from the boundary
      await expect(tier0(WATCH)).to.emit(engine, "SafeClaimRecorded"); // decidable again
    });
  });

  describe("feed robustness", function () {
    it("refuses features while an L2 sequencer is down or inside its grace period", async function () {
      const seq = await (await ethers.getContractFactory("MockPhasedAggregator")).deploy(0);
      const t0 = await now();
      await seq.setRound(1, 1, t0, t0, true); // down
      await engine.setSequencerUptimeFeed(await seq.getAddress());
      await expect(engine.currentFeatures(SAFE, PAST_ROUND)).to.be.revertedWithCustomError(engine, "SequencerDown");
      await seq.setRound(2, 0, t0, t0, true); // just came back up
      await expect(engine.currentFeatures(SAFE, PAST_ROUND)).to.be.revertedWithCustomError(engine, "SequencerDown");
      await seq.setRound(3, 0, t0 - 7200, t0, true);
      await expect(engine.currentFeatures(SAFE, PAST_ROUND)).to.not.be.reverted;
    });

    it("handles a Chainlink phase boundary in the 24-hour lookup", async function () {
      const f = await (await ethers.getContractFactory("MockPhasedAggregator")).deploy(8);
      const t0 = await now();
      const PHASE1_LAST = 100n, PHASE2_FIRST = (2n << 64n) + 1n;
      await f.setRound(PHASE1_LAST, 2200n * 10n ** 8n, t0 - 86400 - 600, t0 - 86400 - 600, false);
      await f.setRound(PHASE2_FIRST, PRICE, t0, t0, true);
      const vol = await (await ethers.getContractFactory("MockV3Aggregator")).deploy(8, "vol", VOL);
      await pool.addMarket(await f.getAddress(), await vol.getAddress(), 8000);
      await pool.openPosition(50, 1, ONE, 1000n * 10n ** 8n);
      // round 100 has no round 101 (its phase ended): accepted, it is within a heartbeat of the target
      const [q] = await engine.currentFeatures(50, PHASE1_LAST);
      expect(q[2]).to.equal(465n);
      // a much older last-of-phase round is rejected
      await f.setRound(7n, 2200n * 10n ** 8n, t0 - 3 * 86400, t0 - 3 * 86400, false);
      await expect(engine.currentFeatures(50, 7n)).to.be.revertedWithCustomError(engine, "BadMomentumRound");
    });
  });
});
