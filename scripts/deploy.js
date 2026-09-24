// Deploys the full TrustTier contract stack to whichever network Hardhat
// is pointed at, choosing between the mock Tier-2 verifier (fast, free,
// used for local dev/testing) and the real EZKL-generated verifier
// (genuine zk-SNARK verification, used for the Sepolia testnet milestone).
//
// Verifier choice:
//   - Defaults to "mock" on the "hardhat" and "localhost" networks, since
//     that's what the existing off-chain router demo (Weeks 2-3) and test
//     suite (Weeks 1-2) are built against.
//   - Defaults to "real" on every other network (i.e. sepolia), since the
//     whole point of a testnet deployment is demonstrating genuine
//     zk-SNARK verification, not the mock.
//   - Override either way with the VERIFIER_MODE env var: "mock" or "real".
//
// Usage:
//   npx hardhat run scripts/deploy.js                        (local, uses mock)
//   npx hardhat run scripts/deploy.js --network localhost     (local node, uses mock)
//   npx hardhat run scripts/deploy.js --network sepolia        (testnet, uses REAL verifier)
//   VERIFIER_MODE=real npx hardhat run scripts/deploy.js       (force real verifier locally)

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

function writeDeploymentManifest(networkName, contracts) {
  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${networkName}.json`);

  const manifest = { network: networkName, contracts: {} };
  for (const [name, { address, artifactName }] of Object.entries(contracts)) {
    const artifact = hre.artifacts.readArtifactSync(artifactName);
    manifest.contracts[name] = { address, abi: artifact.abi };
  }

  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`\nWrote deployment manifest to ${outPath}`);
}

async function main() {
  const networkName = hre.network.name; // e.g. "localhost", "hardhat", "sepolia"

  const localNetworks = new Set(["hardhat", "localhost"]);
  const defaultMode = localNetworks.has(networkName) ? "mock" : "real";
  const verifierMode = (process.env.VERIFIER_MODE || defaultMode).toLowerCase();
  if (!["mock", "real"].includes(verifierMode)) {
    throw new Error(`VERIFIER_MODE must be "mock" or "real", got "${verifierMode}"`);
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deploying TrustTier contracts to "${networkName}" with account:`, deployer.address);
  console.log(`Tier-2 verifier mode: ${verifierMode}`);

  if (verifierMode === "real") {
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    console.log(`Deployer balance: ${hre.ethers.formatEther(balance)} ETH`);
    if (balance === 0n) {
      console.warn(
        "WARNING: deployer balance is 0. The real verifier is a large contract " +
        "(deploys the full Halo2Verifier bytecode) and Tier-2 decisions cost " +
        "~1,000,000 gas each - this will fail without testnet ETH. " +
        "Get some from a Sepolia faucet before proceeding."
      );
    }
  }

  const ModelRegistry = await hre.ethers.getContractFactory("ModelRegistry");
  const registry = await ModelRegistry.deploy();
  await registry.waitForDeployment();
  console.log("ModelRegistry deployed to:", await registry.getAddress());

  const TierAuditLog = await hre.ethers.getContractFactory("TierAuditLog");
  const auditLog = await TierAuditLog.deploy();
  await auditLog.waitForDeployment();
  console.log("TierAuditLog deployed to:", await auditLog.getAddress());

  let verifier, verifierArtifactName;
  if (verifierMode === "mock") {
    const MockTier2Verifier = await hre.ethers.getContractFactory("MockTier2Verifier");
    verifier = await MockTier2Verifier.deploy();
    verifierArtifactName = "MockTier2Verifier";
  } else {
    // The contract inside contracts/EzklVerifier.sol is named Halo2Verifier
    // (that's EZKL's own generated contract name) - see circuits/build_circuit.py.
    const Halo2Verifier = await hre.ethers.getContractFactory("Halo2Verifier");
    verifier = await Halo2Verifier.deploy();
    verifierArtifactName = "Halo2Verifier";
  }
  await verifier.waitForDeployment();
  console.log(`${verifierArtifactName} deployed to:`, await verifier.getAddress());

  const LiquidationEngine = await hre.ethers.getContractFactory("LiquidationEngine");
  const engine = await LiquidationEngine.deploy(
    await registry.getAddress(),
    await auditLog.getAddress(),
    await verifier.getAddress()
  );
  await engine.waitForDeployment();
  console.log("LiquidationEngine deployed to:", await engine.getAddress());

  const authTx = await auditLog.authorizeLogger(await engine.getAddress());
  await authTx.wait();
  console.log("Authorized LiquidationEngine as a logger on TierAuditLog");

  const addresses = {
    ModelRegistry: await registry.getAddress(),
    TierAuditLog: await auditLog.getAddress(),
    Tier2Verifier: await verifier.getAddress(),
    LiquidationEngine: await engine.getAddress(),
  };

  console.log("\nDeployment complete. Summary:");
  console.log({ ...addresses, verifierMode, verifierArtifactName });

  // Written under the generic key "Tier2Verifier" (not "MockTier2Verifier"
  // or "Halo2Verifier") so off-chain/router/chain_client.py doesn't need
  // to know or care which verifier mode was used - it always looks up the
  // same key. See chain_client.py.
  writeDeploymentManifest(networkName, {
    ModelRegistry: { address: addresses.ModelRegistry, artifactName: "ModelRegistry" },
    TierAuditLog: { address: addresses.TierAuditLog, artifactName: "TierAuditLog" },
    Tier2Verifier: { address: addresses.Tier2Verifier, artifactName: verifierArtifactName },
    LiquidationEngine: { address: addresses.LiquidationEngine, artifactName: "LiquidationEngine" },
  });

  if (networkName === "sepolia") {
    console.log("\nTo verify contracts on Sepolia Etherscan, run:");
    console.log(`  npx hardhat verify --network sepolia ${addresses.ModelRegistry}`);
    console.log(`  npx hardhat verify --network sepolia ${addresses.TierAuditLog}`);
    if (verifierMode === "real") {
      console.log(`  npx hardhat verify --network sepolia ${addresses.Tier2Verifier}`);
    }
    console.log(
      `  npx hardhat verify --network sepolia ${addresses.LiquidationEngine} ` +
      `${addresses.ModelRegistry} ${addresses.TierAuditLog} ${addresses.Tier2Verifier}`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
