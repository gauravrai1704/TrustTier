// Verifies every contract in deployments/<network>.json on Etherscan, using
// the constructor arguments deploy.js recorded. Already-verified contracts
// are skipped; one failure does not stop the others.
//
//   ETHERSCAN_API_KEY=... npx hardhat run scripts/verify.js --network sepolia
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  let ok = 0;
  let failed = 0;
  const seen = new Set();
  for (const [name, c] of Object.entries(manifest.contracts)) {
    if (seen.has(c.address)) continue; // PositionSource is the pool under another name
    seen.add(c.address);
    try {
      await hre.run("verify:verify", {
        address: c.address,
        constructorArguments: c.constructorArgs || [],
        contract: c.sourceName ? `${c.sourceName}:${c.artifactName}` : undefined,
      });
      console.log(`verified ${name} ${c.address}`);
      ok += 1;
    } catch (e) {
      if (/already verified/i.test(e.message)) {
        console.log(`already verified ${name}`);
        ok += 1;
      } else {
        console.log(`could not verify ${name}: ${e.message.split("\n")[0]}`);
        failed += 1;
      }
    }
  }
  console.log(`\n${ok} verified, ${failed} failed`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
