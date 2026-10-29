const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ModelRegistry", function () {
  let registry, owner, other;
  const MODEL_HASH_A = ethers.keccak256(ethers.toUtf8Bytes("risk-model-v1"));
  const MODEL_HASH_B = ethers.keccak256(ethers.toUtf8Bytes("risk-model-v2"));

  beforeEach(async function () {
    [owner, other] = await ethers.getSigners();
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    registry = await ModelRegistry.deploy();
  });

  describe("registerModel", function () {
    it("registers a new model and marks it authorized", async function () {
      await registry.registerModel(MODEL_HASH_A, "ipfs://model-a");
      expect(await registry.isAuthorized(MODEL_HASH_A)).to.equal(true);
      expect(await registry.modelURI(MODEL_HASH_A)).to.equal("ipfs://model-a");
      expect(await registry.registeredAt(MODEL_HASH_A)).to.be.gt(0);
    });

    it("emits ModelRegistered", async function () {
      await expect(registry.registerModel(MODEL_HASH_A, "ipfs://model-a"))
        .to.emit(registry, "ModelRegistered")
        .withArgs(MODEL_HASH_A, "ipfs://model-a", anyUint());
    });

    it("reverts on duplicate registration", async function () {
      await registry.registerModel(MODEL_HASH_A, "ipfs://model-a");
      await expect(
        registry.registerModel(MODEL_HASH_A, "ipfs://model-a-again")
      ).to.be.revertedWithCustomError(registry, "ModelAlreadyRegistered");
    });

    it("only the owner can register a model", async function () {
      await expect(
        registry.connect(other).registerModel(MODEL_HASH_A, "ipfs://model-a")
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("allows registering multiple distinct model versions", async function () {
      await registry.registerModel(MODEL_HASH_A, "ipfs://model-a");
      await registry.registerModel(MODEL_HASH_B, "ipfs://model-b");
      expect(await registry.isAuthorized(MODEL_HASH_A)).to.equal(true);
      expect(await registry.isAuthorized(MODEL_HASH_B)).to.equal(true);
    });
  });

  describe("revokeModel", function () {
    beforeEach(async function () {
      await registry.registerModel(MODEL_HASH_A, "ipfs://model-a");
    });

    it("revokes a registered model", async function () {
      await registry.revokeModel(MODEL_HASH_A);
      expect(await registry.isAuthorized(MODEL_HASH_A)).to.equal(false);
    });

    it("emits ModelRevoked", async function () {
      await expect(registry.revokeModel(MODEL_HASH_A))
        .to.emit(registry, "ModelRevoked")
        .withArgs(MODEL_HASH_A, anyUint());
    });

    it("reverts when revoking a never-registered model", async function () {
      await expect(
        registry.revokeModel(MODEL_HASH_B)
      ).to.be.revertedWithCustomError(registry, "ModelNotRegistered");
    });

    it("reverts with ModelAlreadyRevoked when revoking a model twice (no duplicate events)", async function () {
      await registry.revokeModel(MODEL_HASH_A);
      await expect(registry.revokeModel(MODEL_HASH_A))
        .to.be.revertedWithCustomError(registry, "ModelAlreadyRevoked")
        .withArgs(MODEL_HASH_A);
    });

    it("only the owner can revoke a model", async function () {
      await expect(
        registry.connect(other).revokeModel(MODEL_HASH_A)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("keeps registeredAt timestamp after revocation (history is preserved)", async function () {
      const registeredAtBefore = await registry.registeredAt(MODEL_HASH_A);
      await registry.revokeModel(MODEL_HASH_A);
      expect(await registry.registeredAt(MODEL_HASH_A)).to.equal(registeredAtBefore);
    });
  });

  describe("isValidModel", function () {
    it("returns false for an unregistered model", async function () {
      expect(await registry.isValidModel(MODEL_HASH_A)).to.equal(false);
    });

    it("returns true for a registered, non-revoked model", async function () {
      await registry.registerModel(MODEL_HASH_A, "ipfs://model-a");
      expect(await registry.isValidModel(MODEL_HASH_A)).to.equal(true);
    });
  });
});

// chai's anyValue matcher isn't bundled by default in this toolbox version;
// a tiny inline helper keeps the event-arg assertions above self-contained.
function anyUint() {
  const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
  return anyValue;
}
