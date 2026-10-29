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
| 0 Heuristic | δ > 15% | Safe-claim + feature snapshot + gas-scaled bond, slashable for 1 h | 269,534 |
| 1 Commitment | δ > 5% | Registered model + salted commitment that must be opened in the window + snapshot + same bond | 379,161** |
| 2 zk-SNARK | always | Halo2 proof that the model, run on the position's on-chain features, outputs "high risk"; verified on-chain; approves one liquidation | 878,059 |

\*Full decision transaction, including reading the position, both feeds and
the 24-hour price round and computing the features. Measured by
`scripts/measure_gas.js` with the real EZKL verifier and real proofs
(`off-chain/evaluation/results/gas_measurements.json`). \*\*Claim 340,072 + mandatory reveal 39,089.

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
| TrustTier | 297 | 2 | 0.001% | 1.67% | 2,365 (323) | 322 k |
| Always zk-proof | 297 | 2 | 0.001% | 1.67% | 2,368 (323) | 880 k |

The trade-off is real: borrowers pay more bonus in total and 26% of
soft-liquidated positions would have recovered. And the gas decides where it
pays: daily decisions cost under 0.5% of the debt per year from $3.5k on a
rollup but only from ~$350k-$1.4M on L1 (`evaluation/bond_economics.py`).

## Verified inputs, not trusted inputs

Earlier versions trusted an off-chain party twice: a feature oracle
committed each position's features, and the router computed δ and chose
the tier. Both are gone. `LiquidationEngine.currentFeatures` reads:

| Feature | On-chain source |
|---|---|
| LTV and δ | the lending protocol (`IPositionSource`: Aave V3 via `AaveV3PositionSource`, or `MockLendingPool` for demos) |
| 30-day volatility | a Chainlink realized-volatility feed |
| 24-hour momentum | the Chainlink price feed now vs. the round in effect 24 h ago |
| days since top-up, account age | the lending protocol's (or adapter's) timestamps |

and quantizes each to an integer in [0, 1024], exactly the values the
circuit sees. The circuit's feature inputs are **public**, so:

- `decideZkProof` accepts a proof only if its first five public inputs equal
  the features the contract computes in the same transaction - a proof for
  another position, or for this one before its price or collateral changed,
  reverts (`ProofNotForPosition`).
- every `decide*` enforces the tier bands from its own δ (`TierNotAllowed`).
- Tier 0/1 claims snapshot the features they were made on, and a challenge
  must prove high risk *on that snapshot*: an honest claimant is not slashed
  because prices moved later, and a false one is slashed even after topping up.

The only things still trusted are what the lending protocol already trusts
(its accounting and its Chainlink feeds) and the governance-controlled
pointer to the position source. Features are public chain data anyway; the
model weights stay private. See `docs/SECURITY.md` findings 15, 20-22.

## Status

- **Verified inputs** (above): no feature oracle; δ and tiers enforced on-chain;
  an Aave V3 adapter and a demo lending pool with Chainlink-compatible feeds.
- **Tier-2 needs proven risk** - a valid proof that a position is *safe*
  does not approve its liquidation.
- **Salted Tier-1 commitments**, and `revokeModel` rejects double revocation.
- **Multisig + timelock governance** - an M-of-N multisig is the only
  proposer of an OpenZeppelin `TimelockController` that owns every contract.
- **Model v2** - trained on normalized features with labels centred near the
  liquidation threshold (validation accuracy 95.9%, ROC-AUC 0.995).
- **Real proving in the router and the DApp** - Tier-2 decisions and
  challenges use real EZKL proofs (~16 s) against the real verifier.
- **Incentives** - the bond is `max(0.01 ETH, 1.5M gas x basefee)`, so
  slashing a false claim pays at any gas price (a fixed 0.01 ETH bond stops
  paying above 14.7 gwei); a protocol-funded reward pool pays honest claims
  (once per position per day); Tier-1 commitments must be opened in the
  window or forfeit; challenges are committed a block before they are
  revealed, so they cannot be front-run.
- **Execution** - `TrustTierLiquidator` consumes a Tier-2 approval and the
  pool performs a soft liquidation; approvals expire after 30 minutes.
- **Slow proofs** - `anchorFeatures` fixes a position's features for 10
  minutes; a proof on them is accepted while the position has not become
  safer, so a feed update during the ~16 s of proving does not force a
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
- **Sepolia-ready** - the verifier is 15,612 bytes (24 KB limit); the full
  deployment is rehearsed on a local node. The broadcast needs your RPC URL
  and a funded testnet key (see "Deploying to Sepolia").

Tests: **126 contract tests** (Hardhat) and **87 Python tests** pass (CI runs both on every push).

## Results

