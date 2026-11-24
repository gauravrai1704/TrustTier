// How many TrustTier decisions fit in one Ethereum block?
//
// Fills single blocks on Hardhat's in-memory chain, with the block gas limit
// set to Ethereum mainnet's (BLOCK_GAS_LIMIT, default 60,000,000: the limit
// read from mainnet when this study was run), with more decisions than can
// fit, mines one block, and counts what was included. Tier-2 decisions use
// the real EZKL verifier and a real proof (circuits/samples.json): every
// position is opened with the sample's on-chain parameters, so the same proof
// is valid for each of them.
//
//   BLOCK_GAS_LIMIT=60000000 HARDHAT_LOCAL_SOLC=1 npx hardhat run scripts/block_capacity.js
//
// Writes off-chain/evaluation/results/block_capacity.json.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { deployTrustTier, PAST_ROUND } = require("../test/helpers/fixture");

const LIMIT = Number(process.env.BLOCK_GAS_LIMIT || 60_000_000);

async function fillBlock(label, makeTxs) {
  await network.provider.send("evm_setAutomine", [false]);
  const sent = await makeTxs();
  await network.provider.send("evm_mine", []);
  await network.provider.send("evm_setAutomine", [true]);
  const block = await ethers.provider.getBlock("latest");
  let ok = 0;
  let reverted = 0;
  for (const h of block.transactions) {
    const r = await ethers.provider.getTransactionReceipt(h);
    if (r.status === 1) ok++;
    else reverted++;
  }
  // Drop whatever did not fit before the next experiment.
  await network.provider.send("hardhat_dropTransaction", []).catch(() => {});
  for (const tx of sent) {
    await network.provider.send("hardhat_dropTransaction", [tx]).catch(() => {});
  }
  const row = { scenario: label, submitted: sent.length, included: block.transactions.length, succeeded: ok, reverted,
                gas_used: Number(block.gasUsed), gas_limit: Number(block.gasLimit),
                fill: +(Number(block.gasUsed) / Number(block.gasLimit)).toFixed(4) };
  console.log(JSON.stringify(row));
  return row;
}

async function main() {
  const samplesFile = JSON.parse(fs.readFileSync(path.join("circuits", "samples.json"), "utf8"));
  const high = samplesFile.samples.find((s) => s.name === "high_risk");
  const WH = BigInt(samplesFile.weights_hash);
  const MH = JSON.parse(fs.readFileSync(path.join("off-chain", "risk_model", "artifacts", "model_metadata.json"), "utf8")).model_hash_keccak256;
  const signers = await ethers.getSigners();
  const real = await (await ethers.getContractFactory("Halo2Verifier")).deploy();
  const t = await deployTrustTier({ verifier: await real.getAddress(), modelHash: MH, weightsHash: WH,
    price: BigInt(high.price_now), pricePast: BigInt(high.price_past), vol: BigInt(high.vol_answer) });
  const bond = await t.engine.requiredBond();
  for (const s of signers) await t.engine.connect(s).deposit({ value: ethers.parseEther("20") });

  let next = 1;
  const open = async (n, ltv, extra = {}) => {
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(await t.openPosition(next++, ltv, extra));
    return ids;
  };
  const nonces = new Map();
  const nonceOf = async (s) => {
    if (!nonces.has(s.address)) nonces.set(s.address, await ethers.provider.getTransactionCount(s.address, "pending"));
    const n = nonces.get(s.address);
    nonces.set(s.address, n + 1);
    return n;
  };
  const resetNonces = () => nonces.clear();
  const feeOpts = { maxFeePerGas: ethers.parseUnits("50", "gwei"), maxPriorityFeePerGas: ethers.parseUnits("1", "gwei") };
  const send = async (i, fn, args, gasLimit) => {
    const s = signers[i % signers.length];
    const tx = await t.engine.connect(s)[fn](...args, { gasLimit, nonce: await nonceOf(s), ...feeOpts });
    return tx.hash;
  };
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const rows = [];

  const N = 320;
  // Tier 0 (bonds drawn from deposits)
  let ids = await open(N, "0.40");
  resetNonces();
  rows.push(await fillBlock("tier0_heuristic", async () => {
    const h = [];
    for (let i = 0; i < ids.length; i++) h.push(await send(i, "decideHeuristic", [ids[i], PAST_ROUND], 400_000));
    return h;
  }));
  // Tier 1 claims
  ids = await open(N, "0.70");
  resetNonces();
  rows.push(await fillBlock("tier1_commitment", async () => {
    const h = [];
    for (let i = 0; i < ids.length; i++) {
      const c = ethers.keccak256(coder.encode(["uint256[]", "int256", "bytes32"], [[1, 2, 3, 4, 5], 1, ethers.id(String(i))]));
      h.push(await send(i, "decideCommitment", [ids[i], PAST_ROUND, MH, c], 500_000));
    }
    return h;
  }));
  // Tier 2 with the real verifier and proof
  const ltv = (Number(high.debt_usd) / Number(high.collateral_usd)).toFixed(4);
  ids = await open(140, ltv, { ageDays: high.age_days, topupDays: high.topup_days_ago });
  const inputs = high.public_inputs.map(BigInt);
  resetNonces();
  rows.push(await fillBlock("tier2_zk_proof", async () => {
    const h = [];
    for (let i = 0; i < ids.length; i++) h.push(await send(i, "decideZkProof", [ids[i], PAST_ROUND, MH, high.proof, inputs], 1_300_000));
    return h;
  }));
  const out = { block_gas_limit: LIMIT, note: "one block each; Tier-2 rows use the real EZKL verifier and a real proof", rows };
  const dest = path.join("off-chain", "evaluation", "results", "block_capacity.json");
  fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
  console.log("wrote", dest);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
