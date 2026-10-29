import { useEffect, useState } from "react";
import { getMarkets, openPosition, setMarketPrice } from "../api";
import TierBadge from "./TierBadge";

// The DApp never supplies a position's features. A position is opened in
// the lending protocol (MockLendingPool on the demo chain); LiquidationEngine
// reads its collateral and debt, the market's Chainlink price and volatility
// feeds, and its timestamps, and computes the five features and delta itself.
// What this panel shows under "on-chain view" is the contract's own answer.

const FEATURE_LABELS = ["LTV", "30-day volatility", "24-hour momentum", "days since top-up", "account age (days)"];

export default function Controls({ onSimulate, onEvaluate, busy }) {
  const [nPositions, setNPositions] = useState(12);
  const [markets, setMarkets] = useState([]);
  const [form, setForm] = useState({ market: 0, ltv: "0.72", accountAgeDays: "30", topupDays: "60" });
  const [view, setView] = useState(null);
  const [dishonest, setDishonest] = useState(false);
  const [crashPct, setCrashPct] = useState("10");
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    getMarkets().then((d) => setMarkets(d.markets)).catch(() => {});
  }, []);

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function handleOpen(e) {
    e.preventDefault();
    setWorking(true);
    setError(null);
    try {
      setView(await openPosition({
        market: Number(form.market), ltv: parseFloat(form.ltv),
        accountAgeDays: parseInt(form.accountAgeDays, 10), topupDays: parseInt(form.topupDays, 10),
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  }

  async function handleCrash() {
    const m = markets[Number(form.market)];
    if (!m) return;
    setWorking(true);
    setError(null);
    try {
      const d = await setMarketPrice(m.id, m.price * (1 - parseFloat(crashPct) / 100));
      setMarkets(d.markets);
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  }

  // Dishonest demo: claim the cheapest tier the chain would accept, even if
  // the model says high risk - a slashable claim. (Claiming a tier the chain
  // does not allow simply reverts.)
  function handleRoute() {
    const force = dishonest && view.allowed_tier !== "ZK_PROOF" ? view.allowed_tier : null;
    onEvaluate(view.position_id, force);
  }

  const market = markets[Number(form.market)];

  return (
    <div className="controls-row">
      <div className="panel">
        <div className="panel-header">
          <h2>Run a position stream</h2>
          <span className="panel-note">opened on-chain, then routed</span>
        </div>
        <div className="field-group">
          <label htmlFor="n-positions">Number of positions</label>
          <input id="n-positions" type="number" min="1" max="200" value={nPositions}
            onChange={(e) => setNPositions(e.target.value)} />
        </div>
        <button className="primary" disabled={busy} onClick={() => onSimulate(parseInt(nPositions, 10))}>
          {busy ? "Routing…" : "Open and route positions"}
        </button>

        <div className="panel-header" style={{ marginTop: "1.5rem" }}>
          <h2>Markets</h2>
          <span className="panel-note">Chainlink-style feeds</span>
        </div>
        <table>
          <thead>
            <tr><th>Market</th><th className="num">Price</th><th className="num">Volatility</th><th className="num">Liq. threshold</th></tr>
          </thead>
          <tbody>
            {markets.map((m) => (
              <tr key={m.id}>
                <td>{m.name}{m.mockPriceFeed ? "" : " (live price feed)"}</td>
                <td className="num">${m.price.toLocaleString()}</td>
                <td className="num">{m.volatility_pct}%</td>
                <td className="num">{m.thresholdBps ? `${m.thresholdBps / 100}%` : "per account"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {market?.mockPriceFeed && (
          <div className="field-group inline">
            <label htmlFor="crash">Move {market.name} down by (%)</label>
            <input id="crash" type="number" value={crashPct} onChange={(e) => setCrashPct(e.target.value)} />
            <button className="btn" disabled={working} onClick={handleCrash}>Push price</button>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>Open one position</h2>
          <span className="panel-note">the chain computes its features</span>
        </div>
        <form onSubmit={handleOpen}>
          <div className="field-group">
            <label htmlFor="market">Market</label>
            <select id="market" value={form.market} onChange={(e) => update("market", e.target.value)}>
              {markets.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div className="field-group">
            <label htmlFor="ltv">Loan-to-value (debt / collateral)</label>
            <input id="ltv" type="number" step="0.01" value={form.ltv} onChange={(e) => update("ltv", e.target.value)} />
          </div>
          <div className="field-group">
            <label htmlFor="age">Account age (days)</label>
            <input id="age" type="number" value={form.accountAgeDays} onChange={(e) => update("accountAgeDays", e.target.value)} />
          </div>
          <div className="field-group">
            <label htmlFor="topup">Days since last top-up</label>
            <input id="topup" type="number" value={form.topupDays} onChange={(e) => update("topupDays", e.target.value)} />
          </div>
          <button className="primary" type="submit" disabled={working || busy}>
            {working ? "Opening…" : "Open position"}
          </button>
        </form>

        {view && (
          <div className="onchain-view">
            <div className="panel-note">On-chain view of position <span className="mono">{view.position_id}</span> (computed by LiquidationEngine)</div>
            <table>
              <tbody>
                {FEATURE_LABELS.map((label, i) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td className="num mono">q = {view.features_q[i]}</td>
                    <td className="num">{Object.values(view.features)[i]}</td>
                  </tr>
                ))}
                <tr><td>δ (threshold − LTV)</td><td className="num mono">{view.delta_bps} bps</td><td /></tr>
                <tr><td>Weakest tier the chain accepts</td><td colSpan="2"><TierBadge tier={view.allowed_tier} /></td></tr>
                <tr><td>Model</td><td colSpan="2">{view.model_label ? "high risk" : "low risk"} (p = {view.model_p_high})</td></tr>
              </tbody>
            </table>
            <div className="field-group checkbox">
              <label htmlFor="dishonest">
                <input id="dishonest" type="checkbox" checked={dishonest} onChange={(e) => setDishonest(e.target.checked)} />{" "}
                Demo: act as a dishonest liquidator (claim the cheapest tier the chain allows, whatever the model says)
              </label>
            </div>
            <button className="primary" disabled={busy} onClick={handleRoute}>
              {busy ? "Routing…" : "Route this position"}
            </button>
          </div>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>
    </div>
  );
}
