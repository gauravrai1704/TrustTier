// Deploys the full TrustTier stack to whichever network Hardhat is pointed at.
//
// What it does, in order:
//   1. The position source the engine reads features from:
//      - default: MockLendingPool with three demo markets (ETH, WBTC, LINK),
//        each valued by Chainlink-compatible price and realized-volatility
//        feeds that are seeded with a 24-hour price history;
//      - AAVE_POOL + AAVE_ATOKEN + PRICE_FEED + VOL_FEED set: the
//        AaveV3PositionSource adapter over a real Aave V3 pool and real
//        Chainlink feeds (e.g. on Sepolia or a mainnet fork).
//      PRICE_FEED and/or VOL_FEED alone replace market 0's mock feeds with real ones.
//   2. ModelRegistry, TierAuditLog, the Tier-2 verifier (mock or real) and
//      LiquidationEngine (bound to the trained model's hash and the source).
//   3. Authorizes the engine as the audit-log writer and registers the model
//      (off-chain/risk_model/artifacts/model_metadata.json). There is no
//      feature oracle: the engine computes every feature itself.
//      With the demo pool, deploys TrustTierLiquidator - the only path that
//      can liquidate a pool position, and only on a Tier-2 approval - and
//      optionally funds claim rewards (CLAIM_REWARD_ETH, REWARD_FUND_ETH).
//   4. Optionally hands every contract to governance: a TrustTierMultisig
//      (M-of-N) that is the only proposer/executor of a TrustTierTimelock,
//      which becomes the owner of all three contracts.
//
// Verifier choice (VERIFIER_MODE):
//   - "mock" by default on hardhat/localhost (fast local demos and tests),
//   - "real" by default everywhere else (Sepolia demonstrates genuine
//     zk-SNARK verification). Override with VERIFIER_MODE=mock|real.
//
// Feed staleness limits: MAX_PRICE_AGE (default 3 h) and MAX_VOL_AGE (default 2 days).
//
// Governance (all optional; enabled when GOVERNANCE_OWNERS is set):
//   GOVERNANCE_OWNERS=0xA,0xB,0xC   multisig owners
//   GOVERNANCE_THRESHOLD=2           confirmations needed (default: majority)
//   TIMELOCK_DELAY=86400             seconds every admin change must wait (default 1 day)
//
// Usage:
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/deploy.js --network sepolia
//   VERIFIER_MODE=real GOVERNANCE_OWNERS=0xA,0xB,0xC npx hardhat run scripts/deploy.js --network localhost

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const METADATA_PATH = path.join(__dirname, "..", "off-chain", "risk_model", "artifacts", "model_metadata.json");

