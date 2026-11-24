# TrustTier

**A Cost-Tiered Zero-Knowledge Verification Framework for DeFi Liquidation Risk Scoring**

CSD436 (Blockchain Technology) course project.

**Live app:** https://gauravrai1704.github.io/TrustTier/ (rebuilt from `main` on every push; runs as an
in-browser simulation until you connect it to a router, see [The DApp](#the-dapp)).

TrustTier makes the strength of on-chain verification for a liquidation
decision grow with how close a position is to its liquidation boundary
(δ = liquidation threshold − LTV). **The chain itself computes δ and the
model's inputs** from the lending protocol and Chainlink feeds, and refuses
a tier that is too weak:

| Tier | Allowed when (enforced on-chain) | Evidence on-chain | Gas per decision* |
|---|---|---|---|
| 0 Heuristic | δ > B0(σ) (15% at σ = 35%) | Safe-claim + feature snapshot + gas-scaled bond, slashable for 1 h | 270,820 |
| 1 Commitment | δ > B1(σ) (5% at σ = 35%) | Registered model + salted commitment that must be opened in the window + snapshot + same bond | 380,479** |
| 2 zk-SNARK | always | Halo2 proof that the **registered weights**, run on the position's on-chain features, output "high risk"; verified on-chain; approves one liquidation | 1,004,422 |

\*Full decision transaction, including reading the position, both feeds and
the 24-hour price round and computing the features. Measured by
`scripts/measure_gas.js` with the real EZKL verifier and real proofs
(`off-chain/evaluation/results/gas_measurements.json`). \*\*Claim 341,390 + mandatory reveal 39,089.

The bands widen with the collateral's 30-day volatility σ:
B0(σ) = clamp(5% + 0.3σ, 10%, 30%) and B1(σ) = clamp(1.5% + 0.1σ, 3%, 12%)
(a one-week and a one-day two-standard-deviation move plus a buffer), computed
on-chain by `LiquidationEngine.tierBands`.

Cheap Tier 0/1 claims are optimistic: anyone holding a Tier-2 proof that the
position was high-risk *when the claim was made* can challenge within the
hour and take the bond. A Tier-2 approval is the only way the lending pool's
`TrustTierLiquidator` can liquidate: once, within 30 minutes, as a soft
liquidation (50% of the debt, 5% bonus to whoever executes it).

## Why a model, and why verify it

Every lending protocol already has a free rule: liquidate when the health
factor drops below 1 (LTV reaches the threshold). It acts only at the
boundary, so a crash day can push a position from safe to under water before
anyone can act. A model that sees volatility and momentum can act earlier
with a smaller, soft liquidation - acceptable only if its verdict is
verifiable, and affordable only if not every position pays for a proof.
On identical 30-day stress paths for 3,000 positions
(`evaluation/hf_baseline.py`):

| Policy | Forced liquidations | Insolvencies | Bad debt | Bonus paid by borrowers | Soft liquidations (unnecessary) | Decision gas / position-day |
|---|---|---|---|---|---|---|
| Health-factor rule | 2,461 | 61 | 0.018% | 1.35% | 0 | 0 |
| TrustTier | 373 | 6 | 0.003% | 1.63% | 2,262 (282) | 320 k |
| Always zk-proof | 373 | 6 | 0.003% | 1.63% | 2,262 (282) | 1,006 k |

The trade-off is real: borrowers pay more bonus in total and 23% of
soft-liquidated positions would have recovered. And the gas decides where it
pays: daily decisions cost under 0.5% of the debt per year from $3.5k on a
rollup but only from ~$350k-$1.4M on L1 (`evaluation/bond_economics.py`).

**On real borrowers.** The model is trained on 57,081 real Aave V2
position-days of 1,297 borrowers, read from an archive node
(`evaluation/aave_fetch.py`, `aave_real.py`) and labelled by whether the
account became liquidatable within 7 days. Replayed through the contract's
rules (`evaluation/aave_eval.py`): tiering saves 66% of decision gas on random
borrowers; the proven model approves 838 soft liquidations where a
distance-only rule approves 2,023 (−59%), keeping 80 of the rule's 124 that
were real; and it warned 228 of the 386 accounts that became liquidatable at
least a day ahead (median 6 days). The adaptive bands make 27-33% fewer cheap
claims that went bad within a week than fixed 15%/5% bands.

## Verified inputs, not trusted inputs

Earlier versions trusted an off-chain party twice: a feature oracle
committed each position's features, and the router computed δ and chose
the tier. Both are gone. `LiquidationEngine.currentFeatures` reads:

| Feature | On-chain source |
|---|---|
| utilization (LTV ÷ threshold) and δ | the lending protocol (`IPositionSource`: Aave V3 via `AaveV3PositionSource`, or `MockLendingPool` for demos) |
| 30-day volatility | a Chainlink realized-volatility feed |
| 24-hour momentum | the Chainlink price feed now vs. the round in effect 24 h ago |
| days since top-up, account age | the lending protocol's (or adapter's) timestamps |

