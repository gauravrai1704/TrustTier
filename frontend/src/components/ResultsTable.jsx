import TierBadge from "./TierBadge";

function shortHash(hash) {
  if (!hash) return "—";
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export default function ResultsTable({ results, onSelect, selectedId }) {
  if (!results || results.length === 0) {
    return <div className="empty-state">No positions routed yet. Run a stream above to populate the audit trail.</div>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Position</th>
          <th>Tier</th>
          <th className="num">LTV</th>
          <th className="num">δ (bps)</th>
          <th>Features q (on-chain)</th>
          <th className="num">Risk score</th>
          <th className="num">Gas used</th>
          <th>Outcome</th>
          <th>Tx hash</th>
        </tr>
      </thead>
      <tbody>
        {results.map((r, i) => (
          <tr
            key={r.position_id}
            className={`row-enter ${onSelect ? "row-clickable" : ""} ${selectedId === r.position_id ? "row-selected" : ""}`}
            style={{ animationDelay: `${i * 18}ms` }}
            onClick={() => onSelect?.(r.position_id)}
          >
            <td className="mono">{r.position_id}</td>
            <td>
              <TierBadge tier={r.tier} />
            </td>
            <td className="num">{r.ltv?.toFixed(3)}</td>
            <td className="num">{r.delta_bps >= 0 ? "+" : ""}{r.delta_bps}</td>
            <td className="mono">{r.features_q ? `[${r.features_q.join(", ")}]` : "—"}</td>
            <td className="num">{r.risk_score != null ? r.risk_score.toFixed(3) : "—"}</td>
            <td className="num">{r.gas_used != null ? r.gas_used.toLocaleString() : "—"}</td>
            <td title={r.tier_reason}>
              {r.outcome === "NOT_LIQUIDATED" ? "Not liquidated (proof: low risk)" : "Approved"}
            </td>
            <td className="tx-hash">{shortHash(r.tx_hash)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
