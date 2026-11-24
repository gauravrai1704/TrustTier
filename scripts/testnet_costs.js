// Real decisions on a live testnet (L1: Sepolia; L2: Base / OP / Arbitrum Sepolia),
// recording what each transaction actually paid. Run after deploy.js on the
// same network (MANIFEST_NAME=<network>-bench keeps it apart from the DApp's):
//
//   MANIFEST_NAME=baseSepolia-bench npx hardhat run scripts/deploy.js --network baseSepolia
//   MANIFEST_NAME=baseSepolia-bench npx hardhat run scripts/testnet_costs.js --network baseSepolia
//
// It recreates the circuit's sample positions on-chain (fresh mock feeds with a
// 24-hour price history, a market, positions with the samples' collateral, debt
// and timestamps), so the shipped real proof (circuits/samples.json) is valid for
// them, then sends: a Tier-0 claim, a Tier-1 claim and its reveal, a Tier-2
// decision with the real proof and verifier, the liquidation, and the
// on-chain-inference baseline (OnChainMLPBaseline: deploy, weight upload,
// decision). For every transaction it stores gas used, the effective gas price,
// and the L1 data fee the rollup charged (OP Stack receipts: l1Fee; Arbitrum:
// gasUsedForL1, already inside gasUsed).
//
// Writes off-chain/evaluation/results/testnet_costs/<network>.json.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const DAY = 86400;

async function main() {
  const net = hre.network.name;
  const manifestName = process.env.MANIFEST_NAME || net;
  const M = JSON.parse(fs.readFileSync(path.join("deployments", `${manifestName}.json`), "utf8"));
  const at = (name) => new ethers.Contract(M.contracts[name].address, M.contracts[name].abi, signer);
  const [signer] = await ethers.getSigners();
  const engine = at("LiquidationEngine");
  const pool = at("PositionSource");
  const liquidator = at("TrustTierLiquidator");
  const samples = JSON.parse(fs.readFileSync(path.join("circuits", "samples.json"), "utf8"));
  const MH = JSON.parse(fs.readFileSync(path.join("off-chain", "risk_model", "artifacts", "model_metadata.json"), "utf8")).model_hash_keccak256;
  const P = JSON.parse(fs.readFileSync(path.join("off-chain", "evaluation", "results", "baseline_params.json"), "utf8"));

  const rows = [];
  async function record(label, txp) {
    const tx = await txp;
    const r = await tx.wait();
    const raw = await ethers.provider.send("eth_getTransactionReceipt", [r.hash]);
    const l1Fee = raw.l1Fee ? BigInt(raw.l1Fee) : 0n; // OP Stack
    const l1Gas = raw.gasUsedForL1 ? Number(BigInt(raw.gasUsedForL1)) : null; // Arbitrum
    const price = BigInt(raw.effectiveGasPrice);
    const row = { action: label, tx: r.hash, gas_used: Number(r.gasUsed), effective_gas_price_wei: price.toString(),
                  l1_data_fee_wei: l1Fee.toString(), arbitrum_l1_gas: l1Gas, calldata_bytes: ethers.dataLength(tx.data),
                  total_fee_wei: (BigInt(r.gasUsed) * price + l1Fee).toString() };
    rows.push(row);
    console.log(label, JSON.stringify(row));
    return r;
  }

  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const Agg = await ethers.getContractFactory("MockV3Aggregator");
  const base = BigInt(Date.now()) * 1000n;
  const opened = {};
  for (const name of ["high_risk", "low_risk", "watch_high"]) {
    const s = samples.samples.find((x) => x.name === name);
    // Round 1 is the price 25 h ago, round 2 the current price: the momentum round is 1.
    const price = await Agg.deploy(8, `${name} price`, BigInt(s.price_past));
    await price.waitForDeployment();
    await (await price.setRoundTimestamp(1, now - 25 * 3600)).wait();
    await (await price.updateAnswer(BigInt(s.price_now))).wait();
    const vol = await Agg.deploy(8, `${name} vol`, BigInt(s.vol_answer));
    await vol.waitForDeployment();
    const market = Number(await pool.marketCount());
    await (await pool.addMarket(await price.getAddress(), await vol.getAddress(), s.liquidation_threshold_bps)).wait();
    const id = base + BigInt(Object.keys(opened).length);
    await (await pool.openPosition(id, market, 10n ** 18n, BigInt(s.debt_usd))).wait();
    const t = (await ethers.provider.getBlock("latest")).timestamp;
    await (await pool.setTimestamps(id, t - s.age_days * DAY - 60, t - s.topup_days_ago * DAY - 60)).wait();
    const [q] = await engine.currentFeatures(id, 1);
    const want = s.public_inputs.slice(1, 6).map(BigInt);
    if (q.map(BigInt).join() !== want.join()) throw new Error(`${name}: on-chain features ${q} differ from the proof's ${want}`);
    opened[name] = { id, s };
  }

  const bond = await engine.requiredBond();
  await record("tier0_decideHeuristic", engine.decideHeuristic(opened.low_risk.id, 1, { value: bond }));
  const w = opened.watch_high;
  const q = w.s.public_inputs.slice(1, 6).map(BigInt);
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const score = 300_000n; // a committed score (x1e6) under 0.5: the claim stands
  const c = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256[]", "int256", "bytes32"], [q, score, salt]));
  await record("tier1_decideCommitment", engine.decideCommitment(w.id, 1, MH, c, { value: bond }));
  await record("tier1_revealCommitment", engine.revealCommitment(w.id, q, score, salt));
  const h = opened.high_risk;
  await record("tier2_decideZkProof", engine.decideZkProof(h.id, 1, MH, h.s.proof, h.s.public_inputs.map(BigInt)));

  // The on-chain-inference baseline, on the same position and features.
  const B = await (await ethers.getContractFactory("OnChainMLPBaseline")).deploy(await engine.getAddress());
  const dr = await B.deploymentTransaction().wait();
  rows.push({ action: "baseline_deploy", tx: dr.hash, gas_used: Number(dr.gasUsed) });
  await record("baseline_setParams", B.setParams(P.layers, P.params.map(BigInt)));
  await record("baseline_decide", B.decide(h.id, 1));

  await record("liquidate", liquidator.liquidate(h.id));

  const { chainId } = await ethers.provider.getNetwork();
  const out = { network: net, chain_id: Number(chainId), measured_at: new Date().toISOString(), rows };
  const dir = path.join("off-chain", "evaluation", "results", "testnet_costs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${net}.json`), JSON.stringify(out, null, 2) + "\n");
  console.log("wrote", path.join(dir, `${net}.json`));
}

main().catch((e) => { console.error(e); process.exit(1); });