and quantizes each to an integer in [0, 1024], exactly the values the
circuit sees. The circuit's feature inputs are **public**, so:

- `decideZkProof` accepts a proof only if its five feature inputs equal
  the features the contract computes in the same transaction - a proof for
  another position, or for this one before its price or collateral changed,
  reverts (`ProofNotForPosition`).
- the circuit hashes the model's weights (Poseidon, EZKL `hashed/public`) into
  public input 0, and the engine requires it to equal `tier2WeightsHash`: a
  proof made with any other weights reverts (`WrongModelWeights`). Without
  this, a prover could use forged weights that label everything "high risk"
  and the verifier would accept it (`docs/SECURITY.md` finding 32).
- every `decide*` enforces the tier bands from its own δ (`TierNotAllowed`).
- Tier 0/1 claims snapshot the features they were made on, and a challenge
  must prove high risk *on that snapshot*: an honest claimant is not slashed
  because prices moved later, and a false one is slashed even after topping up.

The only things still trusted are what the lending protocol already trusts
(its accounting and its Chainlink feeds) and the governance-controlled
pointer to the position source. Features are public chain data anyway; the
model weights stay private behind their hash. See `docs/SECURITY.md` findings 15, 20-22, 32.

## Status

- **Verified inputs** (above): no feature oracle; δ and tiers enforced on-chain;
  an Aave V3 adapter and a demo lending pool with Chainlink-compatible feeds.
- **Tier-2 needs proven risk** - a valid proof that a position is *safe*
  does not approve its liquidation.
- **Salted Tier-1 commitments**, and `revokeModel` rejects double revocation.
- **Multisig + timelock governance** - an M-of-N multisig is the only
  proposer of an OpenZeppelin `TimelockController` that owns every contract.
- **Model v3, trained on real outcomes** - 40,651 Aave V2 position-days of
  1,176 accounts, split by account; held-out accuracy 90.9%, ROC-AUC 0.921.
  The first feature is utilization (LTV ÷ threshold).
- **Weights bound in the proof; public SRS** - the Poseidon hash of the
  weights is a public input checked on-chain, and the KZG SRS is the public
  perpetual-powers-of-tau one (`ezkl.get_srs`, hash-checked).
- **Volatility-adaptive bands** - enforced on-chain, mirrored by the router and the DApp.
- **Real proving in the router and the DApp** - Tier-2 decisions and
  challenges use real EZKL proofs (~10 s on 4 vCPUs) against the real verifier.
- **Incentives** - the bond is `max(0.01 ETH, 1.5M gas x basefee)`, so
  slashing a false claim pays at any gas price (a fixed 0.01 ETH bond stops
  paying above 12.4 gwei); a protocol-funded reward pool pays honest claims
  (once per position per day); Tier-1 commitments must be opened in the
  window or forfeit; challenges are committed a block before they are
  revealed, so they cannot be front-run.
- **Execution** - `TrustTierLiquidator` consumes a Tier-2 approval and the
  pool performs a soft liquidation; approvals expire after 30 minutes.
- **Slow proofs** - `anchorFeatures` fixes a position's features for 10
  minutes; a proof on them is accepted while the position has not become
  safer, so a feed update during the ~10 s of proving does not force a
  re-proof.
- **Feeds** - Chainlink phase boundaries are handled; an optional L2
  sequencer-uptime feed blocks decisions while the sequencer is down.
