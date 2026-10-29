// Concurrency experiments, part 1: REAL read/write sets.
//
// For each scenario this script deploys TrustTier on the in-process Hardhat
// chain, opens the positions, puts a whole batch of decision transactions
// (plus optional duplicate attempts by competing liquidators and Chainlink
// heartbeat updates) into ONE block, mines it, and then replays every
// transaction with debug_traceTransaction. From the opcode trace it records
// exactly which storage slots each transaction read (SLOAD) and wrote
// (SSTORE), in which contract, and which account balances it moved.
//
// off-chain/evaluation/parallel_exec.py turns these sets into conflict
// graphs and simulates parallel execution with 1-64 threads.
//
//   npx hardhat run scripts/concurrency_trace.js
//
// Writes off-chain/evaluation/results/traces/<scenario>.json.
// The Tier-2 verifier is the mock: the real Halo2 verifier reads no storage,
// so its read/write sets are identical; gas for Tier 2 is rescaled to the
// measured real-verifier cost in the analysis.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "off-chain", "evaluation", "results", "traces");
const DAY = 24 * 3600;
const BOND = ethers.parseEther("0.01");
const PAST_ROUND = 1;
const MODEL = ethers.id("risk-model");
const MARKETS = [
  { name: "ETH", price: 2000, past: 2200, vol: 35, th: 8000 },
  { name: "WBTC", price: 60000, past: 59000, vol: 20, th: 7500 },
  { name: "LINK", price: 15, past: 14, vol: 60, th: 7000 },
];
const LTV_FOR_TIER = { 0: 0.45, 1: 0.68, 2: 0.95 }; // relative to an 0.80 threshold; rescaled per market
const e8 = (x) => BigInt(Math.round(x * 1e8));

// Deterministic PRNG so every run builds the same blocks.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

async function deploy(design) {
  const F = (n) => ethers.getContractFactory(n);
  const feeds = [];
  for (const m of MARKETS) {
    const p = await (await F("MockV3Aggregator")).deploy(8, `${m.name}/USD`, e8(m.past));
    const v = await (await F("MockV3Aggregator")).deploy(8, `${m.name} vol`, e8(m.vol));
    feeds.push({ p, v, m });
  }
  await network.provider.send("evm_increaseTime", [25 * 3600]);
  for (const f of feeds) {
    await f.p.updateAnswer(e8(f.m.price));
    await f.v.updateAnswer(e8(f.m.vol));
  }
  const pool = await (await F("MockLendingPool")).deploy();
  for (const f of feeds) await pool.addMarket(await f.p.getAddress(), await f.v.getAddress(), f.m.th);
  const registry = await (await F("ModelRegistry")).deploy();
  const log = await (await F(design === "legacy-array" ? "LegacyArrayAuditLog" : "TierAuditLog")).deploy();
  const verifier = await (await F("MockTier2Verifier")).deploy();
  const engine = await (await F("LiquidationEngine")).deploy(
    await registry.getAddress(), await log.getAddress(), await verifier.getAddress(), MODEL,
    await pool.getAddress(), 30 * DAY, 30 * DAY
  );
  await log.authorizeLogger(await engine.getAddress());
  await registry.registerModel(MODEL, "");
  const names = {
    [(await engine.getAddress()).toLowerCase()]: "LiquidationEngine",
    [(await log.getAddress()).toLowerCase()]: "TierAuditLog",
    [(await registry.getAddress()).toLowerCase()]: "ModelRegistry",
    [(await pool.getAddress()).toLowerCase()]: "LendingPool",
    [(await verifier.getAddress()).toLowerCase()]: "Tier2Verifier",
  };
  for (const f of feeds) {
    names[(await f.p.getAddress()).toLowerCase()] = `PriceFeed:${f.m.name}`;
    names[(await f.v.getAddress()).toLowerCase()] = `VolFeed:${f.m.name}`;
  }
  return { engine, pool, feeds, names };
}

const word = (hex) => "0x" + hex.slice(-40);

