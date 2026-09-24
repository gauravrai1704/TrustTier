const BAR_COLORS = {
  trusttier: "var(--tier0)",
  alwaysTier0: "var(--tier1)",
  alwaysTier2: "var(--tier2)",
};

export default function CostComparison({ results, gasByTier }) {
  if (!results || results.length === 0 || !gasByTier) {
    return <div className="empty-state">Route some positions to see the cost comparison.</div>;
  }

  const n = results.length;
  const trusttierGas = results.reduce((sum, r) => sum + (gasByTier[r.tier] || 0), 0);
  const alwaysTier0Gas = n * gasByTier.HEURISTIC;
  const alwaysTier2Gas = n * gasByTier.ZK_PROOF;

  const maxGas = Math.max(trusttierGas, alwaysTier0Gas, alwaysTier2Gas);
  const savingsPct = alwaysTier2Gas > 0 ? (1 - trusttierGas / alwaysTier2Gas) * 100 : 0;

  const rows = [
    { key: "alwaysTier0", label: "Always Tier 0", value: alwaysTier0Gas, note: "cheap, unverified" },
    { key: "trusttier", label: "TrustTier", value: trusttierGas, note: "adaptive" },
    { key: "alwaysTier2", label: "Always Tier 2", value: alwaysTier2Gas, note: "fully verified" },
  ];

  return (
    <div>
      <div className="stats-row" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Positions routed</div>
          <div className="stat-value">{n}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">TrustTier total gas</div>
          <div className="stat-value" style={{ color: "var(--tier0)" }}>
            {trusttierGas.toLocaleString()}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Always-Tier-2 gas</div>
          <div className="stat-value" style={{ color: "var(--tier2)" }}>
            {alwaysTier2Gas.toLocaleString()}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Savings vs always-verify</div>
          <div className="stat-value" style={{ color: "var(--tier0)" }}>
            {savingsPct.toFixed(1)}%
          </div>
        </div>
      </div>

      <div className="cost-bars">
        {rows.map((row) => (
          <div className="cost-bar-row" key={row.key}>
            <div className="cost-label">
              {row.label}
              <br />
              <span style={{ color: "var(--text-tertiary)", fontSize: 11 }}>{row.note}</span>
            </div>
            <div className="cost-bar-track">
              <div
                className="cost-bar-fill"
                style={{
                  width: `${(row.value / maxGas) * 100}%`,
                  background: BAR_COLORS[row.key],
                }}
              />
            </div>
            <div className="cost-value">{row.value.toLocaleString()} gas</div>
          </div>
        ))}
      </div>
    </div>
  );
}
