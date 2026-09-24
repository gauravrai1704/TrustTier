import { useState } from "react";

const DEFAULT_FEATURES = {
  ltv: "0.78",
  collateral_volatility_30d: "0.25",
  price_momentum_24h: "-0.05",
  time_since_last_topup_days: "10",
  account_age_days: "300",
};

export default function Controls({ onSimulate, onEvaluate, busy }) {
  const [nPositions, setNPositions] = useState(12);
  const [features, setFeatures] = useState(DEFAULT_FEATURES);
  const [positionId, setPositionId] = useState(5001);

  function updateFeature(key, value) {
    setFeatures((f) => ({ ...f, [key]: value }));
  }

  function handleEvaluate(e) {
    e.preventDefault();
    const parsed = Object.fromEntries(
      Object.entries(features).map(([k, v]) => [k, parseFloat(v)])
    );
    onEvaluate(parseInt(positionId, 10), parsed);
  }

  return (
    <div className="controls-row">
      <div className="panel">
        <div className="panel-header">
          <h2>Run a position stream</h2>
          <span className="panel-note">synthetic</span>
        </div>
        <div className="field-group">
          <label htmlFor="n-positions">Number of positions</label>
          <input
            id="n-positions"
            type="number"
            min="1"
            max="500"
            value={nPositions}
            onChange={(e) => setNPositions(e.target.value)}
          />
        </div>
        <button
          className="primary"
          disabled={busy}
          onClick={() => onSimulate(parseInt(nPositions, 10))}
        >
          {busy ? "Routing…" : "Route positions"}
        </button>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>Evaluate one position</h2>
          <span className="panel-note">manual</span>
        </div>
        <form onSubmit={handleEvaluate}>
          <div className="field-group">
            <label htmlFor="position-id">Position ID</label>
            <input
              id="position-id"
              type="number"
              value={positionId}
              onChange={(e) => setPositionId(e.target.value)}
            />
          </div>
          <div className="field-group">
            <label htmlFor="ltv">Loan-to-value</label>
            <input
              id="ltv"
              type="number"
              step="0.01"
              value={features.ltv}
              onChange={(e) => updateFeature("ltv", e.target.value)}
            />
          </div>
          <div className="field-group">
            <label htmlFor="vol">30-day collateral volatility</label>
            <input
              id="vol"
              type="number"
              step="0.01"
              value={features.collateral_volatility_30d}
              onChange={(e) => updateFeature("collateral_volatility_30d", e.target.value)}
            />
          </div>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Routing…" : "Evaluate"}
          </button>
        </form>
      </div>
    </div>
  );
}
