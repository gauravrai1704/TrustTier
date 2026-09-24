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
- **Run a position stream** — triggers `/simulate`, generating a synthetic
  batch and routing every position through the real on-chain pipeline.
- **Evaluate one position** — a manual form for testing a specific LTV /
  volatility combination and watching which tier it lands in.
- **On-chain audit trail** — every routed position with its tier, δ, risk
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

## Known limitation

This was built and its API integration verified end-to-end (Vite's proxy
correctly forwarding real on-chain transaction data from the FastAPI
backend) from a sandboxed environment with no browser available - so the
data layer is confirmed working, but the actual rendered UI (colors,
spacing, responsive behavior) has not been visually verified. Worth a
quick look once you run it locally before treating the visual design as final.
