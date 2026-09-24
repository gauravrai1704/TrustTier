const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("TierAuditLog", function () {
  let auditLog, owner, logger, other;
  const MODEL_HASH = ethers.keccak256(ethers.toUtf8Bytes("risk-model-v1"));
  const EVIDENCE_REF = ethers.keccak256(ethers.toUtf8Bytes("some-proof-or-commitment"));

  // Tier enum order must match TierAuditLog.sol: Heuristic=0, Commitment=1, ZkProof=2
  const Tier = { Heuristic: 0, Commitment: 1, ZkProof: 2 };

  beforeEach(async function () {
    [owner, logger, other] = await ethers.getSigners();
    const TierAuditLog = await ethers.getContractFactory("TierAuditLog");
    auditLog = await TierAuditLog.deploy();
  });

  describe("logger authorization", function () {
    it("owner can authorize a logger", async function () {
      await auditLog.authorizeLogger(logger.address);
      expect(await auditLog.authorizedLoggers(logger.address)).to.equal(true);
    });

    it("emits LoggerAuthorized", async function () {
      await expect(auditLog.authorizeLogger(logger.address))
        .to.emit(auditLog, "LoggerAuthorized")
        .withArgs(logger.address);
    });

    it("owner can revoke a logger", async function () {
      await auditLog.authorizeLogger(logger.address);
      await auditLog.revokeLogger(logger.address);
      expect(await auditLog.authorizedLoggers(logger.address)).to.equal(false);
    });

    it("only the owner can authorize a logger", async function () {
      await expect(
        auditLog.connect(other).authorizeLogger(logger.address)
      ).to.be.revertedWithCustomError(auditLog, "OwnableUnauthorizedAccount");
    });
  });

  describe("logDecision", function () {
    it("reverts when called by an unauthorized address", async function () {
      await expect(
        auditLog.connect(other).logDecision(1, Tier.Heuristic, ethers.ZeroHash, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(auditLog, "NotAuthorizedLogger");
    });

    it("allows an authorized logger to record a decision", async function () {
      await auditLog.authorizeLogger(logger.address);
      await auditLog
        .connect(logger)
        .logDecision(1, Tier.ZkProof, MODEL_HASH, EVIDENCE_REF);

      expect(await auditLog.hasDecision(1)).to.equal(true);
      const record = await auditLog.decisionByPosition(1);
      expect(record.positionId).to.equal(1);
      expect(record.tier).to.equal(Tier.ZkProof);
      expect(record.modelHash).to.equal(MODEL_HASH);
      expect(record.evidenceRef).to.equal(EVIDENCE_REF);
    });

    it("emits DecisionLogged with the correct arguments", async function () {
      await auditLog.authorizeLogger(logger.address);
      await expect(
        auditLog.connect(logger).logDecision(42, Tier.Commitment, MODEL_HASH, EVIDENCE_REF)
      )
        .to.emit(auditLog, "DecisionLogged")
        .withArgs(42, Tier.Commitment, MODEL_HASH, EVIDENCE_REF, anyValue);
    });

    it("records multiple decisions across tiers, independently keyed by position", async function () {
      await auditLog.authorizeLogger(logger.address);
      await auditLog.connect(logger).logDecision(1, Tier.Heuristic, ethers.ZeroHash, ethers.ZeroHash);
      await auditLog.connect(logger).logDecision(2, Tier.Commitment, MODEL_HASH, EVIDENCE_REF);
      await auditLog.connect(logger).logDecision(3, Tier.ZkProof, MODEL_HASH, EVIDENCE_REF);

      expect((await auditLog.decisionByPosition(1)).tier).to.equal(Tier.Heuristic);
      expect((await auditLog.decisionByPosition(2)).tier).to.equal(Tier.Commitment);
      expect((await auditLog.decisionByPosition(3)).tier).to.equal(Tier.ZkProof);
      expect(await auditLog.hasDecision(1)).to.equal(true);
      expect(await auditLog.hasDecision(2)).to.equal(true);
      expect(await auditLog.hasDecision(3)).to.equal(true);
      // A position that was never decided should read as absent, not
      // confused with a zeroed-out Tier-0 record (which also has
      // modelHash=0, evidenceRef=0) - this is exactly why hasDecision exists.
      expect(await auditLog.hasDecision(999)).to.equal(false);
    });

    it("a second write to the same position overwrites the record (the finalization lock in LiquidationEngine is what actually prevents this in practice)", async function () {
      // TierAuditLog itself has no opinion on whether a position should be
      // written twice - that guarantee lives in LiquidationEngine's
      // positionFinalized lock (see LiquidationEngine.test.js). This test
      // just documents TierAuditLog's own storage behavior in isolation.
      await auditLog.authorizeLogger(logger.address);
      await auditLog.connect(logger).logDecision(1, Tier.Heuristic, ethers.ZeroHash, ethers.ZeroHash);
      await auditLog.connect(logger).logDecision(1, Tier.ZkProof, MODEL_HASH, EVIDENCE_REF);

      const record = await auditLog.decisionByPosition(1);
      expect(record.tier).to.equal(Tier.ZkProof);
    });

    it("a revoked logger can no longer log decisions", async function () {
      await auditLog.authorizeLogger(logger.address);
      await auditLog.revokeLogger(logger.address);
      await expect(
        auditLog.connect(logger).logDecision(1, Tier.Heuristic, ethers.ZeroHash, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(auditLog, "NotAuthorizedLogger");
    });
  });
});