| Measure | Value |
|---|---|
| Proving time per Tier-2 proof | ~16 s (EZKL, 2^16-row circuit, 575 MB proving key) |
| Proof calldata | 3,584 bytes; 8 public instances [5 features, label, P(low), P(high)] |
| On-chain verification (standalone) | 621,921 gas |
| Full Tier-2 decision / challenge / commit-reveal challenge / liquidation | 878,059 / 678,771 / 773,609 / 96,402 gas |
| Gas vs always-zkML, 374 positions (74 real Aave V2 + 300 synthetic) | **36.0% saving** (210.3 M vs 328.4 M); tiers 126 / 83 / 165 |
| vs health-factor rule, 3,000-position 30-day stress test | forced liquidations −88%, insolvencies 61 → 2 |
| Watcher profit at 20 gwei (fixed bond / gas-scaled bond) | −0.0036 / +0.0164 ETH |
| Tier-1 positions escalated to Tier 2 (model flags high risk) | 21 |
| Tier-2 positions protected (proof shows low risk, no liquidation) | 9 of 165 |
| Tier-0 positions the model flags high-risk | 1 of 126 (0.8%) |
| Scheduling rounds for 374 decisions (old array log → per-position storage) | 374 → 1 |
| Circuit/ONNX label agreement on 200 random positions | 200/200 (`circuits/fidelity.json`) |

The incentive layer costs ~3k gas per decision plus the 39k Tier-1 reveal,
which moved the saving from 37.1% to 36.0%. Per dataset: real wallet 29.7%,
synthetic 37.5%.

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
  mocks/                     MockTier2Verifier, MockV3Aggregator, MockPhasedAggregator, MockAavePool
test/                        Hardhat tests (126): engine, incentives + liquidator,
                             Aave adapter, registry, log, real verifier, real
                             proofs end to end, governance
scripts/
  deploy.js                  deploy + wire + register model (+ governance)
  governance.js              propose / confirm / execute timelocked changes
  measure_gas.js             measures every entry point
circuits/
  build_circuit.py           ONNX -> public-input circuit -> keys -> proofs
                             -> Solidity verifier -> samples.json
  make_proving_key.py        rebuilds pk.key (~575 MB, not shipped) from kzg.srs
  settings.json, network.compiled, kzg.srs, vk.key, proof.json,
  calldata.bytes, samples.json, fidelity.json
