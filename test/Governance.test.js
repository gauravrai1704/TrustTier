const { expect } = require("chai");
const { ethers, network } = require("hardhat");

// Governance: TrustTierMultisig (2-of-3) is the only proposer/executor of
// TrustTierTimelock, which owns ModelRegistry, TierAuditLog and
// LiquidationEngine. Changing what the system trusts therefore needs two
// signatures AND a public delay.
describe("Governance (multisig + timelock)", function () {
  const DELAY = 3600; // 1 hour in these tests
  const MODEL = ethers.keccak256(ethers.toUtf8Bytes("risk-model-v1"));
  const ZERO_SALT = ethers.ZeroHash;
  let deployer, a, b, c, outsider;
  let multisig, timelock, registry, auditLog, engine, mock;

  beforeEach(async function () {
    [deployer, a, b, c, outsider] = await ethers.getSigners();
    multisig = await (await ethers.getContractFactory("TrustTierMultisig")).deploy([a.address, b.address, c.address], 2);
    const ms = await multisig.getAddress();
    timelock = await (await ethers.getContractFactory("TrustTierTimelock")).deploy(DELAY, [ms], [ms], ethers.ZeroAddress);

    registry = await (await ethers.getContractFactory("ModelRegistry")).deploy();
    auditLog = await (await ethers.getContractFactory("TierAuditLog")).deploy();
    mock = await (await ethers.getContractFactory("MockTier2Verifier")).deploy();
    const pool = await (await ethers.getContractFactory("MockLendingPool")).deploy();
    engine = await (await ethers.getContractFactory("LiquidationEngine")).deploy(
      await registry.getAddress(), await auditLog.getAddress(), await mock.getAddress(), MODEL,
      await pool.getAddress(), 3 * 3600, 2 * 86400
    );
    await auditLog.authorizeLogger(await engine.getAddress());
    await registry.registerModel(MODEL, "ipfs://v1");

    const tl = await timelock.getAddress();
    for (const owned of [registry, auditLog, engine]) {
      await owned.transferOwnership(tl);
    }
  });

  // Runs `fn` on the timelock through the multisig: owner a submits, b confirms, a executes.
  async function viaMultisig(timelockFn, args) {
    const data = timelock.interface.encodeFunctionData(timelockFn, args);
    const txId = await multisig.transactionCount();
    await multisig.connect(a).submit(await timelock.getAddress(), 0, data);
    await multisig.connect(b).confirm(txId);
    return multisig.connect(a).execute(txId);
  }

  async function scheduleAndExecute(targetContract, fnName, fnArgs) {
    const target = await targetContract.getAddress();
    const data = targetContract.interface.encodeFunctionData(fnName, fnArgs);
    await viaMultisig("schedule", [target, 0, data, ZERO_SALT, ZERO_SALT, DELAY]);
    await expect(viaMultisig("execute", [target, 0, data, ZERO_SALT, ZERO_SALT])).to.be.reverted; // too early
    await network.provider.send("evm_increaseTime", [DELAY + 1]);
    await network.provider.send("evm_mine");
    return viaMultisig("execute", [target, 0, data, ZERO_SALT, ZERO_SALT]);
  }

  describe("TrustTierMultisig", function () {
    it("rejects bad configurations", async function () {
      const F = await ethers.getContractFactory("TrustTierMultisig");
      await expect(F.deploy([], 1)).to.be.revertedWithCustomError(F, "InvalidOwners");
      await expect(F.deploy([a.address], 2)).to.be.revertedWithCustomError(F, "InvalidThreshold");
      await expect(F.deploy([a.address, a.address], 1)).to.be.revertedWithCustomError(F, "InvalidOwners");
    });

    it("only owners can submit, confirm or execute", async function () {
      await expect(multisig.connect(outsider).submit(outsider.address, 0, "0x"))
        .to.be.revertedWithCustomError(multisig, "NotOwner");
      await multisig.connect(a).submit(outsider.address, 0, "0x");
      await expect(multisig.connect(outsider).confirm(0)).to.be.revertedWithCustomError(multisig, "NotOwner");
      await expect(multisig.connect(outsider).execute(0)).to.be.revertedWithCustomError(multisig, "NotOwner");
    });

    it("needs threshold confirmations, counts each owner once, and executes only once", async function () {
      await multisig.connect(a).submit(outsider.address, 0, "0x");
      await expect(multisig.connect(a).confirm(0)).to.be.revertedWithCustomError(multisig, "AlreadyConfirmed");
      await expect(multisig.connect(a).execute(0))
        .to.be.revertedWithCustomError(multisig, "NotEnoughConfirmations").withArgs(0, 1, 2);
      await multisig.connect(b).confirm(0);
      await expect(multisig.connect(c).execute(0)).to.emit(multisig, "Executed").withArgs(0, c.address);
      await expect(multisig.connect(a).execute(0)).to.be.revertedWithCustomError(multisig, "TxAlreadyExecuted");
    });

    it("lets an owner revoke a confirmation before execution", async function () {
      await multisig.connect(a).submit(outsider.address, 0, "0x");
      await multisig.connect(b).confirm(0);
      await multisig.connect(b).revoke(0);
      await expect(multisig.connect(a).execute(0)).to.be.revertedWithCustomError(multisig, "NotEnoughConfirmations");
      await expect(multisig.connect(c).revoke(0)).to.be.revertedWithCustomError(multisig, "NotConfirmed");
    });

    it("bubbles up a failed call instead of marking it executed", async function () {
      const data = registry.interface.encodeFunctionData("revokeModel", [MODEL]); // multisig is not the owner
      await multisig.connect(a).submit(await registry.getAddress(), 0, data);
      await multisig.connect(b).confirm(0);
      await expect(multisig.connect(a).execute(0)).to.be.revertedWithCustomError(multisig, "ExecutionFailed");
      expect((await multisig.transactions(0)).executed).to.equal(false);
    });
  });

  describe("timelock owns the TrustTier contracts", function () {
    it("the deployer key alone can no longer change anything", async function () {
      await expect(engine.setTier2Verifier(outsider.address, MODEL))
        .to.be.revertedWithCustomError(engine, "OwnableUnauthorizedAccount");
      await expect(registry.revokeModel(MODEL)).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
      await expect(engine.setPositionSource(outsider.address))
        .to.be.revertedWithCustomError(engine, "OwnableUnauthorizedAccount");
      await expect(engine.setMaxFeedAges(1, 1))
        .to.be.revertedWithCustomError(engine, "OwnableUnauthorizedAccount");
    });

    it("a single multisig owner cannot schedule on the timelock directly", async function () {
      const data = engine.interface.encodeFunctionData("setTier2Verifier", [outsider.address, MODEL]);
      await expect(
        timelock.connect(a).schedule(await engine.getAddress(), 0, data, ZERO_SALT, ZERO_SALT, DELAY)
      ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    });

    it("refuses a delay shorter than the minimum", async function () {
      const data = engine.interface.encodeFunctionData("setTier2Verifier", [outsider.address, MODEL]);
      await expect(viaMultisig("schedule", [await engine.getAddress(), 0, data, ZERO_SALT, ZERO_SALT, DELAY - 1]))
        .to.be.reverted;
    });

    it("swaps the Tier-2 verifier only after 2-of-3 approval and the full delay", async function () {
      const newVerifier = await (await ethers.getContractFactory("MockTier2Verifier")).deploy();
      await expect(scheduleAndExecute(engine, "setTier2Verifier", [await newVerifier.getAddress(), MODEL]))
        .to.emit(engine, "Tier2VerifierUpdated");
      expect(await engine.tier2Verifier()).to.equal(await newVerifier.getAddress());
    });

    it("re-points the engine to a different lending protocol only through governance", async function () {
      const pool2 = await (await ethers.getContractFactory("MockLendingPool")).deploy();
      await expect(scheduleAndExecute(engine, "setPositionSource", [await pool2.getAddress()]))
        .to.emit(engine, "PositionSourceUpdated");
      expect(await engine.positionSource()).to.equal(await pool2.getAddress());
    });

    it("revokes a model only after approval and delay, so users see it coming", async function () {
      expect(await registry.isAuthorized(MODEL)).to.equal(true);
      await scheduleAndExecute(registry, "revokeModel", [MODEL]);
      expect(await registry.isAuthorized(MODEL)).to.equal(false);
    });
  });
});