function writeDeploymentManifest(networkName, contracts, extra) {
  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${networkName}.json`);
  const manifest = { network: networkName, ...extra, contracts: {} };
  for (const [name, { address, artifactName }] of Object.entries(contracts)) {
    const artifact = hre.artifacts.readArtifactSync(artifactName);
    manifest.contracts[name] = { address, abi: artifact.abi };
  }
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`\nWrote deployment manifest to ${outPath}`);
}

async function deployed(name, ...args) {
  const c = await (await hre.ethers.getContractFactory(name)).deploy(...args);
  await c.waitForDeployment();
  console.log(`${name} deployed to:`, await c.getAddress());
  return c;
}

async function send(label, txPromise) {
  const receipt = await (await txPromise).wait();
  console.log(`${label} (gas ${receipt.gasUsed})`);
  return receipt;
}

async function main() {
  const networkName = hre.network.name;
  const localNetworks = new Set(["hardhat", "localhost"]);
  const verifierMode = (process.env.VERIFIER_MODE || (localNetworks.has(networkName) ? "mock" : "real")).toLowerCase();
  if (!["mock", "real"].includes(verifierMode)) {
    throw new Error(`VERIFIER_MODE must be "mock" or "real", got "${verifierMode}"`);
  }
  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deploying TrustTier to "${networkName}" from ${deployer.address} (verifier: ${verifierMode})`);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Deployer balance: ${hre.ethers.formatEther(balance)} ETH`);
  if (balance === 0n) {
    throw new Error("Deployer has no ETH. On Sepolia, fund it from a faucet first.");
  }

  let modelHash = process.env.MODEL_HASH || hre.ethers.ZeroHash;
  if (!process.env.MODEL_HASH && fs.existsSync(METADATA_PATH)) {
    modelHash = JSON.parse(fs.readFileSync(METADATA_PATH, "utf8")).model_hash_keccak256;
  }
  if (modelHash === hre.ethers.ZeroHash) {
    console.warn("WARNING: no model hash found - train the model first (python -m risk_model.train).");
  }

  // 1. Position source and feeds
  const H = 3600;
  const now = (await hre.ethers.provider.getBlock("latest")).timestamp;
  const MARKETS = [
    // name, price now, price 24 h ago (8 dp), realized volatility %, liquidation threshold (bps)
    { name: "ETH", price: 2000, past: 2200, vol: 35, thresholdBps: 8000 },
    { name: "WBTC", price: 60000, past: 59000, vol: 20, thresholdBps: 7500 },
    { name: "LINK", price: 15, past: 14, vol: 60, thresholdBps: 7000 },
  ];
  const e8 = (x) => BigInt(Math.round(x * 1e8));

  async function mockFeed(description, past, current) {
    // Round 1 = the price 25 h ago, round 2 = now: momentum works immediately.
    const f = await deployed("MockV3Aggregator", 8, description, e8(past));
    await (await f.setRoundTimestamp(1, now - 25 * H)).wait();
    await (await f.updateAnswer(e8(current))).wait();
    return f;
  }

  const markets = [];
  const contracts = {};
  let source, sourceArtifact, pool = null;
  if (process.env.AAVE_POOL) {
    for (const v of ["AAVE_ATOKEN", "PRICE_FEED", "VOL_FEED"]) {
      if (!process.env[v]) throw new Error(`AAVE_POOL is set: ${v} is required too`);
    }
    source = await deployed("AaveV3PositionSource", process.env.AAVE_POOL, process.env.AAVE_ATOKEN,
      process.env.PRICE_FEED, process.env.VOL_FEED);
    sourceArtifact = "AaveV3PositionSource";
    markets.push({ id: 0, name: "Aave V3", priceFeed: process.env.PRICE_FEED, volatilityFeed: process.env.VOL_FEED,
      thresholdBps: null, mockPriceFeed: false, mockVolatilityFeed: false });
  } else {
    pool = await deployed("MockLendingPool");
    for (const [i, m] of MARKETS.entries()) {
      // Market 0 can use real Chainlink feeds (e.g. ETH/USD on Sepolia); a
      // realized-volatility feed may not exist on a testnet, so each is optional.
      const realPrice = i === 0 && process.env.PRICE_FEED;
      const realVol = i === 0 && process.env.VOL_FEED;
      const priceFeed = realPrice ? process.env.PRICE_FEED
        : await (await mockFeed(`${m.name} / USD`, m.past, m.price)).getAddress();
      const volFeed = realVol ? process.env.VOL_FEED
        : await (await deployed("MockV3Aggregator", 8, `${m.name} 30d realized volatility`, e8(m.vol))).getAddress();
      await send(`Market ${i} (${m.name}) added`, pool.addMarket(priceFeed, volFeed, m.thresholdBps));
      markets.push({ id: i, name: m.name, priceFeed, volatilityFeed: volFeed, thresholdBps: m.thresholdBps,
        mockPriceFeed: !realPrice, mockVolatilityFeed: !realVol });
    }
    source = pool;
    sourceArtifact = "MockLendingPool";
    contracts.MockLendingPool = { address: await pool.getAddress(), artifactName: "MockLendingPool" };
  }

  // 2. Contracts
  const maxPriceAge = Number(process.env.MAX_PRICE_AGE || 3 * H);
  const maxVolAge = Number(process.env.MAX_VOL_AGE || 48 * H);
  const registry = await deployed("ModelRegistry");
  const auditLog = await deployed("TierAuditLog");
  const verifierArtifactName = verifierMode === "mock" ? "MockTier2Verifier" : "Halo2Verifier";
  const verifier = await deployed(verifierArtifactName);
  const engine = await deployed(
    "LiquidationEngine",
    await registry.getAddress(), await auditLog.getAddress(), await verifier.getAddress(), modelHash,
    await source.getAddress(), maxPriceAge, maxVolAge
  );

  // 3. Wiring
  await send("Authorized LiquidationEngine as audit-log writer", auditLog.authorizeLogger(await engine.getAddress()));
  if (modelHash !== hre.ethers.ZeroHash) {
    await send(`Registered model ${modelHash}`, registry.registerModel(modelHash, "local://risk_model/artifacts/risk_model.onnx"));
  }
  let liquidatorContract = null;
  if (pool) {
    liquidatorContract = await deployed("TrustTierLiquidator", await engine.getAddress(), await pool.getAddress());
    const la = await liquidatorContract.getAddress();
    await send("Engine: liquidator set", engine.setLiquidator(la));
    await send("Pool: liquidator set", pool.setLiquidator(la));
  }
  const claimReward = process.env.CLAIM_REWARD_ETH ?? (localNetworks.has(networkName) ? "0.002" : "0");
  const rewardFund = process.env.REWARD_FUND_ETH ?? (localNetworks.has(networkName) ? "1" : "0");
  if (Number(claimReward) > 0) {
    await send(`Claim reward set to ${claimReward} ETH`, engine.setClaimReward(hre.ethers.parseEther(claimReward)));
  }
  if (Number(rewardFund) > 0) {
    await send(`Reward pool funded with ${rewardFund} ETH`, engine.fundRewards({ value: hre.ethers.parseEther(rewardFund) }));
  }

  Object.assign(contracts, {
    ModelRegistry: { address: await registry.getAddress(), artifactName: "ModelRegistry" },
    TierAuditLog: { address: await auditLog.getAddress(), artifactName: "TierAuditLog" },
    Tier2Verifier: { address: await verifier.getAddress(), artifactName: verifierArtifactName },
    LiquidationEngine: { address: await engine.getAddress(), artifactName: "LiquidationEngine" },
    PositionSource: { address: await source.getAddress(), artifactName: sourceArtifact },
  });
  if (liquidatorContract) {
    contracts.TrustTierLiquidator = { address: await liquidatorContract.getAddress(), artifactName: "TrustTierLiquidator" };
  }
  const extra = {
    verifierMode, modelHash, positionSource: sourceArtifact, markets,
    maxPriceAge, maxVolatilityAge: maxVolAge,
    aggregatorAbi: hre.artifacts.readArtifactSync("MockV3Aggregator").abi,
    governance: null,
  };

  // 3. Governance hand-over (optional)
  if (process.env.GOVERNANCE_OWNERS) {
    const owners = process.env.GOVERNANCE_OWNERS.split(",").map((s) => s.trim()).filter(Boolean);
    const threshold = Number(process.env.GOVERNANCE_THRESHOLD || Math.floor(owners.length / 2) + 1);
    const delay = Number(process.env.TIMELOCK_DELAY || 86400);
    const multisig = await deployed("TrustTierMultisig", owners, threshold);
    const ms = await multisig.getAddress();
    const timelock = await deployed("TrustTierTimelock", delay, [ms], [ms], hre.ethers.ZeroAddress);
    const tl = await timelock.getAddress();
    for (const [name, c] of [["ModelRegistry", registry], ["TierAuditLog", auditLog], ["LiquidationEngine", engine]]) {
      await send(`Ownership of ${name} -> timelock`, c.transferOwnership(tl));
    }
    contracts.TrustTierMultisig = { address: ms, artifactName: "TrustTierMultisig" };
    contracts.TrustTierTimelock = { address: tl, artifactName: "TrustTierTimelock" };
    extra.governance = { owners, threshold, timelockDelaySeconds: delay };
    console.log(`Governance: ${threshold}-of-${owners.length} multisig -> ${delay}s timelock -> all contracts`);
  } else {
    console.log("Governance: single owner (set GOVERNANCE_OWNERS to hand over to a multisig + timelock)");
  }

  writeDeploymentManifest(networkName, contracts, extra);

  if (!localNetworks.has(networkName)) {
    const a = Object.fromEntries(Object.entries(contracts).map(([k, v]) => [k, v.address]));
    console.log("\nVerify the sources on Etherscan:");
    console.log(`  npx hardhat verify --network ${networkName} ${a.ModelRegistry}`);
    console.log(`  npx hardhat verify --network ${networkName} ${a.TierAuditLog}`);
    console.log(`  npx hardhat verify --network ${networkName} ${a.Tier2Verifier}`);
    console.log(`  npx hardhat verify --network ${networkName} ${a.LiquidationEngine} ${a.ModelRegistry} ${a.TierAuditLog} ${a.Tier2Verifier} ${modelHash} ${a.PositionSource} ${maxPriceAge} ${maxVolAge}`);
    if (a.TrustTierLiquidator) {
      console.log(`  npx hardhat verify --network ${networkName} ${a.TrustTierLiquidator} ${a.LiquidationEngine} ${a.PositionSource}`);
      console.log(`  npx hardhat verify --network ${networkName} ${a.MockLendingPool}`);
    }
    if (extra.governance) {
      const g = extra.governance;
      console.log(`  npx hardhat verify --network ${networkName} ${a.TrustTierMultisig} '[${g.owners.map((o) => `"${o}"`).join(",")}]' ${g.threshold}`);
      console.log(`  (TrustTierTimelock takes array arguments: use --constructor-args with a JS file, see README)`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
