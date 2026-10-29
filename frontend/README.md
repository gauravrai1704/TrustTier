# TrustTier Dashboard (Weeks 7-8)

A live console for the tiered verification pipeline: route positions
through Tier 0/1/2, watch the on-chain audit trail fill in with real
transaction hashes and gas costs, and see the cost-comparison story
(TrustTier vs. always-Tier-0 vs. always-Tier-2) update live.

## Prerequisites

The off-chain router must be running first (see `../off-chain/README.md`
or the main repo README's "Running the off-chain router" section):
1. `npx hardhat node` (in one terminal)
2. `npx hardhat run scripts/deploy.js --network localhost`
3. From `off-chain/`: `python -m scripts.setup_chain`
4. From `off-chain/`: `uvicorn main:app --reload --port 8000`

## Running the dashboard

```bash
cd frontend
npm install
npm run dev
```

Open the URL Vite prints (`http://127.0.0.1:5173` by default). The dev
server proxies `/api/*` straight to the FastAPI backend on port 8000 (see
`vite.config.js`) - no CORS configuration needed for local development.

## What's on the page

- **Verification pipeline** — a live tier-distribution view, updating as
  positions get routed.
- **Run a position stream** — triggers `/simulate`: opens a synthetic batch
  of positions in the demo lending pool and routes every one through the
  real on-chain pipeline.
- **Markets** — each market's live feed price, volatility and liquidation
  threshold, with "Push price" to stage a move on a mock feed.
- **Open one position** — opens a position and shows the contract's own
  features, δ and allowed tier before you route it.
- **On-chain audit trail** — every routed position with its tier, on-chain δ and features, risk
  score, gas used, and transaction hash (all real values from the local
  chain, not mocked in the frontend).
- **Cost comparison** — TrustTier's actual gas spend vs. what
  always-Tier-0 or always-Tier-2 would have cost, computed from the same
  measured constants `evaluation/cost_model.py` uses (via the backend's
  `/cost-model` endpoint - the frontend never hardcodes these numbers).

## Design notes

Deliberately built as an instrument console rather than a marketing
dashboard: deep indigo base, three semantic tier colors (teal/amber/coral)
reused consistently across every badge, table row, and chart bar, hairline
borders instead of card shadows, and Space Grotesk + IBM Plex Mono as the
only two typefaces (the latter for all numeric/data content, since this is
a data-dense monitoring tool where monospace numerals aid scanning).

## Challenging a decision from your wallet

Clicking a decided Tier 0/1 position opens its workflow. "Check this claim
with a Tier-2 proof" asks the backend's watcher endpoint
(`POST /positions/{id}/challenge-proof`) for a proof on the features the
contract snapshotted when the claim was made - a real EZKL proof against the
real verifier, ~16 s. If the proof shows high risk, "Challenge and slash the
bond" sends `challengeDecision` from the connected wallet, which signs and
pays for it.

"Open one position" opens a position in the demo lending pool (market, LTV,
account age, days since top-up) and shows the engine's own view of it: the
five quantized features, δ, the weakest tier the chain accepts, and the
model's verdict. The "dishonest liquidator" checkbox then claims the cheapest
allowed tier whatever the model says, so the challenge flow can be
demonstrated. The DApp never supplies features: the contract reads them.

## Verification

The rendered UI and the full wallet flow (SIWE sign-in, staged dishonest
claim on a chain-computed position, Tier-2 proof, wallet-signed challenge, slashed bond in the activity
feed) were checked end to end in headless Chromium against a local Hardhat
node with the real verifier, using an injected EIP-1193 provider in place
of MetaMask.
