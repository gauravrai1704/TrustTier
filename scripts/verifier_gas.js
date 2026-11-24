// Deploys an EZKL-generated verifier (compiled bytecode) and measures the gas
// of one verifyProof call with real calldata. Used by
// off-chain/evaluation/model_size.py for each model size.
//
//   VERIFIER_DIR=<dir with bytecode.hex and calldata.bytes> UNLIMITED_CODE=1 \
//     npx hardhat run scripts/verifier_gas.js
//
// Prints one JSON line: {"deployed_bytes", "deploy_gas", "verify_gas", "eip170_ok"}.
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

async function main() {
  const dir = process.env.VERIFIER_DIR;
  const bytecode = "0x" + fs.readFileSync(path.join(dir, "bytecode.hex"), "utf8").trim();
  const deployed = "0x" + fs.readFileSync(path.join(dir, "deployed.hex"), "utf8").trim();
  const calldata = "0x" + fs.readFileSync(path.join(dir, "calldata.bytes")).toString("hex");
  const [signer] = await ethers.getSigners();
  const tx = await signer.sendTransaction({ data: bytecode });
  const rc = await tx.wait();
  const verifyTx = await signer.sendTransaction({ to: rc.contractAddress, data: calldata });
  const vr = await verifyTx.wait();
  const ok = await ethers.provider.call({ to: rc.contractAddress, data: calldata });
  const bytes = (deployed.length - 2) / 2;
  console.log(JSON.stringify({
    deployed_bytes: bytes,
    deploy_gas: Number(rc.gasUsed),
    verify_gas: Number(vr.gasUsed),
    verified: BigInt(ok) === 1n,
    eip170_ok: bytes <= 24576,
  }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
