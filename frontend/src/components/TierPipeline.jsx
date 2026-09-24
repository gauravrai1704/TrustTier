const STAGES = [
  {
    key: "HEURISTIC",
    tier: "TIER 0",
    name: "Heuristic",
    desc: "Static LTV check. No model, no proof.",
    color: "var(--tier0)",
  },
  {
    key: "COMMITMENT",
    tier: "TIER 1",
    name: "Commitment",
    desc: "Off-chain inference, hash-committed on-chain.",
    color: "var(--tier1)",
  },
  {
    key: "ZK_PROOF",
    tier: "TIER 2",
    name: "zk-SNARK proof",
    desc: "Full EZKL verification, on-chain.",
    color: "var(--tier2)",
  },
];

// The hero: the system's own tiered escalation pipeline, rendered live
// against whatever the most recent simulation produced. This is the most
// characteristic thing in TrustTier's world - not a stock hero treatment.
export default function TierPipeline({ tierCounts }) {
  const total = STAGES.reduce((sum, s) => sum + (tierCounts?.[s.key] || 0), 0);

  return (
    <div className="pipeline">
      {STAGES.map((stage) => {
        const count = tierCounts?.[stage.key] || 0;
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        return (
          <div className="pipeline-stage" key={stage.key}>
            <div className="stage-tier" style={{ color: stage.color }}>
              {stage.tier}
            </div>
            <div className="stage-name">{stage.name}</div>
            <div className="stage-count">{count}</div>
            <div className="stage-desc">
              {total > 0 ? `${pct}% of routed positions` : stage.desc}
            </div>
            <div
              className="stage-bar"
              style={{ background: stage.color, opacity: total > 0 ? 0.3 + pct / 150 : 0.25 }}
            />
          </div>
        );
      })}
    </div>
  );
}
