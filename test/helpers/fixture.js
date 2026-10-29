// Shared test fixture: a MockLendingPool market valued by a Chainlink-style
// price feed with a 24-hour history, a volatility feed, the TrustTier
// contracts wired to them, and helpers to open positions at a chosen LTV.
const { ethers, network } = require("hardhat");

const DAY = 24 * 60 * 60;
const PRICE = 2000n * 10n ** 8n;        // $2,000 per collateral unit, 8 decimals
const PRICE_24H_AGO = 2200n * 10n ** 8n; // price fell ~9.1% over 24 h
const VOL = 35n * 10n ** 8n;            // 35% realized volatility (percent, 8 decimals)
const ONE = 10n ** 18n;                 // one collateral unit
const MAX_PRICE_AGE = 3 * 60 * 60;
const MAX_VOL_AGE = 2 * DAY;
const PAST_ROUND = 1;                   // the price round in effect 24 h ago

async function increaseTime(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

async function now() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

/**
 * @param {object} opts
 *   verifier: "mock" (default) or a deployed verifier address
 *   modelHash: model bound to the verifier
 *   price, pricePast, vol: feed values
 */
async function deployTrustTier(opts = {}) {
  const modelHash = opts.modelHash || ethers.keccak256(ethers.toUtf8Bytes("risk-model-v1"));
  const Agg = await ethers.getContractFactory("MockV3Aggregator");
  // Round 1 (the "24 h ago" price), then 25 h later round 2 (current price).
  const priceFeed = await Agg.deploy(8, "COLL / USD", opts.pricePast ?? PRICE_24H_AGO);
  const volFeed = await Agg.deploy(8, "COLL 30d realized vol", opts.vol ?? VOL);
  await increaseTime(25 * 60 * 60);
  await priceFeed.updateAnswer(opts.price ?? PRICE);
  await volFeed.updateAnswer(opts.vol ?? VOL);

  const pool = await (await ethers.getContractFactory("MockLendingPool")).deploy();
  await pool.addMarket(await priceFeed.getAddress(), await volFeed.getAddress(), 8000);

  const registry = await (await ethers.getContractFactory("ModelRegistry")).deploy();
  const auditLog = await (await ethers.getContractFactory("TierAuditLog")).deploy();
  let verifierAddress = opts.verifier;
  let mockVerifier = null;
  if (!verifierAddress) {
    mockVerifier = await (await ethers.getContractFactory("MockTier2Verifier")).deploy();
    verifierAddress = await mockVerifier.getAddress();
  }
  const engine = await (await ethers.getContractFactory("LiquidationEngine")).deploy(
    await registry.getAddress(), await auditLog.getAddress(), verifierAddress, modelHash,
    await pool.getAddress(), MAX_PRICE_AGE, MAX_VOL_AGE
  );
  await auditLog.authorizeLogger(await engine.getAddress());
  await registry.registerModel(modelHash, "ipfs://risk-model");

  /** Open position `id` at the given LTV (as a decimal string), aged `ageDays`, last top-up `topupDays` ago. */
  async function openPosition(id, ltv, { ageDays = 200, topupDays = 5 } = {}) {
    const collateralUsd = (ONE * (opts.price ?? PRICE)) / ONE; // 1 unit of collateral
    const debtUsd = (collateralUsd * BigInt(Math.round(Number(ltv) * 10000))) / 10000n;
    await pool.openPosition(id, 0, ONE, debtUsd);
    const t = await now();
    await pool.setTimestamps(id, t - ageDays * DAY - 60, t - topupDays * DAY - 60);
    return id;
  }

  async function features(id) {
    const [q] = await engine.currentFeatures(id, PAST_ROUND);
    return q.map((x) => BigInt(x));
  }

  /** Public inputs [q..., label, P(low), P(high)] for the position's current features. */
  async function inputs(id, label = 1) {
    const q = await features(id);
    return [...q, BigInt(label), label ? 3n : 1021n, label ? 1021n : 3n];
  }

  return {
    engine, registry, auditLog, pool, priceFeed, volFeed, mockVerifier, modelHash,
    openPosition, features, inputs,
  };
}

module.exports = {
  deployTrustTier, increaseTime, now, DAY, PRICE, PRICE_24H_AGO, VOL, ONE, PAST_ROUND,
  MAX_PRICE_AGE, MAX_VOL_AGE,
};
