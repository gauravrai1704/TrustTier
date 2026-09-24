import TierBadge from "./TierBadge";

function shortHash(hash) {
  if (!hash) return "—";
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export default function ResultsTable({ results }) {
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
          <th className="num">δ</th>
          <th className="num">Risk score</th>
          <th className="num">Gas used</th>
          <th>Tx hash</th>
        </tr>
      </thead>
      <tbody>
        {results.map((r, i) => (
          <tr key={r.position_id} className="row-enter" style={{ animationDelay: `${i * 18}ms` }}>
            <td className="mono">{r.position_id}</td>
            <td>
              <TierBadge tier={r.tier} />
            </td>
            <td className="num">{r.ltv?.toFixed(3)}</td>
            <td className="num">{r.delta >= 0 ? "+" : ""}{r.delta?.toFixed(4)}</td>
            <td className="num">{r.risk_score != null ? r.risk_score.toFixed(3) : "—"}</td>
            <td className="num">{r.gas_used != null ? r.gas_used.toLocaleString() : "—"}</td>
            <td className="tx-hash">{shortHash(r.tx_hash)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