- **Lifecycle** - a cheap claim blocks other cheap claims for its 1-hour
  window but never a needed liquidation: a Tier-2 proof of high risk *now*
  supersedes it (the claim stays challengeable and reclaimable). A
  successful challenge re-opens the position for Tier 2; the next decision
  after an unchallenged window re-opens it (settling the honest bond).
- **Parallel-friendly bonds** - a claim sent without ETH draws its bond from the
  claimant's own deposit (`deposit()`), so cheap claims never write the
  engine's shared ETH balance; traced blocks show this is what keeps them
  parallel on an engine that treats balance updates as read-modify-writes.
- **The router never makes a claim its own watcher could slash** - a Tier-1
  position the model flags as high risk is escalated to Tier 2.
- **Sepolia-ready** - the verifier is 20,361 bytes (24 KB limit); the full
  deployment is rehearsed on a local node. The broadcast needs your RPC URL
  and a funded testnet key (see "Deploying to Sepolia").

Tests: **130 contract tests** (Hardhat) and **94 Python tests** pass; Slither reports no findings and
Echidna checks seven invariants over 100,000 random calls (`docs/FUZZING.md`). CI runs all of them on every push.

## Results

| Measure | Value |
|---|---|
| Proving time per Tier-2 proof | ~10 s on 4 vCPUs (EZKL, 2^16-row circuit, 785 MB proving key) |
| Proof calldata | 4,480 bytes; 9 public instances [weights hash, 5 features, label, P(low), P(high)] |
| On-chain verification (standalone) | 745,517 gas |
| Full Tier-2 decision / challenge / commit-reveal challenge / liquidation | 1,004,422 / 804,800 / 900,046 / 96,582 gas |
| Gas vs always-zkML, real Aave V2 random borrowers (33,676 position-days) | **66.0% saving**; tiers 23,620 / 8,033 / 2,023 |
| Gas vs always-zkML, 374-position design set | **40.6% saving** (223.0 M vs 375.7 M); tiers 146 / 73 / 155 |
| Soft liquidations approved, real random borrowers (model vs δ-only rule) | 838 vs 2,023; 80 vs 124 became liquidatable within 7 days |
| Accounts warned ≥ 1 day before becoming liquidatable | 228 of 386 (median lead 6 days) |
| vs health-factor rule, 3,000-position 30-day stress test | forced liquidations −85%, insolvencies 61 → 6 |
| Decisions per 60 M-gas block (Tier 0 / Tier 1 / Tier 2, real verifier) | 216 / 172 / 59 |
| Parallel EVM (RISE pevm, Block-STM), 374-decision block, real verifier | @@PEVM@@ |
| Model size: 29 → 4,609 parameters | ROC-AUC 0.907-0.922; proving 6.6 s → 56.6 s, proving key 392 MB → 3.1 GB |
| Watcher profit at 20 gwei (fixed bond / gas-scaled bond) | −0.0061 / +0.0139 ETH |
| Scheduling rounds for 374 decisions (old array log → per-position storage) | 374 → 1 |
| Circuit/ONNX label agreement on 200 random positions | 200/200 (`circuits/fidelity.json`) |

## Baseline: on-chain inference (Alhaidari et al., AFT 2025)

The closest published system runs the model *inside* the contract, with
fixed-point weights in storage. `contracts/baselines/OnChainMLPBaseline.sol`
rebuilds that approach for TrustTier's own model and verified features
(`scripts/baseline_onchain.js`, `evaluation/baseline_onchain.py`):

| | On-chain inference | Always zk-proof | TrustTier |
|---|---|---|---|
| Soft liquidations approved / became liquidatable in 7 d (real random borrowers) | 838 / 80 | 838 / 80 | 838 / 80 |
| Gas per decision (average) | 281-303 k | 1,004 k | 341 k |
| Model weights | public | hidden (Poseidon-committed) | hidden |
| Gas as the model grows (29 → 4,609 weights) | 0.12 M → 13.8 M per inference | flat (~742 k verify) | flat |

Same decisions (the model never flags a position outside the Tier-2 band). For
our 57-weight model on-chain inference is ~11% cheaper; from 113 weights on it
costs more than TrustTier, from 449 more than proving every decision, and with
public weights anyone can see that a dust top-up flips 26% of flagged
position-days.

## L1 vs L2 (live fees)

