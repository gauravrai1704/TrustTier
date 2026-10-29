// Governance CLI for a deployment made with GOVERNANCE_OWNERS (see deploy.js):
// multisig owners propose, confirm and execute timelocked admin calls.
//
// Every admin change takes two multisig transactions, separated by the delay:
//   1. schedule:  multisig -> timelock.schedule(target, 0, data, 0, salt, delay)
//   2. execute:   multisig -> timelock.execute(target, 0, data, 0, salt)   (after the delay)
// and each multisig transaction needs THRESHOLD owners: one `propose`, then
// `confirm` by the others, then `exec`.
//
// Usage (each owner runs with their own PRIVATE_KEY / Hardhat account):
//   ACTION=propose PHASE=schedule TARGET=LiquidationEngine FN=setTier2Verifier ARGS='["0xVerifier","0xModelHash"]' \
//     npx hardhat run scripts/governance.js --network sepolia
//   ACTION=confirm TXID=0 npx hardhat run scripts/governance.js --network sepolia
//   ACTION=exec    TXID=0 npx hardhat run scripts/governance.js --network sepolia
//   ...wait TIMELOCK_DELAY seconds, then the same three steps with PHASE=execute.
//   ACTION=status  npx hardhat run scripts/governance.js --network sepolia
//
// Optional: SIGNER_INDEX picks a Hardhat account (local testing with several owners).

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

function manifest() {
  const p = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!m.contracts.TrustTierMultisig) throw new Error("This deployment has no governance (deploy with GOVERNANCE_OWNERS).");
  return m;
}

async function contract(m, name, signer) {
  const c = m.contracts[name];
  if (!c) throw new Error(`Unknown contract ${name}`);
  return new hre.ethers.Contract(c.address, c.abi, signer);
}

async function main() {
  const m = manifest();
  const signers = await hre.ethers.getSigners();
  const signer = signers[Number(process.env.SIGNER_INDEX || 0)];
  const multisig = await contract(m, "TrustTierMultisig", signer);
  const timelock = await contract(m, "TrustTierTimelock", signer);
  const action = (process.env.ACTION || "status").toLowerCase();

  if (action === "propose") {
    const target = await contract(m, process.env.TARGET, signer);
    const data = target.interface.encodeFunctionData(process.env.FN, JSON.parse(process.env.ARGS || "[]"));
    const salt = hre.ethers.id(process.env.SALT || `${process.env.FN}:${process.env.ARGS || ""}`);
    const phase = (process.env.PHASE || "schedule").toLowerCase();
    const delay = await timelock.getMinDelay();
    const call = phase === "schedule"
      ? timelock.interface.encodeFunctionData("schedule", [await target.getAddress(), 0, data, hre.ethers.ZeroHash, salt, delay])
      : timelock.interface.encodeFunctionData("execute", [await target.getAddress(), 0, data, hre.ethers.ZeroHash, salt]);
    const txId = await multisig.transactionCount();
    await (await multisig.submit(await timelock.getAddress(), 0, call)).wait();
    console.log(`Proposed multisig tx #${txId}: ${phase} ${process.env.TARGET}.${process.env.FN}(${process.env.ARGS || ""})`);
    console.log(`  timelock operation id: ${await timelock.hashOperation(await target.getAddress(), 0, data, hre.ethers.ZeroHash, salt)}`);
  } else if (action === "confirm") {
    await (await multisig.confirm(process.env.TXID)).wait();
    console.log(`Confirmed multisig tx #${process.env.TXID} as ${signer.address}`);
  } else if (action === "exec") {
    await (await multisig.execute(process.env.TXID)).wait();
    console.log(`Executed multisig tx #${process.env.TXID}`);
  } else {
    const n = Number(await multisig.transactionCount());
    console.log(`Multisig ${await multisig.getAddress()}: ${await multisig.threshold()}-of-${await multisig.ownerCount()}, ${n} tx(s)`);
    console.log(`Timelock ${await timelock.getAddress()}: min delay ${await timelock.getMinDelay()} s`);
    for (let i = 0; i < n; i++) {
      const t = await multisig.transactions(i);
      console.log(`  #${i} -> ${t.target} confirmations=${t.confirmations} executed=${t.executed}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
