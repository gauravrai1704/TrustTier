const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("LiquidationEngine", function () {
  let registry, auditLog, mockVerifier, engine;
  let owner, other;

  const MODEL_HASH = ethers.keccak256(ethers.toUtf8Bytes("risk-model-v1"));
  const UNREGISTERED_MODEL_HASH = ethers.keccak256(ethers.toUtf8Bytes("unregistered-model"));
  const COMMITMENT_HASH = ethers.keccak256(ethers.toUtf8Bytes("input-output-commitment"));

  // Mirrors LiquidationEngine.Tier / TierAuditLog.Tier ordering.
  const Tier = { Heuristic: 0, Commitment: 1, ZkProof: 2 };

  // A stand-in "proof" - opaque bytes as far as the contract is concerned
  // at this stage, since MockTier2Verifier doesn't actually check it.
  const DUMMY_PROOF = ethers.toUtf8Bytes("dummy-zk-proof-bytes");
  const DUMMY_PUBLIC_INPUTS = [1, 2, 3];

  beforeEach(async function () {
    [owner, other] = await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    registry = await ModelRegistry.deploy();

    const TierAuditLog = await ethers.getContractFactory("TierAuditLog");
    auditLog = await TierAuditLog.deploy();

    const MockTier2Verifier = await ethers.getContractFactory("MockTier2Verifier");
    mockVerifier = await MockTier2Verifier.deploy();

    const LiquidationEngine = await ethers.getContractFactory("LiquidationEngine");
    engine = await LiquidationEngine.deploy(
      await registry.getAddress(),
      await auditLog.getAddress(),
      await mockVerifier.getAddress()
    );

    // Wire permissions: the engine is the only contract allowed to write
    // to the audit log.
    await auditLog.authorizeLogger(await engine.getAddress());

    // Register the model version used across most tests.
    await registry.registerModel(MODEL_HASH, "ipfs://risk-model-v1");
  });

  describe("deployment wiring", function () {
    it("stores the correct registry, audit log, and verifier addresses", async function () {
      expect(await engine.modelRegistry()).to.equal(await registry.getAddress());
      expect(await engine.auditLog()).to.equal(await auditLog.getAddress());
      expect(await engine.tier2Verifier()).to.equal(await mockVerifier.getAddress());
    });
  });

  describe("Tier 0 - decideHeuristic", function () {
    it("approves the liquidation without requiring any model", async function () {
      await expect(engine.decideHeuristic(1))
        .to.emit(engine, "LiquidationApproved")
        .withArgs(1, Tier.Heuristic, ethers.ZeroHash);
    });

    it("logs the decision to the audit trail with a zero model hash and zero evidence ref", async function () {
      await engine.decideHeuristic(7);
      const record = await auditLog.decisionByPosition(7);
      expect(record.tier).to.equal(Tier.Heuristic);
      expect(record.modelHash).to.equal(ethers.ZeroHash);
      expect(record.evidenceRef).to.equal(ethers.ZeroHash);
    });

    it("can be called by anyone (no model gate at this tier)", async function () {
      await expect(engine.connect(other).decideHeuristic(1)).to.not.be.reverted;
    });
  });

  describe("Tier 1 - decideCommitment", function () {
    it("approves the liquidation when the model is registered and a commitment is provided", async function () {
      await expect(engine.decideCommitment(2, MODEL_HASH, COMMITMENT_HASH))
        .to.emit(engine, "LiquidationApproved")
        .withArgs(2, Tier.Commitment, MODEL_HASH);
    });

    it("stores the commitment hash for later probabilistic audit", async function () {
      await engine.decideCommitment(2, MODEL_HASH, COMMITMENT_HASH);
      expect(await engine.tier1Commitments(2)).to.equal(COMMITMENT_HASH);
    });

    it("logs the decision with the model hash and commitment as evidence ref", async function () {
      await engine.decideCommitment(3, MODEL_HASH, COMMITMENT_HASH);
      const record = await auditLog.decisionByPosition(3);
      expect(record.tier).to.equal(Tier.Commitment);
      expect(record.modelHash).to.equal(MODEL_HASH);
      expect(record.evidenceRef).to.equal(COMMITMENT_HASH);
    });

    it("reverts if the model is not registered", async function () {
      await expect(
        engine.decideCommitment(2, UNREGISTERED_MODEL_HASH, COMMITMENT_HASH)
      )
        .to.be.revertedWithCustomError(engine, "ModelNotAuthorized")
        .withArgs(UNREGISTERED_MODEL_HASH);
    });

    it("reverts if the model was registered but has since been revoked", async function () {
      await registry.revokeModel(MODEL_HASH);
      await expect(
        engine.decideCommitment(2, MODEL_HASH, COMMITMENT_HASH)
      ).to.be.revertedWithCustomError(engine, "ModelNotAuthorized");
    });

    it("reverts if the commitment hash is zero", async function () {
      await expect(
        engine.decideCommitment(2, MODEL_HASH, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(engine, "CommitmentRequired");
    });
  });

  describe("Tier 2 - decideZkProof", function () {
    it("approves the liquidation when the model is registered and the mock verifier accepts the proof", async function () {
      // MockTier2Verifier.shouldVerify defaults to true
      await expect(
        engine.decideZkProof(4, MODEL_HASH, DUMMY_PROOF, DUMMY_PUBLIC_INPUTS)
      )
        .to.emit(engine, "LiquidationApproved")
        .withArgs(4, Tier.ZkProof, MODEL_HASH);
    });

    it("logs the decision with the model hash and keccak256(proof) as evidence ref", async function () {
      await engine.decideZkProof(4, MODEL_HASH, DUMMY_PROOF, DUMMY_PUBLIC_INPUTS);
      const record = await auditLog.decisionByPosition(4);
      expect(record.tier).to.equal(Tier.ZkProof);
      expect(record.modelHash).to.equal(MODEL_HASH);
      expect(record.evidenceRef).to.equal(ethers.keccak256(DUMMY_PROOF));
    });

    it("reverts if the model is not registered", async function () {
      await expect(
        engine.decideZkProof(4, UNREGISTERED_MODEL_HASH, DUMMY_PROOF, DUMMY_PUBLIC_INPUTS)
      )
        .to.be.revertedWithCustomError(engine, "ModelNotAuthorized")
        .withArgs(UNREGISTERED_MODEL_HASH);
    });

    it("reverts when the mock verifier is configured to reject the proof (simulates an invalid zk-SNARK)", async function () {
      await mockVerifier.setShouldVerify(false);
      await expect(
        engine.decideZkProof(4, MODEL_HASH, DUMMY_PROOF, DUMMY_PUBLIC_INPUTS)
      )
        .to.be.revertedWithCustomError(engine, "InvalidZkProof")
        .withArgs(4);
    });

    it("supports per-proof overrides so a single test can mix valid and invalid proofs", async function () {
      const badProof = ethers.toUtf8Bytes("a-bad-proof");
      await mockVerifier.setOverrideForProof(badProof, false);

      // The good proof (default shouldVerify = true) still succeeds...
      await expect(
        engine.decideZkProof(5, MODEL_HASH, DUMMY_PROOF, DUMMY_PUBLIC_INPUTS)
      ).to.not.be.reverted;

      // ...while the overridden bad proof fails, in the same test run.
      await expect(
        engine.decideZkProof(6, MODEL_HASH, badProof, DUMMY_PUBLIC_INPUTS)
      ).to.be.revertedWithCustomError(engine, "InvalidZkProof");
    });
  });

  describe("swapping the Tier-2 verifier (mock -> future EZKL verifier)", function () {
    it("only the owner can update the verifier address", async function () {
      await expect(
        engine.connect(other).setTier2Verifier(other.address)
      ).to.be.revertedWithCustomError(engine, "OwnableUnauthorizedAccount");
    });

    it("emits Tier2VerifierUpdated and updates subsequent verification calls", async function () {
      const MockTier2Verifier = await ethers.getContractFactory("MockTier2Verifier");
      const newVerifier = await MockTier2Verifier.deploy();
      await newVerifier.setShouldVerify(false); // the "new" verifier rejects everything

      await expect(engine.setTier2Verifier(await newVerifier.getAddress()))
        .to.emit(engine, "Tier2VerifierUpdated")
        .withArgs(await newVerifier.getAddress());

      expect(await engine.tier2Verifier()).to.equal(await newVerifier.getAddress());

      // Now that the strict verifier is wired in, the same proof that used
      // to pass against the old (permissive) mock should now fail - this is
      // exactly the swap that will happen in Weeks 3-5 when the real EZKL
      // verifier replaces MockTier2Verifier.
      await expect(
        engine.decideZkProof(9, MODEL_HASH, DUMMY_PROOF, DUMMY_PUBLIC_INPUTS)
      ).to.be.revertedWithCustomError(engine, "InvalidZkProof");
    });
  });

  describe("end-to-end mocked flow across all three tiers (Week 1-2 milestone)", function () {
    it("routes three different positions through Tier 0, Tier 1, and Tier 2 respectively, all logged correctly", async function () {
      await engine.decideHeuristic(100);
      await engine.decideCommitment(101, MODEL_HASH, COMMITMENT_HASH);
      await engine.decideZkProof(102, MODEL_HASH, DUMMY_PROOF, DUMMY_PUBLIC_INPUTS);

      expect(await auditLog.hasDecision(100)).to.equal(true);
      expect(await auditLog.hasDecision(101)).to.equal(true);
      expect(await auditLog.hasDecision(102)).to.equal(true);

      const r0 = await auditLog.decisionByPosition(100);
      const r1 = await auditLog.decisionByPosition(101);
      const r2 = await auditLog.decisionByPosition(102);

      expect(r0.positionId).to.equal(100);
      expect(r0.tier).to.equal(Tier.Heuristic);

      expect(r1.positionId).to.equal(101);
      expect(r1.tier).to.equal(Tier.Commitment);
      expect(r1.evidenceRef).to.equal(COMMITMENT_HASH);

      expect(r2.positionId).to.equal(102);
      expect(r2.tier).to.equal(Tier.ZkProof);
      expect(r2.evidenceRef).to.equal(ethers.keccak256(DUMMY_PROOF));
    });
  });

  describe("per-position finalization lock (concurrency / consistency)", function () {
    it("marks a position finalized after any successful decision", async function () {
      expect(await engine.positionFinalized(50)).to.equal(false);
      await engine.decideHeuristic(50);
      expect(await engine.positionFinalized(50)).to.equal(true);
    });

    it("rejects a second decision for the same position, regardless of tier (Tier 0 then Tier 0)", async function () {
      await engine.decideHeuristic(51);
      await expect(engine.decideHeuristic(51))
        .to.be.revertedWithCustomError(engine, "PositionAlreadyFinalized")
        .withArgs(51);
    });

    it("rejects a second decision even when the second attempt uses a different, stronger tier (Tier 0 then Tier 2)", async function () {
      // This is the exact race the lock exists to prevent: one liquidator
      // bot submits a cheap Tier-0 heuristic decision, another
      // simultaneously submits a Tier-2 zk-proof decision for the same
      // position. Whichever lands first wins; the second must revert
      // rather than silently overwriting the audit trail.
      await engine.decideHeuristic(52);
      await expect(
        engine.decideZkProof(52, MODEL_HASH, DUMMY_PROOF, DUMMY_PUBLIC_INPUTS)
      ).to.be.revertedWithCustomError(engine, "PositionAlreadyFinalized");
    });

    it("rejects a second decision even when the second attempt uses a weaker tier (Tier 2 then Tier 0)", async function () {
      await engine.decideZkProof(53, MODEL_HASH, DUMMY_PROOF, DUMMY_PUBLIC_INPUTS);
      await expect(
        engine.decideHeuristic(53)
      ).to.be.revertedWithCustomError(engine, "PositionAlreadyFinalized");
    });

    it("rejects a second Commitment decision for the same position", async function () {
      await engine.decideCommitment(54, MODEL_HASH, COMMITMENT_HASH);
      await expect(
        engine.decideCommitment(54, MODEL_HASH, COMMITMENT_HASH)
      ).to.be.revertedWithCustomError(engine, "PositionAlreadyFinalized");
    });

    it("still allows different positions to be decided independently after one is finalized", async function () {
      await engine.decideHeuristic(60);
      // Position 61 is unrelated and must be unaffected by 60's finalization.
      await expect(engine.decideHeuristic(61)).to.not.be.reverted;
    });

    it("does not finalize a position on a reverted attempt (e.g. an invalid proof)", async function () {
      // If decideZkProof reverts because the proof is invalid, that
      // shouldn't burn the position's one shot - a corrected resubmission
      // for the same position must still be possible.
      await mockVerifier.setShouldVerify(false);
      await expect(
        engine.decideZkProof(70, MODEL_HASH, DUMMY_PROOF, DUMMY_PUBLIC_INPUTS)
      ).to.be.reverted;
      expect(await engine.positionFinalized(70)).to.equal(false);

      await mockVerifier.setShouldVerify(true);
      await expect(
        engine.decideZkProof(70, MODEL_HASH, DUMMY_PROOF, DUMMY_PUBLIC_INPUTS)
      ).to.not.be.reverted;
    });
  });
});
