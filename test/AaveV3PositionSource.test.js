const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployTrustTier, increaseTime, DAY, PAST_ROUND } = require("./helpers/fixture");

// The Aave V3 adapter: TrustTier reads collateral, debt and liquidation
// threshold straight from Aave's Pool.getUserAccountData, and observes
// account age and top-ups from the aToken's scaled balance.
describe("AaveV3PositionSource", function () {
  let t, aave, source, alice, bob, keeper;
  const USD = (x) => BigInt(Math.round(x * 1e8));
  const BOND = ethers.parseEther("0.01");

  beforeEach(async function () {
    [, alice, bob, keeper] = await ethers.getSigners();
    t = await deployTrustTier();
    aave = await (await ethers.getContractFactory("MockAavePool")).deploy();
    source = await (await ethers.getContractFactory("AaveV3PositionSource")).deploy(
      await aave.getAddress(), await aave.getAddress(),
      await t.priceFeed.getAddress(), await t.volFeed.getAddress()
    );
    await t.engine.setPositionSource(await source.getAddress());
    // alice: $10,000 collateral, $9,300 debt, threshold 80% -> LTV 0.93
    await aave.set(alice.address, USD(10000), USD(9300), 8000, 5n * 10n ** 18n);
    // bob: $10,000 collateral, $3,000 debt -> LTV 0.30
    await aave.set(bob.address, USD(10000), USD(3000), 8000, 5n * 10n ** 18n);
  });

  it("registers accounts with collateral, in order, once", async function () {
    await expect(source.connect(keeper).register(alice.address)).to.emit(source, "Registered").withArgs(0, alice.address);
    await source.register(bob.address);
    expect(await source.positionIdOf(alice.address)).to.equal(1); // 1-based
    expect(await source.userOf(1)).to.equal(bob.address);
    await expect(source.register(alice.address)).to.be.revertedWithCustomError(source, "AlreadyRegistered");
    await expect(source.register(keeper.address)).to.be.revertedWithCustomError(source, "NoCollateral");
    await expect(source.getPosition(5)).to.be.revertedWithCustomError(source, "UnknownPosition");
  });

  it("reports Aave's account data and the reference feeds", async function () {
    await source.register(alice.address);
    const p = await source.getPosition(0);
    expect(p.collateralUsd).to.equal(USD(10000));
    expect(p.debtUsd).to.equal(USD(9300));
    expect(p.liquidationThresholdBps).to.equal(8000);
    expect(p.priceFeed).to.equal(await t.priceFeed.getAddress());
    expect(p.volatilityFeed).to.equal(await t.volFeed.getAddress());
    expect(p.openedAt).to.equal(p.lastTopUpAt);
  });

  it("the engine computes features and delta from Aave data", async function () {
    await source.register(alice.address);
    const [q, delta] = await t.engine.currentFeatures(0, PAST_ROUND);
    expect(q[0]).to.equal(634n); // LTV 0.93, same as the MockLendingPool test
    expect(q[3]).to.equal(0n);   // just registered
    expect(delta).to.equal(-1300n);
  });

  it("poke records a top-up only when the scaled balance grows", async function () {
    await source.register(alice.address);
    await increaseTime(10 * DAY);
    await source.poke(0); // no change
    let p = await source.getPosition(0);
    expect(p.lastTopUpAt).to.equal(p.openedAt);

    await aave.set(alice.address, USD(12000), USD(9300), 8000, 6n * 10n ** 18n);
    await expect(source.connect(keeper).poke(0)).to.emit(source, "TopUpObserved");
    p = await source.getPosition(0);
    expect(p.lastTopUpAt).to.be.greaterThan(p.openedAt);

    // a withdrawal lowers the balance: no top-up, and the new lower balance is the baseline
    const before = p.lastTopUpAt;
    await aave.set(alice.address, USD(9000), USD(9300), 8000, 4n * 10n ** 18n);
    await source.poke(0);
    expect((await source.getPosition(0)).lastTopUpAt).to.equal(before);
  });

  it("enforces tiers on Aave positions: safe accounts can use Tier 0, risky ones only Tier 2", async function () {
    await source.register(alice.address);
    await source.register(bob.address);
    await expect(t.engine.decideHeuristic(1, PAST_ROUND, { value: BOND })).to.emit(t.engine, "SafeClaimRecorded");
    await expect(t.engine.decideHeuristic(0, PAST_ROUND, { value: BOND }))
      .to.be.revertedWithCustomError(t.engine, "TierNotAllowed");
    await expect(t.engine.decideZkProof(0, PAST_ROUND, t.modelHash, "0x01", await t.inputs(0, 1)))
      .to.emit(t.engine, "LiquidationApproved");
  });
});