`NODE_USE_ENV_PROXY=1 node scripts/l2_costs.js` prices every action from live
mainnet fee data (OP Stack `GasPriceOracle.getL1Fee`, Arbitrum
`NodeInterface.gasEstimateL1Component`; nothing is sent). Snapshot
2026-11-24, ETH $1,699, per position-year = one decision a day with
the real tier mix:

| Chain | Gas price (gwei) | Tier 0 | Tier 2 | TrustTier / yr | On-chain inference / yr | Always zk / yr |
|---|---|---|---|---|---|---|
| Ethereum L1 | 0.2307 | $0.106 | $0.394 | $48.81 | $43.37 | $143.76 |
| Base | 0.0069 | $0.0032 | $0.012 | $1.47 | $1.30 | $4.35 |
| OP Mainnet | 0.0010 | $0.0005 | $0.0019 | $0.225 | $0.196 | $0.711 |
| Arbitrum One | 0.0203 | $0.0094 | $0.035 | $4.33 | $3.83 | $12.87 |

On live testnets: Actions → **Testnet costs (L1 vs L2)** deploys a benchmark
copy to Sepolia, Base Sepolia, OP Sepolia or Arbitrum Sepolia, sends real
decisions (Tier 2 with a real proof) and the baseline, and commits what each
transaction paid (`results/testnet_costs/`). Fund the `PRIVATE_KEY` address on
that testnet first (the workflow file lists faucets and bridges).

## Repository layout

```
contracts/
  ModelRegistry.sol          trusted model hashes (register / revoke)
  TierAuditLog.sol           one record per position (mapping, not an array)
  LiquidationEngine.sol      on-chain features + delta, tier enforcement,
                             snapshots, gas-scaled bonds, rewards, reveals,
                             commit-reveal challenges, anchors, approvals
  consumers/
    TrustTierLiquidator.sol  executes a Tier-2 approval exactly once
  interfaces/                IPositionSource, ILiquidationTarget, AggregatorV3Interface, ITier2Verifier
  sources/
    AaveV3PositionSource.sol reads an Aave V3 account (getUserAccountData)
    MockLendingPool.sol      demo lending protocol valued by price feeds; soft liquidations
  EzklVerifier.sol           Halo2Verifier generated by EZKL (do not edit)
  governance/
    TrustTierMultisig.sol    minimal M-of-N wallet
    TrustTierTimelock.sol    OpenZeppelin TimelockController
  baselines/                 OnChainMLPBaseline (on-chain inference, AFT 2025)
  mocks/                     MockTier2Verifier, MockV3Aggregator, MockPhasedAggregator, MockAavePool
test/                        Hardhat tests (130): engine, incentives + liquidator,
                             Aave adapter, registry, log, real verifier, real
                             proofs end to end, governance
scripts/
  deploy.js                  deploy + wire + register model (+ governance)
  governance.js              propose / confirm / execute timelocked changes
  measure_gas.js             measures every entry point
  block_capacity.js          decisions per 60 M-gas block, per tier
  concurrency_trace.js       opcode-traced blocks; PEVM_EXPORT=1 exports them for pevm
  slither_run.py             Slither with a deeper recursion limit
circuits/
  build_circuit.py           ONNX -> public-input circuit -> keys -> proofs
                             -> Solidity verifier -> samples.json
  make_proving_key.py        rebuilds pk.key (~785 MB, not shipped) from kzg.srs
  settings.json, network.compiled, kzg.srs, vk.key, proof.json,
  calldata.bytes, samples.json, fidelity.json
off-chain/
  main.py                    FastAPI router API
  risk_model/                features + bounds, training (real Aave data; synthetic fallback),
                             inference, onchain_features (mirror of the
                             contract's feature arithmetic)
  router/                    tiering (mirrors the on-chain bands), salted
                             commitment, chain client (reads the engine's
                             features, finds the 24 h round), EZKL prover,
                             processor, position stream
  sentinel/                  live monitor (alerts on successful challenges)
  evaluation/                cost model (reads measured gas), Aave V2 archive
                             fetch + replay, model-size study, health-factor
                             baseline, bond economics, band sweeps,
                             concurrency studies, pevm_bench (Rust), reports
  ledger/                    SQLite database: event indexer, action log, users, sessions
  tests/                     94 tests
frontend/                    React DApp (light/dark): overview + guided demo,
                             positions, watchtower, economics, activity,
                             protocol; live mode or in-browser simulation
.github/workflows/           tests on every push; DApp to GitHub Pages
docs/SECURITY.md             32 findings, their status, and the trust assumptions
docs/SNARK_VS_STARK.md       why Tier 2 uses a SNARK
```

