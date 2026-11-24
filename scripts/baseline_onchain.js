// Baseline (Alhaidari et al., AFT 2025): TrustTier's own model run inside a
// contract on TrustTier's own verified features (contracts/baselines/OnChainMLPBaseline.sol).
//
//   cd off-chain && python -m evaluation.baseline_onchain && cd ..   # exports the weights
//   HARDHAT_LOCAL_SOLC=1 npx hardhat run scripts/baseline_onchain.js
//
// Measures, with the deployed model: deployment, uploading the weights
// (setParams), inference on supplied features (classifyOnChain, their "L1
// inference gas") and a full decision on a position (decide: read the
// engine's verified features, run the model, record the approval), on the
// high- and low-risk sample positions. Then the same for the larger
// architectures of the model-size study (random weights: gas does not depend
// on their values); uploads are chunked to Osaka's 2^24-gas per-transaction cap.
//
// Writes off-chain/evaluation/results/baseline_onchain.json.
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { deployTrustTier, PAST_ROUND } = require("../test/helpers/fixture");

const MAINNET_BLOCK = 60_000_000;
const TX_CAP = 16_777_216; // EIP-7825 (Osaka): max gas per transaction
const CHUNK = 500;          // weights per upload transaction (~11 M gas)
const ARCHS = [[4], [8], [16], [32], [64], [16, 16], [32, 32], [64, 64]];

const gasOf = async (txp) => Number((await (await txp).wait()).gasUsed);

function randomParams(layers, seed) {
  let s = BigInt(seed);
  const out = [];
  for (let l = 0; l + 1 < layers.length; l++) {
    const n = layers[l] * layers[l + 1] + layers[l + 1];
    for (let k = 0; k < n; k++) {
      s = (s * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
      out.push((s % 2_000_000_000_000n) - 1_000_000_000_000n); // in (-1, 1) at scale 1e12
    }
  }
  return out;
}

async function main() {
  const P = JSON.parse(fs.readFileSync(path.join("off-chain", "evaluation", "results", "baseline_params.json"), "utf8"));
  const samples = JSON.parse(fs.readFileSync(path.join("circuits", "samples.json"), "utf8"));
  const MH = JSON.parse(fs.readFileSync(path.join("off-chain", "risk_model", "artifacts", "model_metadata.json"), "utf8")).model_hash_keccak256;
  const out = { model: { layers: P.layers, params: P.params.length }, block_gas_limit_mainnet: MAINNET_BLOCK, samples: {}, sizes: [] };

  for (const name of ["high_risk", "low_risk"]) {
    const s = samples.samples.find((x) => x.name === name);
    const t = await deployTrustTier({ modelHash: MH, weightsHash: BigInt(samples.weights_hash),
      price: BigInt(s.price_now), pricePast: BigInt(s.price_past), vol: BigInt(s.vol_answer),
      thresholdBps: s.liquidation_threshold_bps });
    const ltv = (Number(s.debt_usd) / Number(s.collateral_usd)).toFixed(4);
    await t.openPosition(1, ltv, { ageDays: s.age_days, topupDays: s.topup_days_ago });
    const F = await ethers.getContractFactory("OnChainMLPBaseline");
    const b = await F.deploy(await t.engine.getAddress());
    const deployGas = Number((await b.deploymentTransaction().wait()).gasUsed);
    const setGas = await gasOf(b.setParams(P.layers, P.params.map(BigInt)));
    const q = s.public_inputs.slice(1, 6).map(BigInt);
    const [high] = await b.classify(q);
    const infGas = await gasOf(b.classifyOnChain(q));
    const decideGas = await gasOf(b.decide(1, PAST_ROUND));
    const row = { deploy: deployGas, setParams: setGas, classifyOnChain: infGas, decide: decideGas,
                  high_risk: high, proof_label: Number(s.public_inputs[6]) };
    out.samples[name] = row;
    if (!out.deploy) Object.assign(out, { deploy: deployGas, setParams: setGas });
    console.log(name, JSON.stringify(row));
  }

  const F = await ethers.getContractFactory("OnChainMLPBaseline");
  const b = await F.deploy(ethers.ZeroAddress);
  const q = [500n, 300n, 480n, 100n, 200n];
  for (const h of ARCHS) {
    const layers = [5, ...h, 1];
    const params = randomParams(layers, 7);
    // Upload in chunks that fit Osaka's per-transaction cap (2^24 gas).
    let setGas = await gasOf(b.beginParams(layers));
    let txs = 1;
    for (let k = 0; k < params.length; k += CHUNK) {
      setGas += await gasOf(b.appendParams(params.slice(k, k + CHUNK), { gasLimit: TX_CAP }));
      txs++;
    }
    let infGas = null;
    try { infGas = await gasOf(b.classifyOnChain(q, { gasLimit: TX_CAP })); } catch (e) { infGas = "exceeds the 2^24 per-transaction cap"; }
    const row = { hidden: h, params: params.length, upload_gas: setGas, upload_txs: txs, classifyOnChain: infGas };
    out.sizes.push(row);
    console.log(JSON.stringify(row));
  }
  const dest = path.join("off-chain", "evaluation", "results", "baseline_onchain.json");
  fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
  console.log("wrote", dest);
}

main().catch((e) => { console.error(e); process.exit(1); });
