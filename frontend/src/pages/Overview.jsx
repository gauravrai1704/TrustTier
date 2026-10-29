import { useState } from "react";
import Icon from "../ui/Icon";
import { Callout, Card, Proving, Stat, TierBadge, useAction } from "../ui/kit";
import { ShareBar, Sparkline } from "../ui/charts";
import { useBackend, useData } from "../api/backend";
import { go } from "../lib/router";
import { gas, num, usd } from "../lib/format";
import EVAL from "../../../off-chain/evaluation/results/evaluation_report.json";
import HF from "../../../off-chain/evaluation/results/hf_baseline.json";
import GAS from "../../../off-chain/evaluation/results/gas_measurements.json";

function Ladder() {
  // A position drifting toward its liquidation boundary: the evidence the
  // chain demands grows as delta shrinks.
  const zones = [
    { x: 20, w: 150, c: "var(--t2)", soft: "var(--t2-soft)", t: "Tier 2", s: "zk-SNARK proof", g: GAS.decideZkProof, band: "δ ≤ 5%" },
    { x: 174, w: 150, c: "var(--t1)", soft: "var(--t1-soft)", t: "Tier 1", s: "bonded commitment", g: GAS.decideCommitment + GAS.revealCommitment, band: "5% < δ ≤ 15%" },
    { x: 328, w: 152, c: "var(--t0)", soft: "var(--t0-soft)", t: "Tier 0", s: "bonded claim", g: GAS.decideHeuristic, band: "δ > 15%" },
  ];
  return (
    <svg viewBox="0 0 500 250" className="ladder" role="img" aria-label="Tier bands by distance to liquidation">
      {zones.map((z, i) => {
        const h = 84 + (2 - i) * 40;
        return (
          <g key={z.t}>
            <rect x={z.x} y={190 - h} width={z.w} height={h} rx="12" fill={z.soft} />
            <rect x={z.x} y={190 - h} width={z.w} height="4" rx="2" fill={z.c} />
            <text x={z.x + 14} y={190 - h + 26} fontSize="15" fontWeight="700" fill="var(--ink)">{z.t}</text>
            <text x={z.x + 14} y={190 - h + 44} fontSize="11.5" fill="var(--ink-2)">{z.s}</text>
            <text x={z.x + 14} y={180} fontSize="12" fontWeight="650" fill="var(--ink)">{gas(z.g)} gas</text>
            <text x={z.x + z.w / 2} y={214} fontSize="11" textAnchor="middle" fill="var(--muted)">{z.band}</text>
          </g>
        );
      })}
      <line x1="20" x2="480" y1="228" y2="228" stroke="var(--axis)" />
      <text x="20" y="245" fontSize="11" fill="var(--muted)">liquidation boundary</text>
      <text x="480" y="245" fontSize="11" fill="var(--muted)" textAnchor="end">far from it</text>
      <circle cy="228" r="7" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2.5">
        <animate attributeName="cx" values="450;60;450" dur="9s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

const STEPS = [
  { title: "Open a position near the boundary", text: "ETH collateral at LTV 0.72: δ = 8%, so the chain accepts Tier 1 or 2. The model sees high volatility and a falling price." },
  { title: "A dishonest router claims it is safe", text: "It posts a cheap Tier-1 claim with a bond and keeps its commitment closed, hoping nobody checks." },
  { title: "A watcher proves the claim false", text: "A Tier-2 proof on the features the claim snapshotted says HIGH RISK. Commit, then reveal: the bond is slashed." },
  { title: "The honest route: a zk proof", text: "Re-routed, the position needs Tier 2. The verified proof approves a liquidation — nothing else can." },
  { title: "Execute a soft liquidation", text: "TrustTierLiquidator consumes the approval and closes half the debt, pulling the position back from the edge." },
];

function GuidedDemo() {
  const { backend, refresh } = useBackend();
  const [busy, run] = useAction();
  const [step, setStep] = useState(0);
  const [pid, setPid] = useState(null);
  const [log, setLog] = useState([]);
  const note = (t) => setLog((l) => [t, ...l].slice(0, 6));

  async function next() {
    if (step === 0) {
      const p = await run("s", () => backend.openPosition({ market: 0, ltv: 0.72, account_age_days: 30, time_since_last_topup_days: 60 }));
      if (!p) return;
      setPid(p.position_id);
      note(`#${p.position_id}: δ ${(p.delta_bps / 100).toFixed(1)}%, model P(high) ${(p.model_p_high * 100).toFixed(0)}%, chain allows ${p.allowed_tier.replace("_", " ")}`);
    } else if (step === 1) {
      const r = await run("s", () => backend.evaluate(pid, "COMMITMENT"));
      if (!r) return;
      note(`Tier-1 claim recorded (${num(r.gas_used)} gas), commitment left closed`);
    } else if (step === 2) {
      const r = await run("s", () => backend.challenge(pid));
      if (!r) return;
      note(r.slashed ? `Slashed with a commit-reveal challenge (${num(r.gas_used)} gas)` : r.detail);
    } else if (step === 3) {
      const r = await run("s", () => backend.evaluate(pid));
      if (!r) return;
      note(r.outcome === "APPROVED" ? `Tier-2 proof verified: liquidation approved (${num(r.gas_used)} gas)` : "The proof shows low risk: nothing approved");
    } else if (step === 4) {
      const r = await run("s", () => backend.liquidate(pid));
      if (!r) return;
      note(`Soft liquidation: δ is now ${(r.position.delta_bps / 100).toFixed(1)}% (${num(r.gas_used)} gas)`);
    }
    refresh();
    setStep((s) => s + 1);
  }

  const done = step >= STEPS.length;
  return (
    <Card title="Guided demo" sub="The full trust story in five transactions"
      right={done ? <button className="btn btn-sm" onClick={() => { setStep(0); setPid(null); setLog([]); }}><Icon name="reset" />Restart</button>
        : pid && <button className="btn btn-sm btn-ghost" onClick={() => go(`positions/${pid}`)}>Open #{pid}<Icon name="chevron" /></button>}>
      <div className="steps">
        {STEPS.map((s, i) => (
          <div key={s.title} className={`step ${i === step ? "current" : i < step ? "done" : ""}`}>
            <div className="step-num">{i < step ? <Icon name="check" /> : i + 1}</div>
            <div>
              <div className="step-title">{s.title}</div>
              <div className="step-text">{s.text}</div>
            </div>
            {i === step && (
              <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={next}>
                {busy ? <Icon name="refresh" className="spin" /> : <Icon name="play" />}Run
              </button>
            )}
          </div>
        ))}
      </div>
      {busy && (step === 2 || step === 3) && <div style={{ marginTop: 12 }}><Proving /></div>}
      {log.length > 0 && (
        <div className="stack" style={{ marginTop: 14, gap: 6 }}>
          {log.map((l, i) => <div key={i} className="small ink2" style={{ opacity: i ? 0.65 : 1 }}>→ {l}</div>)}
        </div>
      )}
      {done && <Callout icon="check">That is TrustTier: cheap where it is safe, provable where it matters, and a lie is never free.</Callout>}
    </Card>
  );
}

function Distribution() {
  const { data } = useData((b) => b.listPositions(), [], { poll: 6000 });
  const counts = [0, 0, 0];
  for (const p of data?.positions || []) counts[{ HEURISTIC: 0, COMMITMENT: 1, ZK_PROOF: 2 }[p.allowed_tier]]++;
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <Card title="Your positions by tier" sub={total ? `${total} positions, banded by on-chain δ` : "Open a few positions to see the split"}
      right={<button className="btn btn-sm" onClick={() => go("positions")}>Manage<Icon name="chevron" /></button>}>
      <ShareBar parts={[
        { label: "Tier 0", value: counts[0], color: "var(--t0)" },
        { label: "Tier 1", value: counts[1], color: "var(--t1)" },
        { label: "Tier 2", value: counts[2], color: "var(--t2)" },
      ]} />
    </Card>
  );
}

function Markets() {
  const { data } = useData((b) => b.markets(), [], { poll: 8000 });
  return (
    <Card title="Markets" sub="Chainlink-compatible price and volatility feeds">
      <div className="stack" style={{ gap: 4 }}>
        {(data?.markets || []).map((m) => {
          const chg = m.price_24h_ago ? m.price / m.price_24h_ago - 1 : null;
          return (
            <div key={m.id ?? m.name} className="row" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
              <div style={{ width: 64, fontWeight: 650 }}>{m.name}</div>
              <div className="tnum" style={{ width: 96 }}>{usd(m.price, m.price < 100 ? 2 : 0)}</div>
              <div className="small" style={{ width: 70, color: chg == null ? "var(--muted)" : chg >= 0 ? "var(--good-ink)" : "var(--critical)" }}>
                {chg == null ? "" : `${chg >= 0 ? "▲" : "▼"} ${Math.abs(chg * 100).toFixed(1)}%`}
              </div>
              <div className="small muted hide-sm" style={{ whiteSpace: "nowrap" }}>vol {m.volatility_pct}% · LT {(m.thresholdBps ?? 0) / 100}%</div>
              <div className="spacer" />
              <Sparkline points={m.history} />
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export default function Overview() {
  const { backend } = useBackend();
  const c = EVAL.combined;
  const hf = HF.policies;
  const forcedCut = 1 - hf.trusttier.forced_liquidations / hf.hf_rule.forced_liquidations;
  return (
    <>
      <section className="hero">
        <div>
          <span className="hero-eyebrow"><Icon name="shield" />CSD436 · Blockchain Technology</span>
          <h2>Verification that <em>scales with risk</em>.</h2>
          <p className="lead">
            TrustTier asks the chain for stronger evidence the closer a DeFi position gets to liquidation: a bonded claim
            when it is safe, a commitment when it is close, a zero-knowledge proof of the risk model when it matters.
            The contract reads every input itself, and a false cheap claim is always worth slashing.
          </p>
          <div className="hero-cta">
            <button className="btn btn-primary" onClick={() => document.getElementById("demo")?.scrollIntoView({ behavior: "smooth" })}>
              <Icon name="play" />Run the guided demo
            </button>
            <button className="btn" onClick={() => go("economics")}><Icon name="economics" />See the results</button>
          </div>
        </div>
        <Ladder />
      </section>

      <div className="grid g4">
        <Stat label="Gas saved vs. proving every decision" value={`${c.gas_savings_vs_always_tier2_pct.toFixed(1)}%`}
          note={`${c.n} positions · ${gas(c.total_gas_trusttier)} vs ${gas(c.total_gas_always_tier2)} gas`} accent />
        <Stat label="Fewer forced liquidations than the HF rule" value={`${(forcedCut * 100).toFixed(0)}%`}
          note={`${num(hf.hf_rule.forced_liquidations)} → ${num(hf.trusttier.forced_liquidations)} in a 30-day stress test`} />
        <Stat label="Tier-2 proof" value="~16 s" note={`EZKL Halo2 · verified on-chain in ${gas(GAS.verifyProof_standalone)} gas`} />
        <Stat label="Inputs trusted from the caller" value="0" note="δ and all five features are read on-chain" />
      </div>

      {backend?.mode === "sim" && (
        <Callout icon="info">
          <strong>Simulation mode.</strong> No router answered, so the protocol runs in your browser: the real model, the contract's
          rules and measured gas, without an EVM or real proofs. Start a local node and the router to go on-chain
          (<a href="#/protocol">how</a>).
        </Callout>
      )}

      <div className="grid g-main" id="demo">
        <GuidedDemo />
        <div className="stack" style={{ gap: 18 }}>
          <Distribution />
          <Markets />
          <Card title="How a decision is made">
            <div className="stack" style={{ gap: 10 }}>
              {[
                ["cpu", "The contract computes the features", "LTV and δ from the lending pool, volatility and 24-hour momentum from Chainlink, ages from timestamps."],
                ["layers", "δ picks the weakest tier allowed", <>Above 15%: <TierBadge tier="HEURISTIC" short />; above 5%: <TierBadge tier="COMMITMENT" short />; otherwise <TierBadge tier="ZK_PROOF" short />.</>],
                ["hammer", "Cheap claims are optimistic", "Bonded for an hour. A Tier-2 proof on the snapshot slashes a false one; the bond always covers the challenge gas."],
                ["bolt", "Only a proof can liquidate", "A verified HIGH-RISK proof approves one soft liquidation, executed within 30 minutes or it expires."],
              ].map(([ic, t, d]) => (
                <div key={t} className="trust-item" style={{ padding: 12 }}>
                  <div className="ic"><Icon name={ic} /></div>
                  <div><h4>{t}</h4><p>{d}</p></div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
