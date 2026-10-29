import { useEffect, useState } from "react";
import TierPipeline from "./components/TierPipeline";
import Controls from "./components/Controls";
import ResultsTable from "./components/ResultsTable";
import CostComparison from "./components/CostComparison";
import WalletConnect from "./components/WalletConnect";
import EventFeed from "./components/EventFeed";
import PositionWorkflow from "./components/PositionWorkflow";
import WalletActions from "./components/WalletActions";
import { checkHealth, runSimulation, evaluatePosition, getDeployment, getPositionStatus } from "./api";

export default function App() {
  const [connected, setConnected] = useState(null); // null = checking, true/false after
  const [results, setResults] = useState([]);
  const [tierCounts, setTierCounts] = useState({});
  const [gasByTier, setGasByTier] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [wallet, setWallet] = useState(null);
  const [auth, setAuth] = useState(null);
  const [deployment, setDeployment] = useState(null);

  const [selectedPositionId, setSelectedPositionId] = useState(null);
  const [selectedStatus, setSelectedStatus] = useState(null);

  useEffect(() => {
    checkHealth()
      .then(() => setConnected(true))
      .catch(() => setConnected(false));

    fetch("/api/cost-model")
      .then((r) => r.json())
      .then((d) => setGasByTier(d.gas_by_tier))
      .catch(() => {});

    getDeployment()
      .then(setDeployment)
      .catch(() => {});
  }, []);

  async function refreshSelectedStatus(id) {
    if (id == null) return;
    try {
      const status = await getPositionStatus(id);
      setSelectedStatus(status);
    } catch {
      setSelectedStatus(null);
    }
  }

  useEffect(() => {
    refreshSelectedStatus(selectedPositionId);
  }, [selectedPositionId]);

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

  async function handleEvaluate(positionId, forceTier = null) {
    setBusy(true);
    setError(null);
    try {
      const result = await evaluatePosition(positionId, forceTier);
      setResults((prev) => [result, ...prev.filter((r) => r.position_id !== positionId)]);
      setSelectedPositionId(positionId);
      refreshSelectedStatus(positionId);
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
        <div className="masthead-right">
          <WalletConnect onWallet={setWallet} onAuthenticated={setAuth} />
          <div className="connection">
            <span className={`dot ${connected ? "live" : "down"}`} />
            {connected === null ? "connecting…" : connected ? "router online" : "router unreachable"}
          </div>
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
          <span className="panel-note">{results.length} decision{results.length === 1 ? "" : "s"} recorded — click a row to inspect its workflow</span>
        </div>
        <ResultsTable results={results} onSelect={setSelectedPositionId} selectedId={selectedPositionId} />
      </div>

      <div className="grid-2col">
        <div className="panel">
          <div className="panel-header">
            <h2>Position workflow</h2>
            <span className="panel-note">bonded challenge window, live</span>
          </div>
          <PositionWorkflow positionId={selectedPositionId} />
          <WalletActions
            wallet={wallet}
            deployment={deployment}
            positionId={selectedPositionId}
            status={selectedStatus}
            onActionComplete={() => refreshSelectedStatus(selectedPositionId)}
          />
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Live activity</h2>
            <span className="panel-note">polling on-chain events</span>
          </div>
          <EventFeed />
        </div>
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
