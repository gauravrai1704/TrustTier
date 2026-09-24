const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// The actual Weeks 3-5 milestone, end to end: LiquidationEngine wired to
// the REAL EZKL-generated verifier (not MockTier2Verifier), decideZkProof
// called with a REAL zk-SNARK proof and REAL public instances produced by
// the actual EZKL pipeline (circuits/build_circuit.py) against our actual
// risk_model.onnx. If this passes, a real Tier-2 decision has been
// verified on-chain using genuine zero-knowledge cryptography.
describe("LiquidationEngine + real EzklVerifier (Weeks 3-5 milestone)", function () {
  let registry, auditLog, realVerifier, engine;
  let owner;
  let proofBytes, instances, modelHash;

  before(function () {
    const calldataPath = path.join(__dirname, "..", "circuits", "calldata.bytes");
    const metadataPath = path.join(
      __dirname, "..", "off-chain", "risk_model", "artifacts", "model_metadata.json"
    );
    if (!fs.existsSync(calldataPath) || !fs.existsSync(metadataPath)) {
      this.skip(); // generated artifacts not present - skip gracefully
    }

    const calldata = "0x" + fs.readFileSync(calldataPath).toString("hex");
    const payload = "0x" + calldata.slice(10); // strip the 4-byte (8 hex char + 0x) selector
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["bytes", "uint256[]"], payload);
    proofBytes = decoded[0];
    instances = Array.from(decoded[1]); // decoded[1] is an immutable ethers Result - copy to a plain array

    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    modelHash = metadata.model_hash_keccak256;
  });

  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    registry = await ModelRegistry.deploy();

    const TierAuditLog = await ethers.getContractFactory("TierAuditLog");
    auditLog = await TierAuditLog.deploy();

    // The REAL verifier this time - not MockTier2Verifier.
    const RealVerifier = await ethers.getContractFactory("Halo2Verifier");
    realVerifier = await RealVerifier.deploy();

    const LiquidationEngine = await ethers.getContractFactory("LiquidationEngine");
    engine = await LiquidationEngine.deploy(
      await registry.getAddress(),
      await auditLog.getAddress(),
      await realVerifier.getAddress() // <-- the real verifier, wired in at deploy time
    );

    await auditLog.authorizeLogger(await engine.getAddress());
    await registry.registerModel(modelHash, "local://risk_model/artifacts/risk_model.onnx");
  });

  it("accepts a real zk-SNARK proof and approves the Tier-2 liquidation decision", async function () {
    await expect(engine.decideZkProof(9001, modelHash, proofBytes, instances))
      .to.emit(engine, "LiquidationApproved")
      .withArgs(9001, 2 /* Tier.ZkProof */, modelHash);
  });

  it("logs the decision to the audit trail with the correct model hash", async function () {
    await engine.decideZkProof(9002, modelHash, proofBytes, instances);
    const record = await auditLog.decisionByPosition(9002);
    expect(record.positionId).to.equal(9002);
    expect(record.tier).to.equal(2); // TierAuditLog.Tier.ZkProof
    expect(record.modelHash).to.equal(modelHash);
  });

  it("reports realistic end-to-end gas cost for a full Tier-2 decision", async function () {
    const tx = await engine.decideZkProof(9003, modelHash, proofBytes, instances);
    const receipt = await tx.wait();
    console.log(`      (full Tier-2 decideZkProof gas used: ${receipt.gasUsed})`);
    expect(receipt.status).to.equal(1);
  });

  it("still rejects an unregistered model even with a valid proof (integrity + authentication both required)", async function () {
    const unregisteredHash = ethers.keccak256(ethers.toUtf8Bytes("some-other-model"));
    await expect(
      engine.decideZkProof(9004, unregisteredHash, proofBytes, instances)
    ).to.be.revertedWithCustomError(engine, "ModelNotAuthorized");
  });

  it("demonstrates the mock -> real verifier swap: the same LiquidationEngine instance works with a hot-swapped verifier", async function () {
    // Deploy fresh with the mock first (as in Weeks 1-2)...
    const MockTier2Verifier = await ethers.getContractFactory("MockTier2Verifier");
    const mock = await MockTier2Verifier.deploy();

    const LiquidationEngine = await ethers.getContractFactory("LiquidationEngine");
    const freshEngine = await LiquidationEngine.deploy(
      await registry.getAddress(),
      await auditLog.getAddress(),
      await mock.getAddress()
    );
    await auditLog.authorizeLogger(await freshEngine.getAddress());

    // A garbage "proof" the mock happily accepts by default...
    await expect(
      freshEngine.decideZkProof(9005, modelHash, "0x1234", [1, 2, 3])
    ).to.not.be.reverted;

    // ...now hot-swap in the REAL verifier, exactly as the project plan
    // describes for this milestone. The garbage proof must now fail,
    // while our real proof must still succeed.
    await freshEngine.setTier2Verifier(await realVerifier.getAddress());

    await expect(
      freshEngine.decideZkProof(9006, modelHash, "0x1234", [1, 2, 3])
    ).to.be.reverted;

    await expect(
      freshEngine.decideZkProof(9007, modelHash, proofBytes, instances)
    ).to.not.be.reverted;
  });
});