## Reproduce everything (one command)

With only Docker:

```bash
docker build -t trusttier .
docker run --rm trusttier            # ~2-3 min after the build
```

or natively (Node 20, Python 3.11): `make reproduce`. Either way it rebuilds
the 785 MB proving key from the shipped SRS, runs the 130 contract and 94
Python tests, Slither and Echidna (`docs/FUZZING.md`), re-measures gas,
regenerates every evaluation, and reports whether each deterministic result
file matches the committed one. On our machine and in the container all six
match byte for byte. `make results-proving` adds the real-proof throughput
benchmark; `make paper` builds the PDF. Cite with `CITATION.cff`.

## Quick start (local)

Prerequisites: Node 18+, Python 3.11+.

```bash
npm install
cd off-chain && pip install -r requirements.txt && cd ..
pip install -r circuits/requirements.txt          # ezkl

# 1. Proving key for real Tier-2 proofs (785 MB, not shipped).
#    Rebuilt from the shipped SRS; checked to match the shipped verifier.
cd circuits && python3 make_proving_key.py && cd ..
#    (To change the model: `python -m risk_model.train` in off-chain/, then
#     `python3 build_circuit.py` in circuits/ - regenerates everything.)

# 2. Tests
npx hardhat test                                   # 130 passing
cd off-chain && python -m pytest tests -q && cd .. # 94 passing
#    (offline machines: HARDHAT_LOCAL_SOLC=1 compiles with the solc npm package)

# 3. Local chain + contracts (real verifier; use VERIFIER_MODE=mock for instant fake proofs)
npx hardhat node                                   # terminal 1
VERIFIER_MODE=real npx hardhat run scripts/deploy.js --network localhost

#    deploy.js also deploys MockLendingPool with four markets (ETH, WBTC, LINK, "ETH volatile"),
#    each with Chainlink-compatible price + volatility feeds and a 24 h history.
# 4. Router demo: opens positions in the pool, then routes them (real proofs, ~10 s per Tier-2 position)
cd off-chain && python -m scripts.run_synthetic_stream 9

# 5. API, sentinel and DApp
uvicorn main:app --port 8000                       # terminal 2 (in off-chain/)
python -m sentinel.watch                           # terminal 3 (in off-chain/)
cd frontend && npm install && npm run dev          # terminal 4, open http://127.0.0.1:5173
```

## Accounts, the database and Sepolia

