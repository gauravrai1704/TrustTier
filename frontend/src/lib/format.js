// Formatting helpers shared by every view.
export const TIER_KEY = { HEURISTIC: 0, COMMITMENT: 1, ZK_PROOF: 2, Heuristic: 0, Commitment: 1, ZkProof: 2 };
export const TIER_LABEL = ["Tier 0 · Heuristic", "Tier 1 · Commitment", "Tier 2 · zk-SNARK"];
export const TIER_SHORT = ["Tier 0", "Tier 1", "Tier 2"];

export function tierIndex(t) {
  return t == null ? null : TIER_KEY[t] ?? null;
}

export function eth(wei, digits = 4) {
  if (wei == null) return "—";
  const v = Number(BigInt(wei)) / 1e18;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: digits })} ETH`;
}

export function gas(n) {
  if (n == null) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

export function num(n, d = 0) {
  return n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
}

export function usd(n, d = 2) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, 2) })}`;
}

export function pct(x, d = 1) {
  return x == null ? "—" : `${(x * 100).toFixed(d)}%`;
}

export function bps(b) {
  return b == null ? "—" : `${(b / 100).toFixed(2)}%`;
}

export function short(addr, n = 6) {
  if (!addr) return "—";
  const s = String(addr);
  return s.length > 2 * n + 2 ? `${s.slice(0, n + 2)}…${s.slice(-4)}` : s;
}

export function duration(s) {
  if (s == null) return "—";
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export const STATE_META = {
  UNDECIDED: { label: "Undecided", kind: "neutral", text: "No decision on record yet." },
  CLAIM_OPEN: { label: "Claim · window open", kind: "warn", text: "A bonded safe-claim is open to challenge." },
  AWAITING_SETTLEMENT: { label: "Window closed", kind: "neutral", text: "Unchallenged; the bond can be settled." },
  SETTLED: { label: "Settled", kind: "good", text: "Decision settled; the position can be re-decided." },
  SLASHED: { label: "Slashed", kind: "crit", text: "A Tier-2 proof showed the claim was false." },
  APPROVED: { label: "Liquidation approved", kind: "crit", text: "A verified proof approved a liquidation." },
  APPROVAL_EXPIRED: { label: "Approval expired", kind: "neutral", text: "The approval lapsed without execution." },
};
