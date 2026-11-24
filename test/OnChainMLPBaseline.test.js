const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deployTrustTier, PAST_ROUND } = require("./helpers/fixture");

// The evaluation's baseline (Alhaidari et al., AFT 2025): TrustTier's own model
// run inside a contract. It must reach the same verdict as the proof on the
// circuit's sample positions, from the same on-chain features.
describe("OnChainMLPBaseline (on-chain inference baseline)", function () {
  let P, samples;
  before(function () {
    const p = path.join(__dirname, "..", "off-chain", "evaluation", "results", "baseline_params.json");
    const sp = path.join(__dirname, "..", "circuits", "samples.json");
    if (!fs.existsSync(p) || !fs.existsSync(sp)) this.skip();
    P = JSON.parse(fs.readFileSync(p, "utf8"));
    samples = JSON.parse(fs.readFileSync(sp, "utf8")).samples;
  });

  for (const name of ["high_risk", "low_risk", "watch_high"]) {
    it(`agrees with the proven label on the ${name} sample, from the engine's features`, async function () {
      const s = samples.find((x) => x.name === name);
      const t = await deployTrustTier({ price: BigInt(s.price_now), pricePast: BigInt(s.price_past),
        vol: BigInt(s.vol_answer), thresholdBps: s.liquidation_threshold_bps });
      await t.openPosition(1, (Number(s.debt_usd) / Number(s.collateral_usd)).toFixed(4),
        { ageDays: s.age_days, topupDays: s.topup_days_ago });
      const b = await (await ethers.getContractFactory("OnChainMLPBaseline")).deploy(await t.engine.getAddress());
      await b.setParams(P.layers, P.params.map(BigInt));
      const label = BigInt(s.public_inputs[6]) === 1n;
      await expect(b.decide(1, PAST_ROUND)).to.emit(b, "Classified");
      expect((await b.approvedAt(1)) > 0n).to.equal(label);
      const [high] = await b.classify(s.public_inputs.slice(1, 6).map(BigInt));
      expect(high).to.equal(label);
    });
  }

  it("only the owner sets the weights, and the shape must match", async function () {
    const [, other] = await ethers.getSigners();
    const b = await (await ethers.getContractFactory("OnChainMLPBaseline")).deploy(ethers.ZeroAddress);
    await expect(b.connect(other).setParams(P.layers, P.params.map(BigInt))).to.be.revertedWithCustomError(b, "NotOwner");
    await expect(b.setParams(P.layers, P.params.slice(1).map(BigInt))).to.be.revertedWithCustomError(b, "BadShape");
    await b.beginParams(P.layers);
    await b.appendParams(P.params.slice(0, 30).map(BigInt));
    await b.appendParams(P.params.slice(30).map(BigInt));
    expect(await b.params(56)).to.equal(BigInt(P.params[56]));
  });
});