**Sign in with a key generated in your browser.** "Sign in → Create account"
generates an Ethereum key with a 12-word recovery phrase, encrypts it with your
password into a standard keystore (scrypt, the format MetaMask and geth import)
and keeps it in this browser only. You can also import a key or phrase, or use
MetaMask. The account signs in with Ethereum (SIWE) and then signs its own
transactions: claims (with its own bond), commit-reveal challenges, Tier-2
decisions with a proof from the router, liquidations and withdrawals. On a
local chain, "Get 10 test ETH" funds it. The router never sees the key: its
`/rpc` proxy forwards only read calls and already-signed transactions, never
`eth_sendTransaction` (the node's unlocked accounts stay unreachable).

**The ledger database** (`off-chain/ledger/`, SQLite at `off-chain/data/trusttier.db`):

| Table | What it holds |
|---|---|
| `events` | every event the TrustTier contracts emitted, decoded, with the transaction's sender and block time, indexed continuously from the chain |
| `actions` | every action requested through the router's API, with the signed-in address, outcome and gas, plus wallet-signed actions the app reports |
| `users`, `sessions` | SIWE sign-ins |
| `sync_state` | indexing progress; a restarted local chain opens a new epoch, so earlier runs are kept separately |

The chain stays the source of truth: `python -m ledger.indexer` rebuilds the
event table from it at any time. The **Ledger** page shows totals, leaderboards
(watchers, claimants, liquidators), a filterable event table with CSV export,
the action log and a history page per account. API: `/db/summary`,
`/db/events`, `/db/events.csv`, `/db/leaderboard`, `/db/accounts/{address}`,
`/db/actions`, `/db/deployments`.

**Deploying to Ethereum (Sepolia).** Once, add three repository secrets
(Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `SEPOLIA_RPC_URL` | an RPC endpoint (Infura, Alchemy, ...) |
| `PRIVATE_KEY` | a **testnet-only** key holding ~0.2 Sepolia ETH (a key generated in the app works: download its keystore, or import its phrase into MetaMask to export the key) |
| `ETHERSCAN_API_KEY` | optional, for source verification |

Then Actions → **Deploy to Sepolia** → Run workflow. It deploys the contracts
(real EZKL verifier, Chainlink's real ETH/USD feed for market 0, mock feeds for
the rest), verifies them on Etherscan (`scripts/verify.js`), commits
`deployments/sepolia.json` and rebuilds the site. From then on the hosted app
talks to Sepolia **directly from the browser** (no server): it reads the
contracts over a public RPC, shows Etherscan links for every transaction, and
your signed-in account makes Tier 0/1 claims, settles bonds and executes
approvals. Tier-2 proofs need the router's prover: run the router against
Sepolia (`TRUSTTIER_NETWORK=sepolia`, see below) and connect it. A scheduled
workflow (`sepolia-feeds.yml`) keeps the demo's mock feeds fresh.

## Parallel proving (prover pool)

Tier-2 proving (~10 s on 4 vCPUs) is the bottleneck, and it
peaks in a crash, when many positions need a proof at once. Borrowing the
leader/worker shape of BlockRaFT (Piduguralla et al., ICSA 2026), the router
can hand proofs to a pool of workers - local processes, or prover workers on
other machines - and submits the cheap claims while the proofs run:

```bash
# local workers: split this machine's cores
TRUSTTIER_PROVER_WORKERS=2 TRUSTTIER_PROVER_THREADS=2 uvicorn main:app --port 8000
# remote workers: on each extra machine (needs circuits/pk.key), then point the router at them
uvicorn router.prover_worker:app --host 0.0.0.0 --port 8100
TRUSTTIER_PROVER_REMOTES=http://worker-1:8100,http://worker-2:8100 uvicorn main:app --port 8000
```

Measured by `python -m evaluation.prover_pool` (12 real proofs per setting,
4-core machine; `results/prover_pool.md`): one EZKL proof already uses the
cores well (23.0 s on 1 thread, 6.4 s on 4), so splitting one machine gains
only 13% throughput and makes each proof 3.5x slower. Scaling out is what
works: two remote workers on separate 2-core sets prove 1.93x faster than one,
at the same latency. Keep remote workers on a private network.

## The DApp

`frontend/` is a React app with light and dark themes (follows the system,
toggle in the top bar). Pages: **Overview** (the idea, headline results and a
five-step guided demo), **Positions** (open positions, crash prices, route
streams; click a row for the position's gauge, features, model verdict,
lifecycle and actions), **Watchtower** (open claims with countdowns and a
one-click scan; approvals waiting for execution), **Economics** (every chart
reads the evaluation results), **Activity** (contract events) and
**Protocol** (deployment, trust assumptions, connection).

It runs in three modes, shown in the top bar:

- **On-chain** - when a router answers (the dev server proxies `/api`; a built
  site tries `http://127.0.0.1:8000`, configurable on the Protocol page).
  Actions are transactions; with a wallet connected, challenges, bond
  settlements and liquidations are signed by your wallet. On a local chain the
  clock button fast-forwards time to close windows or expire approvals.
- **Direct** - when a Sepolia deployment is bundled (after the deploy
  workflow): reads the contracts straight from a public RPC; your account
  signs every transaction. No server.
- **Simulation** - otherwise: the contract's
  rules, the real model (weights exported by `off-chain/scripts/export_model_js.py`
  and checked against ONNX) and the measured gas run in the browser. Nothing is
  on-chain and proofs are not generated; the app says so.

To use the hosted site against your own node, start the router with
`TRUSTTIER_CORS=https://gauravrai1704.github.io` (that origin is allowed by
default) and pick "Router only" on the Protocol page.

**Hosting.** `.github/workflows/pages.yml` builds and publishes the app on
every push to `main`, so code changes and re-run evaluation results appear on
the site automatically. One-time setup: repository **Settings → Pages →
Source: GitHub Actions**.

### The demo flow

The Overview page's guided demo runs it in five clicks:

1. Open collateral on the volatile ETH market (σ = 60%, threshold 0.86, bands
   23% / 7.5%) at LTV 0.78, account age 5 days, last top-up 89 days ago:
   δ = 8%, the chain accepts Tier 1 or 2, the model says high risk.
2. A dishonest router claims Tier 1 anyway and keeps its commitment closed.
   (Claiming Tier 0 would revert: `TierNotAllowed`.)
3. A watcher proves the snapshotted features (~10 s with the real prover):
   HIGH RISK. It commits, then reveals the challenge; the bond is slashed.
4. Routed honestly, the position needs Tier 2: the verified proof approves a
   liquidation.
5. `TrustTierLiquidator` executes the soft liquidation: half the debt is
   repaid and δ goes from 8% to ~20%.

The same steps are available per position on the Positions page, signed by
your wallet when one is connected; "−15%" on a market stages a crash.

## How proofs are tied to positions

- The circuit's input is the five quantized features q / 1024 with EZKL
  `input_visibility = "public"`, and the weights are hashed
  (`param_visibility = "hashed/public"`), so each proof's instances are
  `[h_weights, q_util, q_vol, q_mom, q_topup, q_age, label, P(low)*2^10, P(high)*2^10]`.
- `decideZkProof(positionId, pastRoundId, modelHash, proof, inputs)`
  recomputes q from on-chain state and requires `inputs[0] == tier2WeightsHash`,
  `inputs[1..5] == q` and `inputs[6] == 1`. `pastRoundId` is the price round in effect 24 hours ago;
  the router finds it (`ChainClient.find_past_round`) and the contract checks
  it (`BadMomentumRound`).
- Tier 0/1 claims store `keccak256(q)`; `challengeDecision` requires the
  proof's features to hash to it.
- `risk_model/onchain_features.py` mirrors the contract arithmetic; tests
  check it against the real proofs' instances and the contract's output.

## Governance

```bash
GOVERNANCE_OWNERS=0xA,0xB,0xC GOVERNANCE_THRESHOLD=2 TIMELOCK_DELAY=3600 \
  npx hardhat run scripts/deploy.js --network <net>
```

The deployer wires everything, registers the model, then hands ownership of
all three contracts to the timelock. To change something (for example swap
the verifier), owners run `scripts/governance.js`:

```bash
ACTION=propose PHASE=schedule TARGET=LiquidationEngine FN=setTier2Verifier \
  ARGS='["0xNewVerifier","0xModelHash","<weights hash from circuits/samples.json>"]' npx hardhat run scripts/governance.js --network <net>
ACTION=confirm TXID=0 ...   # second owner
ACTION=exec    TXID=0 ...   # schedules it on the timelock
# after TIMELOCK_DELAY: the same three steps with PHASE=execute
ACTION=status npx hardhat run scripts/governance.js --network <net>
```

The timelock salt defaults to a hash of FN + ARGS; set `SALT=...` to
re-apply a call identical to an earlier one (e.g. switching a verifier back).

## Deploying to Sepolia

The development sandbox cannot reach any Ethereum RPC endpoint, so the
broadcast is the one step to run from your own machine. Everything it runs
has been rehearsed on a local node with the real verifier and governance.

1. Copy `.env.example` to `.env`; set `SEPOLIA_RPC_URL`, `PRIVATE_KEY` (a
   testnet-only key) and `ETHERSCAN_API_KEY`. Fund the account from a
   Sepolia faucet: the full deployment (verifier 4.4 M, engine 3.5 M, pool,
   eight mock feeds, registry, log) uses about 13 M gas, so ~0.1-0.2
   Sepolia ETH is comfortable.
2. Deploy (real verifier is the default off local chains). Optionally use the
   real Chainlink ETH/USD feed on Sepolia for market 0 (a realized-volatility
   feed may not exist on Sepolia; the mock one is kept unless `VOL_FEED` is set):
   ```bash
   PRICE_FEED=<Chainlink ETH/USD on Sepolia> npx hardhat run scripts/deploy.js --network sepolia
   # against a real Aave V3 market instead of the demo pool:
   #   AAVE_POOL=... AAVE_ATOKEN=... PRICE_FEED=... VOL_FEED=...
   # optional governance: GOVERNANCE_OWNERS=... GOVERNANCE_THRESHOLD=2 TIMELOCK_DELAY=3600
   ```
3. Verify on Etherscan with the commands `deploy.js` prints.
4. Run the router against Sepolia:
   ```bash
   export TRUSTTIER_RPC_URL=$SEPOLIA_RPC_URL TRUSTTIER_NETWORK=sepolia TRUSTTIER_PRIVATE_KEY=$PRIVATE_KEY
   cd off-chain && python -m scripts.run_synthetic_stream 6   # ~10 s per Tier-2 proof
   uvicorn main:app --port 8000
   ```
   The router refreshes mock feeds it finds stale; real feeds are never touched.
5. Point MetaMask at Sepolia and use the DApp as above. `chain_client.py`
   refuses the public Hardhat test key on any non-local chain.

## Evaluation scripts

```bash
cd off-chain
RPC_URL=<archive node> python -m evaluation.aave_fetch   # real Aave V2 snapshots (MODE=liquidated too)
python -m evaluation.aave_real              # features + 7-day outcome labels -> data/aave_v2_*.{npz,parquet}
python -m risk_model.train                  # model v3 on those labels
python -m evaluation.aave_eval              # replay on real borrowers -> results/aave_eval.{md,json}
python -m evaluation.model_size             # why the model is small -> results/model_size.{md,json}
python -m evaluation.evaluate               # cost replay (design set) -> results/evaluation_report.{md,json}
python -m evaluation.hf_baseline            # vs the health-factor rule -> results/hf_baseline.{md,json}
python -m evaluation.bond_economics         # challenge incentives, L1 vs rollup -> results/bond_economics.{md,json}
python -m evaluation.outcome_labels         # second real-outcome check (Cred Protocol health-factor data)
python -m evaluation.concurrency_sim        # 374 -> 1 rounds -> results/concurrency_report.md
python -m evaluation.concurrency_ablation   # size / contention / tier mix
python -m evaluation.band_sensitivity       # tier bands + threshold sweep -> results/band_sensitivity.{md,tex}
cd .. && npx hardhat run scripts/concurrency_trace.js && cd off-chain
                                            # whole blocks of decisions, opcode-traced read/write sets
python -m evaluation.parallel_exec          # 1-64 thread schedules + Block-STM-style simulation on those sets
python -m evaluation.liquidator_race        # K competing bot threads on a live node (needs a node + mock deploy)
cd .. && npx hardhat run scripts/measure_gas.js > off-chain/evaluation/results/gas_measurements.json
npx hardhat run scripts/block_capacity.js   # decisions per block -> results/block_capacity.json
PEVM_EXPORT=1 npx hardhat run scripts/concurrency_trace.js   # then off-chain/evaluation/pevm_bench (RISE pevm)
```

`evaluation/cost_model.py` reads `gas_measurements.json` directly (a test
checks this), so re-measuring gas updates every report and the DApp's cost
panel.

## Known limitations

- **KZG needs a ceremony**: the SRS is the public perpetual-powers-of-tau
  one, secure if any participant was honest; a transparent proof system
  would remove even that (`docs/SNARK_VS_STARK.md`).
- **Trusted sources**: the engine trusts the lending protocol's accounting,
  the Chainlink feeds and the (timelocked) position-source pointer. Aave does
  not store account age or top-up times, so the Aave adapter observes them
  from registration and permissionless `poke`s (finding 21).
- **Real data is Aave V2 on Ethereum, daily**: ETH volatility stands in for
  each account's collateral mix, and intraday moves are seen at day
  granularity. Most near-boundary positions recover: 90% of the model's
  approvals on random borrowers did not become liquidatable within a week,
  so soft liquidations must stay small.
- **L1 economics**: daily decisions are affordable only for large positions
  on L1; the intended deployment is a rollup.
- **Unnecessary liquidations**: in the stress test 23% of soft-liquidated
  positions would have recovered.
- **Parallel EVM runs are in-memory**: RISE pevm executes the exported blocks
  without a client's storage I/O; mainnet clients execute sequentially today.
- **Base-fee spikes**: a bond covers a challenge while the base fee stays
  under ~1.86x its value at the claim.