/** Storage and balance footprint of one transaction from its opcode trace. */
async function footprint(txHash, to, from, value, names) {
  const t = await network.provider.send("debug_traceTransaction", [txHash, { disableMemory: true, disableStorage: true }]);
  const label = (a) => names[a] || a;
  const reads = new Set(), writes = new Set(), balances = new Set();
  const stack = [to.toLowerCase()];
  let pendingCtx = null;
  let depth = 1;
  if (value > 0n) { balances.add(label(to.toLowerCase())); }
  balances.add(`account:${from.toLowerCase()}`); // nonce + gas payment
  for (const l of t.structLogs) {
    if (l.depth > depth) { stack.push(pendingCtx); }
    else while (l.depth < depth && stack.length > l.depth) { stack.pop(); }
    depth = l.depth;
    const ctx = stack[stack.length - 1];
    const st = l.stack || [];
    const top = (i) => st[st.length - 1 - i];
    switch (l.op) {
      case "SLOAD": reads.add(`${label(ctx)}#${BigInt("0x" + top(0)).toString(16)}`); break;
      case "SSTORE": writes.add(`${label(ctx)}#${BigInt("0x" + top(0)).toString(16)}`); break;
      case "CALL": case "CALLCODE": {
        const target = word(top(1)).toLowerCase();
        const val = BigInt("0x" + top(2));
        pendingCtx = l.op === "CALL" ? target : ctx;
        if (val > 0n) { balances.add(label(ctx)); balances.add(label(target)); }
        break;
      }
      case "STATICCALL": pendingCtx = word(top(1)).toLowerCase(); break;
      case "DELEGATECALL": pendingCtx = ctx; break;
      default: break;
    }
  }
  return { reads: [...reads], writes: [...writes], balances: [...balances], steps: t.structLogs.length };
}

/**
 * opts: n (decisions), mix [t0,t1,t2] fractions, contention (share of extra
 * duplicate attempts on already-targeted positions), oracleUpdates (heartbeat
 * price updates interleaved into the block), senders ("distinct" | "single"),
 * design ("final" | "legacy-array"), bonds ("value" | "deposit"), seed.
 */
