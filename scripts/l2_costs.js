// What a TrustTier decision costs on Ethereum L1 and on L2 rollups, from live
// fee data. No transactions are sent: every number comes from eth_call /
// eth_gasPrice against public mainnet endpoints.
//
//   NODE_USE_ENV_PROXY=1 node scripts/l2_costs.js   (needs network access to the RPCs below;
//   the variable makes Node use HTTPS_PROXY when one is set)
//
// For each action it builds the exact calldata the contracts take (a real
// 4,480-byte proof for Tier 2), then:
//   L1 (Ethereum)      fee = measured gas x current gas price
//   OP Stack (Base, OP Mainnet)
//                      fee = measured gas x L2 gas price
//                          + GasPriceOracle.getL1Fee(unsigned tx)   (data posted to L1)
//   Arbitrum One       fee = (measured gas + NodeInterface.gasEstimateL1Component) x L2 base fee
// Execution gas is the gas measured on Hardhat (results/gas_measurements.json,
// results/baseline_onchain.json): OP Stack and Arbitrum price EVM opcodes and
// precompiles as Ethereum does. ETH/USD is Chainlink's mainnet feed.
//
// Writes off-chain/evaluation/results/l2_costs.json.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const R = (p) => path.join(__dirname, "..", p);
const RPC = {
  ethereum: process.env.L1_RPC_URL || "https://eth-mainnet.g.alchemy.com/v2",
  base: "https://mainnet.base.org",
  optimism: "https://mainnet.optimism.io",
  arbitrum: "https://arb1.arbitrum.io/rpc",
};
const CHAIN_ID = { ethereum: 1, base: 8453, optimism: 10, arbitrum: 42161 };
const OP_ORACLE = "0x420000000000000000000000000000000000000F";
const ARB_NODE_INTERFACE = "0x00000000000000000000000000000000000000C8";
const ETH_USD_FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const SOME_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3"; // stands in for the engine's address

const art = (p) => JSON.parse(fs.readFileSync(R(p), "utf8")).abi;

