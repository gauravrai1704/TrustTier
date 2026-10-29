// Re-posts the latest answer of every MOCK feed in deployments/<network>.json
// that is older than half its allowed age, so the engine's staleness checks
// keep passing on a long-lived testnet demo. Real Chainlink feeds are never
// touched (they cannot be).
//
//   npx hardhat run scripts/refresh_feeds.js --network sepolia
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf8"));
  const now = (await hre.ethers.provider.getBlock("latest")).timestamp;
  const [signer] = await hre.ethers.getSigners();
  let n = 0;
  for (const market of m.markets || []) {
    const feeds = [];
    if (market.mockPriceFeed) feeds.push([market.priceFeed, m.maxPriceAge, `${market.name} price`]);
    if (market.mockVolatilityFeed) feeds.push([market.volatilityFeed, m.maxVolatilityAge, `${market.name} volatility`]);
    for (const [address, maxAge, label] of feeds) {
      const feed = new hre.ethers.Contract(address, m.aggregatorAbi, signer);
      const [, answer, , updatedAt] = await feed.latestRoundData();
      if (now - Number(updatedAt) > maxAge / 2) {
        await (await feed.updateAnswer(answer)).wait();
        console.log(`refreshed ${label}`);
        n += 1;
      }
    }
  }
  console.log(`${n} feed(s) refreshed`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