async function runScenario(name, opts) {
  await network.provider.send("hardhat_reset", []);
  await network.provider.send("evm_setAutomine", [true]);
  const { engine, pool, feeds, names } = await deploy(opts.design || "final");
  const R = rng(opts.seed || 7);
  const [funder] = await ethers.getSigners();

  // Positions with the requested tier mix, spread over the three markets.
  const n = opts.n;
  const counts = opts.mix.map((f) => Math.round(f * n));
  counts[2] = n - counts[0] - counts[1];
  const plan = [];
  let pid = 1;
  for (let tier = 0; tier < 3; tier++) {
    for (let i = 0; i < counts[tier]; i++) {
      const mi = (pid - 1) % MARKETS.length;
      const m = MARKETS[mi];
      const ltv = LTV_FOR_TIER[tier] * (m.th / 8000);
      const debt = (e8(m.price) * BigInt(Math.round(ltv * 10000))) / 10000n;
      await pool.openPosition(pid, mi, 10n ** 18n, debt);
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await pool.setTimestamps(pid, now - Math.floor(30 + R() * 1400) * DAY, now - Math.floor(R() * 89) * DAY);
      plan.push({ pid, tier, market: mi });
      pid++;
    }
  }
  // Duplicate attempts by competing liquidators (they race for the same positions).
  const dups = Math.round((opts.contention || 0) * n);
  for (let i = 0; i < dups; i++) plan.push({ ...plan[Math.floor(R() * n)], duplicate: true });
  // Shuffle into an arrival order.
  for (let i = plan.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [plan[i], plan[j]] = [plan[j], plan[i]]; }
  // Heartbeat oracle updates at random points of the block.
  for (let u = 0; u < (opts.oracleUpdates || 0); u++) {
    plan.splice(Math.floor(R() * plan.length), 0, { oracle: u % MARKETS.length });
  }

  // Signers.
  const nSigners = opts.senders === "single" ? 1 : plan.length;
  const wallets = [];
  for (let i = 0; i < nSigners; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await network.provider.send("hardhat_setBalance", [w.address, "0x" + (10n ** 21n).toString(16)]);
    wallets.push(w);
    if (opts.bonds === "deposit") await engine.connect(w).deposit({ value: BOND * 4n });
  }

  // Precompute Tier-2 public inputs on the current state (mock proof).
  const inputsFor = {};
  for (const p of plan) {
    if (p.oracle === undefined && p.tier === 2 && !inputsFor[p.pid]) {
      const [q] = await engine.currentFeatures(p.pid, PAST_ROUND);
      inputsFor[p.pid] = [...q.map(BigInt), 1n, 3n, 1021n];
    }
  }

  // Build the block.
  await network.provider.send("evm_setAutomine", [false]);
  await network.provider.send("evm_setBlockGasLimit", ["0x" + (4n * 10n ** 9n).toString(16)]);
  const nonces = {};
  const bondValue = opts.bonds === "deposit" ? 0n : BOND;
  const sent = [];
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const w = wallets[opts.senders === "single" ? 0 : i];
    nonces[w.address] = nonces[w.address] ?? (await ethers.provider.getTransactionCount(w.address));
    const ov = { gasLimit: 3_000_000, nonce: nonces[w.address]++, gasPrice: ethers.parseUnits("2", "gwei") };
    let tx, kind;
    if (p.oracle !== undefined) {
      const f = feeds[p.oracle];
      tx = await f.p.connect(w).updateAnswer(e8(f.m.price), ov);
      kind = "oracle";
    } else if (p.tier === 0) {
      tx = await engine.connect(w).decideHeuristic(p.pid, PAST_ROUND, { ...ov, value: bondValue }); kind = "tier0";
    } else if (p.tier === 1) {
      tx = await engine.connect(w).decideCommitment(p.pid, PAST_ROUND, MODEL, ethers.id(`c${p.pid}`), { ...ov, value: bondValue }); kind = "tier1";
    } else {
      tx = await engine.connect(w).decideZkProof(p.pid, PAST_ROUND, MODEL, "0x01", inputsFor[p.pid], ov); kind = "tier2";
    }
    sent.push({ hash: tx.hash, kind, pid: p.pid ?? null, market: p.market ?? p.oracle, duplicate: !!p.duplicate,
      from: w.address, to: tx.to, value: tx.value });
  }
  await network.provider.send("evm_mine", []);
  await network.provider.send("evm_setAutomine", [true]);
  const block = await ethers.provider.getBlock("latest");
  if (block.transactions.length !== sent.length) throw new Error(`block has ${block.transactions.length}/${sent.length} txs`);
  const order = Object.fromEntries(block.transactions.map((h, i) => [h, i]));

  const txs = [];
  for (const s of sent) {
    const r = await ethers.provider.getTransactionReceipt(s.hash);
    const fp = await footprint(s.hash, s.to, s.from, s.value, names);
    txs.push({ index: order[s.hash], kind: s.kind, positionId: s.pid, market: s.market, duplicate: s.duplicate,
      status: r.status, gasUsed: Number(r.gasUsed), ...fp });
  }
  txs.sort((a, b) => a.index - b.index);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ name, opts, txs }, null, 1));
  const ok = txs.filter((t) => t.status === 1).length;
  console.log(`${name}: ${txs.length} txs in one block, ${ok} succeeded, ${txs.length - ok} reverted`);
}

async function main() {
  const MIX = [126 / 374, 83 / 374, 165 / 374]; // the evaluation's tier mix
  const S = [];
  // Design and batch-size ablation.
  for (const n of [50, 100, 200, 374]) {
    S.push([`final_n${n}`, { n, mix: MIX }]);
    S.push([`legacy_n${n}`, { n, mix: MIX, design: "legacy-array" }]);
    S.push([`deposit_n${n}`, { n, mix: MIX, bonds: "deposit" }]);
  }
  // Same-position contention (competing liquidators).
  for (const c of [0.05, 0.1, 0.2, 0.3, 0.5]) S.push([`final_contention${Math.round(c * 100)}`, { n: 200, mix: MIX, contention: c }]);
  // Oracle heartbeat updates inside the block.
  for (const u of [1, 3, 6]) S.push([`final_oracle${u}`, { n: 200, mix: MIX, oracleUpdates: u }]);
  // Tier mix.
  S.push(["final_mix_t0heavy", { n: 200, mix: [0.8, 0.15, 0.05] }]);
  S.push(["final_mix_t2heavy", { n: 200, mix: [0.1, 0.2, 0.7] }]);
  // One liquidator bot submitting the whole batch (one sender, a nonce chain).
  S.push(["final_single_sender", { n: 200, mix: MIX, senders: "single" }]);
  const only = process.env.SCENARIO;
  for (const [name, opts] of S) if (!only || name === only) await runScenario(name, opts);
}

main().catch((e) => { console.error(e); process.exit(1); });