async function main() {
  const GAS = JSON.parse(fs.readFileSync(R("off-chain/evaluation/results/gas_measurements.json"), "utf8"));
  const BASE = JSON.parse(fs.readFileSync(R("off-chain/evaluation/results/baseline_onchain.json"), "utf8"));
  const AAVE = JSON.parse(fs.readFileSync(R("off-chain/evaluation/results/aave_eval.json"), "utf8"));
  const samples = JSON.parse(fs.readFileSync(R("circuits/samples.json"), "utf8"));
  const high = samples.samples.find((s) => s.name === "high_risk");

  const engine = new ethers.Interface(art("artifacts/contracts/LiquidationEngine.sol/LiquidationEngine.json"));
  const liq = new ethers.Interface(art("artifacts/contracts/consumers/TrustTierLiquidator.sol/TrustTierLiquidator.json"));
  const bl = new ethers.Interface(art("artifacts/contracts/baselines/OnChainMLPBaseline.sol/OnChainMLPBaseline.json"));
  const id = 123456n, round = (1n << 64n) + 30_000n;
  const mh = ethers.id("model"), salt = ethers.id("salt");
  const inputs = high.public_inputs.map(BigInt);
  const q = inputs.slice(1, 6);
  // Each action: calldata and measured execution gas.
  const actions = {
    tier0: { data: engine.encodeFunctionData("decideHeuristic", [id, round]), gas: GAS.decideHeuristic },
    tier1: { data: engine.encodeFunctionData("decideCommitment", [id, round, mh, ethers.id("c")]), gas: GAS.decideCommitment },
    tier1_reveal: { data: engine.encodeFunctionData("revealCommitment", [id, q, 123456n, salt]), gas: GAS.revealCommitment },
    tier2: { data: engine.encodeFunctionData("decideZkProof", [id, round, mh, high.proof, inputs]), gas: GAS.decideZkProof },
    challenge: { data: engine.encodeFunctionData("challengeDecision", [id, mh, high.proof, inputs]), gas: GAS.challengeDecision },
    liquidate: { data: liq.encodeFunctionData("liquidate", [id]), gas: GAS.liquidate },
    baseline_decide: { data: bl.encodeFunctionData("decide", [id, round]), gas: BASE.samples.high_risk.decide },
  };

  const providers = Object.fromEntries(Object.entries(RPC).map(([k, u]) => [k, new ethers.JsonRpcProvider(u, CHAIN_ID[k], { staticNetwork: true })]));
  const feed = new ethers.Contract(ETH_USD_FEED, ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], providers.ethereum);
  const ethUsd = Number((await feed.latestRoundData())[1]) / 1e8;
  const oracle = (p) => new ethers.Contract(OP_ORACLE, ["function getL1Fee(bytes) view returns (uint256)"], p);
  const nodeIf = new ethers.Contract(ARB_NODE_INTERFACE,
    ["function gasEstimateL1Component(address,bool,bytes) payable returns (uint64,uint256,uint256)"], providers.arbitrum);

  const out = { measured_at: new Date().toISOString(), eth_usd: ethUsd, chains: {} };
  for (const chain of Object.keys(RPC)) {
    const p = providers[chain];
    const [gasPrice, block] = await Promise.all([p.send("eth_gasPrice", []).then(BigInt), p.getBlock("latest")]);
    // Base fee over the last 1,024 blocks: the snapshot is one moment, these are the spread.
    const hist = await p.send("eth_feeHistory", ["0x400", "latest", []]);
    const fees = hist.baseFeePerGas.map((x) => Number(BigInt(x))).sort((x, y) => x - y);
    const pct = (k) => fees[Math.min(fees.length - 1, Math.floor(k * fees.length))];
    const c = { gas_price_gwei: Number(gasPrice) / 1e9, block_gas_limit: Number(block.gasLimit),
                base_fee_gwei_1024_blocks: { median: pct(0.5) / 1e9, p90: pct(0.9) / 1e9, max: fees[fees.length - 1] / 1e9 },
                actions: {} };
    for (const [name, a] of Object.entries(actions)) {
      let l1DataWei = 0n;
      if (chain === "base" || chain === "optimism") {
        const tx = ethers.Transaction.from({ type: 2, chainId: CHAIN_ID[chain], nonce: 1000, to: SOME_CONTRACT, data: a.data,
          gasLimit: a.gas, maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: gasPrice, value: 0 });
        l1DataWei = await oracle(p).getL1Fee(tx.unsignedSerialized);
      } else if (chain === "arbitrum") {
        const [l1Gas, baseFee] = await nodeIf.gasEstimateL1Component.staticCall(SOME_CONTRACT, false, a.data);
        l1DataWei = BigInt(l1Gas) * BigInt(baseFee);
      }
      const execWei = BigInt(a.gas) * gasPrice;
      const totalWei = execWei + l1DataWei;
      c.actions[name] = { calldata_bytes: ethers.dataLength(a.data), exec_gas: a.gas,
        exec_usd: Number(execWei) / 1e18 * ethUsd, l1_data_usd: Number(l1DataWei) / 1e18 * ethUsd,
        usd: Number(totalWei) / 1e18 * ethUsd };
    }
    // Per position-day on real Aave borrowers (random sample, adaptive bands): the
    // tier mix of evaluation/aave_eval.py, every decision TrustTier makes,
    // against the baseline (model on every position) and always-zk.
    const mix = AAVE.policies.adaptive.random.tiers;
    const n = mix[0] + mix[1] + mix[2];
    const A = c.actions;
    const tt = (mix[0] * A.tier0.usd + mix[1] * (A.tier1.usd + A.tier1_reveal.usd) + mix[2] * A.tier2.usd) / n;
    c.per_position_day_usd = { trusttier: tt, baseline_onchain_inference: A.baseline_decide.usd, always_zk: A.tier2.usd };
    // The same at the 90th-percentile base fee of the last 1,024 blocks (execution part scaled).
    const scale = Math.max(1, pct(0.9) / Number(gasPrice));
    const at = (x) => x.exec_usd * scale + x.l1_data_usd;
    c.per_position_day_usd_p90_base_fee = {
      trusttier: (mix[0] * at(A.tier0) + mix[1] * (at(A.tier1) + at(A.tier1_reveal)) + mix[2] * at(A.tier2)) / n,
      baseline_onchain_inference: at(A.baseline_decide), always_zk: at(A.tier2) };
    c.per_position_year_usd = Object.fromEntries(Object.entries(c.per_position_day_usd).map(([k, v]) => [k, v * 365]));
    // Smallest debt for which a year of daily decisions costs under 0.5% of it.
    c.min_debt_usd_at_0_5pct = Object.fromEntries(Object.entries(c.per_position_year_usd).map(([k, v]) => [k, v / 0.005]));
    // Decisions that fit in one block (execution gas only).
    c.decisions_per_block = { tier0: Math.floor(c.block_gas_limit / GAS.decideHeuristic),
      tier2: Math.floor(c.block_gas_limit / GAS.decideZkProof), baseline: Math.floor(c.block_gas_limit / BASE.samples.high_risk.decide) };
    out.chains[chain] = c;
    console.log(chain, `gas ${c.gas_price_gwei.toFixed(4)} gwei`, "Tier0 $" + A.tier0.usd.toFixed(4), "Tier2 $" + A.tier2.usd.toFixed(4),
      `(L1 data $${A.tier2.l1_data_usd.toFixed(4)})`, "baseline $" + A.baseline_decide.usd.toFixed(4),
      "per pos-day TT $" + tt.toFixed(4));
  }
  const dest = R("off-chain/evaluation/results/l2_costs.json");
  fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
  console.log("wrote", dest, "ETH/USD", ethUsd);
}

main().catch((e) => { console.error(e); process.exit(1); });
