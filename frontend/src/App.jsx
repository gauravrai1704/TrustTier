import { useEffect, useState } from "react";
import TierPipeline from "./components/TierPipeline";
import Controls from "./components/Controls";
import ResultsTable from "./components/ResultsTable";
import CostComparison from "./components/CostComparison";
import { checkHealth, runSimulation, evaluatePosition } from "./api";

export default function App() {
  const [connected, setConnected] = useState(null); // null = checking, true/false after
  const [results, setResults] = useState([]);
  const [tierCounts, setTierCounts] = useState({});
  const [gasByTier, setGasByTier] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    checkHealth()
      .then(() => setConnected(true))
      .catch(() => setConnected(false));

    fetch("/api/cost-model")
      .then((r) => r.json())
      .then((d) => setGasByTier(d.gas_by_tier))
      .catch(() => {});
  }, []);

  async function handleSimulate(nPositions) {
    setBusy(true);
    setError(null);
    try {
      const data = await runSimulation(nPositions);
      setResults(data.results);
      setTierCounts(data.tier_counts);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleEvaluate(positionId, features) {
    setBusy(true);
    setError(null);
    try {
      const result = await evaluatePosition(positionId, features);
      setResults((prev) => [result, ...prev.filter((r) => r.position_id !== positionId)]);
      setTierCounts((prev) => {
        const next = { ...prev };
        next[result.tier] = (next[result.tier] || 0) + 1;
        return next;
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="masthead">
        <div>
          <h1>TrustTier</h1>
          <div className="subtitle">Cost-tiered zero-knowledge verification for DeFi liquidation risk</div>
        </div>
        <div className="connection">
          <span className={`dot ${connected ? "live" : "down"}`} />
          {connected === null ? "connecting…" : connected ? "router online" : "router unreachable"}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>Verification pipeline</h2>
          <span className="panel-note">live tier distribution</span>
        </div>
        <TierPipeline tierCounts={tierCounts} />
      </div>

      <Controls onSimulate={handleSimulate} onEvaluate={handleEvaluate} busy={busy} />

      {error && <div className="error-text">{error}</div>}

      <div className="panel">
        <div className="panel-header">
          <h2>On-chain audit trail</h2>
          <span className="panel-note">{results.length} decision{results.length === 1 ? "" : "s"} recorded</span>
        </div>
        <ResultsTable results={results} />
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>Cost comparison</h2>
          <span className="panel-note">measured gas, not estimated</span>
        </div>
        <CostComparison results={results} gasByTier={gasByTier} />
      </div>
    </>
  );
}
