const LABELS = {
  HEURISTIC: "Tier 0 · Heuristic",
  COMMITMENT: "Tier 1 · Commitment",
  ZK_PROOF: "Tier 2 · zk-SNARK",
};

const CLASS = {
  HEURISTIC: "tier-0",
  COMMITMENT: "tier-1",
  ZK_PROOF: "tier-2",
};

export default function TierBadge({ tier }) {
  return (
    <span className={`tier-badge ${CLASS[tier] || ""}`}>
      <span className="swatch" />
      {LABELS[tier] || tier}
    </span>
  );
}