off-chain/
  main.py                    FastAPI router API
  risk_model/                features + bounds, synthetic data, training,
                             inference, onchain_features (mirror of the
                             contract's feature arithmetic)
  router/                    tiering (mirrors the on-chain bands), salted
                             commitment, chain client (reads the engine's
                             features, finds the 24 h round), EZKL prover,
                             processor, position stream
  sentinel/                  live monitor (alerts on successful challenges)
  evaluation/                cost model (reads measured gas), real-data replay,
                             health-factor baseline, bond economics,
                             outcome labels, concurrency studies, reports
  ledger/                    SQLite database: event indexer, action log, users, sessions
  tests/                     87 tests
frontend/                    React DApp (light/dark): overview + guided demo,
                             positions, watchtower, economics, activity,
                             protocol; live mode or in-browser simulation
.github/workflows/           tests on every push; DApp to GitHub Pages
docs/SECURITY.md             31 findings, their status, and the trust assumptions
docs/SNARK_VS_STARK.md       why Tier 2 uses a SNARK
```

## Quick start (local)

Prerequisites: Node 18+, Python 3.11+.

```bash
npm install
cd off-chain && pip install -r requirements.txt && cd ..
pip install -r circuits/requirements.txt          # ezkl

# 1. Proving key for real Tier-2 proofs (575 MB, not shipped).
#    Rebuilt from the shipped SRS; checked to match the shipped verifier.
cd circuits && python3 make_proving_key.py && cd ..
#    (To change the model: `python -m risk_model.train` in off-chain/, then
#     `python3 build_circuit.py` in circuits/ - regenerates everything.)

# 2. Tests
npx hardhat test                                   # 126 passing
cd off-chain && python -m pytest tests -q && cd .. # 87 passing
#    (offline machines: HARDHAT_LOCAL_SOLC=1 compiles with the solc npm package)

# 3. Local chain + contracts (real verifier; use VERIFIER_MODE=mock for instant fake proofs)
npx hardhat node                                   # terminal 1
VERIFIER_MODE=real npx hardhat run scripts/deploy.js --network localhost

#    deploy.js also deploys MockLendingPool with three markets (ETH, WBTC, LINK),
#    each with Chainlink-compatible price + volatility feeds and a 24 h history.
# 4. Router demo: opens positions in the pool, then routes them (real proofs, ~16 s per Tier-2 position)
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

1. Open ETH collateral at LTV 0.72, account age 30 days, last top-up 60 days
   ago: δ = 8%, the chain accepts Tier 1 or 2, the model says high risk.
2. A dishonest router claims Tier 1 anyway and keeps its commitment closed.
   (Claiming Tier 0 would revert: `TierNotAllowed`.)
3. A watcher proves the snapshotted features (~16 s with the real prover):
   HIGH RISK. It commits, then reveals the challenge; the bond is slashed.
4. Routed honestly, the position needs Tier 2: the verified proof approves a
   liquidation.
5. `TrustTierLiquidator` executes the soft liquidation: half the debt is
   repaid and δ goes from 8% to ~22%.

The same steps are available per position on the Positions page, signed by
your wallet when one is connected; "−15%" on a market stages a crash.

## How proofs are tied to positions

- The circuit's input is the five quantized features q / 1024 with EZKL
  `input_visibility = "public"`, so each proof's instances are
  `[q_ltv, q_vol, q_mom, q_topup, q_age, label, P(low)*2^10, P(high)*2^10]`.
  Model weights are private (`param_visibility = "private"`).
- `decideZkProof(positionId, pastRoundId, modelHash, proof, inputs)`
  recomputes q from on-chain state and requires `inputs[0..4] == q` and
  `inputs[5] == 1`. `pastRoundId` is the price round in effect 24 hours ago;
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
  ARGS='["0xNewVerifier","0xModelHash"]' npx hardhat run scripts/governance.js --network <net>
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
   Sepolia faucet: the full deployment (verifier 3.4 M, engine 2.2 M, pool,
   six mock feeds, registry, log) uses about 10.7 M gas, so ~0.1-0.2
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
   cd off-chain && python -m scripts.run_synthetic_stream 6   # ~16 s per Tier-2 proof
   uvicorn main:app --port 8000
   ```
   The router refreshes mock feeds it finds stale; real feeds are never touched.
5. Point MetaMask at Sepolia and use the DApp as above. `chain_client.py`
   refuses the public Hardhat test key on any non-local chain.

## Evaluation scripts

```bash
cd off-chain
python -m evaluation.evaluate               # cost replay -> results/evaluation_report.{md,json}
python -m evaluation.hf_baseline            # vs the health-factor rule -> results/hf_baseline.{md,json}
python -m evaluation.bond_economics         # challenge incentives, L1 vs rollup -> results/bond_economics.{md,json}
python -m evaluation.outcome_labels         # real outcomes; --data <Cred Protocol dataset> for all wallets
python -m evaluation.concurrency_sim        # 374 -> 1 rounds -> results/concurrency_report.md
python -m evaluation.concurrency_ablation   # size / contention / tier mix
python -m evaluation.band_sensitivity       # tier bands + threshold sweep -> results/band_sensitivity.{md,tex}
cd .. && npx hardhat run scripts/concurrency_trace.js && cd off-chain
                                            # whole blocks of decisions, opcode-traced read/write sets
python -m evaluation.parallel_exec          # 1-64 thread schedules + Block-STM-style simulation on those sets
python -m evaluation.liquidator_race        # K competing bot threads on a live node (needs a node + mock deploy)
cd .. && npx hardhat run scripts/measure_gas.js > off-chain/evaluation/results/gas_measurements.json
```

`evaluation/cost_model.py` reads `gas_measurements.json` directly (a test
checks this), so re-measuring gas updates every report and the DApp's cost
panel.

## Known limitations

- **Self-generated SRS** for KZG: fine for a testnet demo; production needs a
  ceremony SRS (`ezkl.get_srs`) - see `docs/SECURITY.md` finding 5.
- **Trusted sources**: the engine trusts the lending protocol's accounting,
  the Chainlink feeds and the (timelocked) position-source pointer. Aave does
  not store account age or top-up times, so the Aave adapter observes them
  from registration and permissionless `poke`s (finding 21).
- **Real data is one Aave V2 wallet** (74 snapshots); the rest is synthetic.
  `evaluation/outcome_labels.py` labels snapshots by real outcomes (health
  factor below 1 within 7 days) and retrains a candidate model; it is ready
  for Cred Protocol's full 35,524-wallet dataset (a Dropbox download, see the
  script) but has only been run on the one wallet.
- **L1 economics**: daily decisions are affordable only for large positions
  on L1; the intended deployment is a rollup.
- **Unnecessary liquidations**: in the stress test 26% of soft-liquidated
  positions would have recovered.
- **Concurrency is measured by scheduling simulation**: Ethereum clients
  execute blocks sequentially today; the result bounds what a parallel EVM
  could achieve.
- **Base-fee spikes**: a bond covers a challenge while the base fee stays
  under ~1.9x its value at the claim.
