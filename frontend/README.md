# TrustTier DApp

React + Vite, no UI framework. Light and dark themes (system by default,
toggle in the top bar), responsive down to phone width.

```bash
npm install
npm run dev      # http://127.0.0.1:5173 - proxies /api to the router on :8000
npm run build    # static site in dist/ (VITE_BASE sets the public path)
```

## Modes

- **On-chain**: when the router (`off-chain/main.py`) answers. Every action is
  a transaction; a connected wallet (MetaMask) signs challenges (commit, then
  reveal), bond settlements and liquidations itself, and can sign in with
  Ethereum.
- **Simulation**: when no router answers (e.g. the GitHub Pages build).
  `src/sim/engine.js` ports the contract's rules and runs the real model
  (`src/sim/model.json`, exported by `off-chain/scripts/export_model_js.py`
  and checked against ONNX by `off-chain/tests/test_export_model.py`) with
  the measured gas. State is kept in the browser and can be reset on the
  Protocol page.

The Protocol page switches between Auto / Router only / Simulation and sets
the router URL.

## Layout

```
src/
  App.jsx               shell: sidebar, top bar (mode, chain clock, theme, wallet)
  pages/                Overview (guided demo), Positions, Watchtower,
                        Economics, Activity, Protocol
  ui/                   kit (badges, gauge, drawer, toasts), charts, wallet,
                        PositionDrawer (one position's view and actions)
  api/                  live client and backend selection
  sim/                  in-browser protocol simulation and model
  lib/                  formatting, theme, hash routing
```

The Economics and Overview pages import the evaluation results from
`../off-chain/evaluation/results/*.json` at build time: re-run an evaluation,
push, and the hosted site updates.
