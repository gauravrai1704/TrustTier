// Measures the gas of every TrustTier entry point on a fresh in-process
// Hardhat chain, with the REAL EZKL verifier and REAL proofs from
// circuits/samples.json for the Tier-2 and challenge rows. Positions live in
// MockLendingPool and are valued by Chainlink-style feeds, so every decide*
// row includes reading the position, both feeds and the 24-hour round.
//
//   npx hardhat run scripts/measure_gas.js            (prints JSON)
//
// Values include the 21,000-gas transaction base cost, as a user pays it.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deployTrustTier, increaseTime, PAST_ROUND } = require("../test/helpers/fixture");

async function gas(txp) {
  return Number((await (await txp).wait()).gasUsed);
}

async function main() {
  const [, alice, bob, carol] = await ethers.getSigners();
  const out = { note: "gas used per transaction, incl. 21,000 base; Tier-2 and challenge rows use the real EZKL verifier and real proofs; every decide* reads the position source and two Chainlink-style feeds" };
  const BOND = ethers.parseEther("0.01");
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const SALT = ethers.id("salt");
  const commitmentOf = (q, score) => ethers.keccak256(coder.encode(["uint256[]", "int256", "bytes32"], [q, score, SALT]));
  const MH = JSON.parse(fs.readFileSync(path.join("off-chain", "risk_model", "artifacts", "model_metadata.json"), "utf8")).model_hash_keccak256;
  const samples = Object.fromEntries(
    JSON.parse(fs.readFileSync(path.join("circuits", "samples.json"), "utf8")).samples.map((s) => [s.name, s])
  );
  const ins = (s) => s.public_inputs.map(BigInt);
  const ltvOf = (s) => (Number(s.debt_usd) / Number(s.collateral_usd)).toFixed(4);
  const feedOpts = (s) => ({ price: BigInt(s.price_now), pricePast: BigInt(s.price_past), vol: BigInt(s.vol_answer) });

  const real = await (await ethers.getContractFactory("Halo2Verifier")).deploy();
  out.deploy_Halo2Verifier = Number((await real.deploymentTransaction().wait()).gasUsed);

  // Deployment 1: the high-risk sample market.
  const high = samples.high_risk;
  const t = await deployTrustTier({ verifier: await real.getAddress(), modelHash: MH, ...feedOpts(high) });
  out.deploy_LiquidationEngine = Number((await t.engine.deploymentTransaction().wait()).gasUsed);
  out.deploy_MockLendingPool = Number((await t.pool.deploymentTransaction().wait()).gasUsed);
  const MH2 = ethers.id("m2");
  out.registerModel = await gas(t.registry.registerModel(MH2, "ipfs://bafyexamplecidexamplecidexample01"));
  out.revokeModel = await gas(t.registry.revokeModel(MH2));

  await t.openPosition(1, "0.50");
  await t.openPosition(2, "0.70");
  await t.openPosition(3, ltvOf(high), { ageDays: high.age_days, topupDays: high.topup_days_ago });
  out.currentFeatures_view = Number(await t.engine.currentFeatures.estimateGas(1, PAST_ROUND));
  out.decideHeuristic = await gas(t.engine.connect(alice).decideHeuristic(1, PAST_ROUND, { value: BOND }));
  const q2 = await t.features(2);
  out.decideCommitment = await gas(t.engine.connect(alice).decideCommitment(2, PAST_ROUND, MH, commitmentOf(q2, 120000), { value: BOND }));
  out.revealCommitment = await gas(t.engine.connect(alice).revealCommitment(2, q2, 120000, SALT));
  // Deposit-funded bonds: one deposit, then claims sent without ETH.
  await t.openPosition(4, "0.50");
  await t.openPosition(5, "0.70");
  out.deposit = await gas(t.engine.connect(bob).deposit({ value: BOND * 5n }));
  out.decideHeuristic_fromDeposit = await gas(t.engine.connect(bob).decideHeuristic(4, PAST_ROUND));
  out.decideCommitment_fromDeposit = await gas(t.engine.connect(bob).decideCommitment(5, PAST_ROUND, MH, commitmentOf(await t.features(5), 120000)));
  out.verifyProof_standalone = Number(await real.verifyProof.estimateGas(high.proof, ins(high)));
  out.decideZkProof = await gas(t.engine.decideZkProof(3, PAST_ROUND, MH, high.proof, ins(high)));

  // The consumer: execute the approved (soft) liquidation.
  const liq = await (await ethers.getContractFactory("TrustTierLiquidator")).deploy(await t.engine.getAddress(), await t.pool.getAddress());
  out.deploy_TrustTierLiquidator = Number((await liq.deploymentTransaction().wait()).gasUsed);
  await t.engine.setLiquidator(await liq.getAddress());
  await t.pool.setLiquidator(await liq.getAddress());
  out.liquidate = await gas(liq.connect(carol).liquidate(3));
  out.fundRewards = await gas(t.engine.fundRewards({ value: BOND }));

  await increaseTime(3601);
  await t.priceFeed.updateAnswer(BigInt(high.price_now)); // keep the feed fresh (round 3)
  out.reclaimBond = await gas(t.engine.connect(carol).reclaimBond(2));
  out.setTier2Verifier = await gas(t.engine.setTier2Verifier(await real.getAddress(), MH));

  // Deployment 2: the watch-band sample - a Tier-1 claim slashed by a real proof.
  const watch = samples.watch_high;
  const w = await deployTrustTier({ verifier: await real.getAddress(), modelHash: MH, ...feedOpts(watch) });
  await w.openPosition(1, ltvOf(watch), { ageDays: watch.age_days, topupDays: watch.topup_days_ago });
  await w.engine.connect(alice).decideCommitment(1, PAST_ROUND, MH, commitmentOf(await w.features(1), 120000), { value: BOND });
  out.challengeDecision = await gas(w.engine.connect(bob).challengeDecision(1, MH, watch.proof, ins(watch)));
  out.withdraw = await gas(w.engine.connect(bob).withdraw());

  // Deployment 3: the same claim slashed through commit-reveal, and a
  // Tier-2 decision on anchored features after a feed update.
  const v = await deployTrustTier({ verifier: await real.getAddress(), modelHash: MH, ...feedOpts(watch) });
  await v.openPosition(1, ltvOf(watch), { ageDays: watch.age_days, topupDays: watch.topup_days_ago });
  await v.engine.connect(alice).decideCommitment(1, PAST_ROUND, MH, commitmentOf(await v.features(1), 120000), { value: BOND });
  const ch = ethers.keccak256(coder.encode(["address", "uint256", "bytes32", "bytes32"],
    [bob.address, 1, await v.engine.featureSnapshot(1), ethers.keccak256(watch.proof)]));
  out.commitChallenge = await gas(v.engine.connect(bob).commitChallenge(1, ch));
  out.revealChallenge = await gas(v.engine.connect(bob).revealChallenge(1, MH, watch.proof, ins(watch)));
  const a = await deployTrustTier({ verifier: await real.getAddress(), modelHash: MH, ...feedOpts(high) });
  await a.openPosition(1, ltvOf(high), { ageDays: high.age_days, topupDays: high.topup_days_ago });
  out.anchorFeatures = await gas(a.engine.anchorFeatures(1, PAST_ROUND));
  await a.priceFeed.updateAnswer(BigInt(high.price_now) - 1n); // a tick against the borrower while proving
  out.decideZkProof_anchored = await gas(a.engine.decideZkProof(1, PAST_ROUND, MH, high.proof, ins(high)));

  out.proofCalldataBytes = (high.proof.length - 2) / 2;
  out.publicInputs = high.public_inputs.length;
  out.verifierDeployedBytes = ((await ethers.provider.getCode(await real.getAddress())).length - 2) / 2;
  out.engineDeployedBytes = ((await ethers.provider.getCode(await t.engine.getAddress())).length - 2) / 2;
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
