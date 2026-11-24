import { useState } from "react";
import { Callout, Card, Stat } from "../ui/kit";
import { BarChart, LineChart, ShareBar } from "../ui/charts";
import { gas, num } from "../lib/format";
import GAS from "../../../off-chain/evaluation/results/gas_measurements.json";
import EVAL from "../../../off-chain/evaluation/results/evaluation_report.json";
import HF from "../../../off-chain/evaluation/results/hf_baseline.json";
import BOND from "../../../off-chain/evaluation/results/bond_economics.json";
import AAVE from "../../../off-chain/evaluation/results/aave_eval.json";
import POOL from "../../../off-chain/evaluation/results/prover_pool.json";

const POLICY = { hf_rule: "Health-factor rule", trusttier: "TrustTier", always_zk: "Always zk-proof" };
const policyColor = (k) => (k === "trusttier" ? "var(--accent)" : "var(--axis)");

function BondCalculator() {
  const [g, setG] = useState(20);
  const cost = (BOND.measured.commit_plus_reveal * g) / 1e9;
  const direct = (BOND.measured.challengeDecision * g) / 1e9;
  const scaled = Math.max(0.01, (BOND.bond_gas_cover * g) / 1e9);
  const rows = [
    ["Fixed 0.01 ETH bond", 0.01, 0.01 - direct],
    ["Gas-scaled bond (enforced)", scaled, scaled - cost],
  ];
  return (
    <Card title="Would you challenge?" sub="A watcher's profit from slashing one false claim, at a gas price you choose">
      <div className="stack">
        <label className="field">Base fee at the claim
          <div className="range-row">
            <input type="range" min="1" max="200" value={g} onChange={(e) => setG(Number(e.target.value))} />
            <span className="range-val">{g} gwei</span>
          </div>
        </label>
        {rows.map(([label, bond, profit]) => (
          <div key={label} className={`verdict ${profit >= 0 ? "low" : "high"}`} style={{ padding: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 650 }}>{label}</div>
              <div className="small ink2">bond {bond.toFixed(4)} ETH · challenge {(label.startsWith("Fixed") ? direct : cost).toFixed(4)} ETH</div>
            </div>
            <div className="tnum" style={{ fontWeight: 750, fontSize: 18 }}>{profit >= 0 ? "+" : ""}{profit.toFixed(4)} ETH</div>
          </div>
        ))}
        <div className="small muted">
          The fixed bond stops paying above {BOND.fixed_bond_breakeven_gwei} gwei — the verifier's dilemma. The gas-scaled bond stays
          profitable while the base fee at challenge time is below {BOND.gas_scaled_max_basefee_rise_committed}× the base fee at the claim.
        </div>
      </div>
    </Card>
  );
}

export default function Economics() {
  const c = EVAL.combined;
  const hf = HF.policies;
  const tiers = [
    { label: "Tier 0 · claim", value: GAS.decideHeuristic, color: "var(--t0)" },
    { label: "Tier 1 · commit + reveal", value: GAS.decideCommitment + GAS.revealCommitment, color: "var(--t1)", note: `${num(GAS.decideCommitment)} + ${num(GAS.revealCommitment)} reveal` },
    { label: "Tier 2 · zk-SNARK", value: GAS.decideZkProof, color: "var(--t2)", note: `of which ${num(GAS.verifyProof_standalone)} verifies the proof` },
  ];
  const metric = (key, fmt = (v) => num(v), unit = "") => (
    <BarChart labelWidth={130} unit={unit} format={fmt}
      rows={Object.keys(POLICY).map((k) => ({ label: POLICY[k], value: hf[k][key], color: policyColor(k) }))} />
  );
  const bondSeries = [
    { name: "Gas-scaled bond", short: "gas-scaled", color: "var(--accent)", points: BOND.table.map((r) => ({ x: r.gas_price_gwei, y: r.gas_scaled_profit_committed_eth })) },
    { name: "Fixed 0.01 ETH bond", short: "fixed", color: "var(--muted)", points: BOND.table.map((r) => ({ x: r.gas_price_gwei, y: r.fixed_bond_profit_eth })) },
  ];
  return (
    <>
      <div className="grid g4">
        <Stat label="Gas saved vs. always-Tier-2" value={`${c.gas_savings_vs_always_tier2_pct.toFixed(1)}%`} note={`${c.n} positions (74 real Aave V2 + 300 synthetic)`} accent />
        <Stat label="Insolvencies vs. HF rule" value={`${hf.hf_rule.insolvent_positions} → ${hf.trusttier.insolvent_positions}`} note={`${HF.setup.positions} positions, ${HF.setup.horizon_days}-day stress test`} />
        <Stat label="Unnecessary soft liquidations" value={`${((hf.trusttier.unnecessary_soft_liquidations / hf.trusttier.positions_soft_liquidated) * 100).toFixed(0)}%`}
          note={`${hf.trusttier.unnecessary_soft_liquidations} of ${hf.trusttier.positions_soft_liquidated} positions would have recovered`} />
        <Stat label="Fixed bond stops paying at" value={`${BOND.fixed_bond_breakeven_gwei} gwei`} note="the gas-scaled bond never does" />
      </div>

      <div className="grid g2">
        <Card title="Gas per decision" sub="Measured on the real contracts with the real EZKL verifier">
          <BarChart rows={tiers} format={(v) => num(v)} labelWidth={170} />
        </Card>
        <Card title={`Total decision gas, ${c.n} positions`} sub="TrustTier's tiers vs. a Tier-2 proof for every decision">
          <BarChart labelWidth={150} format={gas}
            rows={[
              { label: "TrustTier", value: c.total_gas_trusttier, color: "var(--accent)" },
              { label: "Always Tier 2", value: c.total_gas_always_tier2, color: "var(--axis)" },
            ]} />
          <div style={{ marginTop: 14 }}>
            <ShareBar parts={[
              { label: "Tier 0", value: c.tier_counts.HEURISTIC, color: "var(--t0)" },
              { label: "Tier 1", value: c.tier_counts.COMMITMENT, color: "var(--t1)" },
              { label: "Tier 2", value: c.tier_counts.ZK_PROOF, color: "var(--t2)" },
            ]} />
          </div>
        </Card>
      </div>

      <section className="stack">
        <div className="section-title"><h2>Against the protocol's own rule</h2><span className="muted small">why a model, and why on-chain</span></div>
        <Callout icon="info">
          Aave's health-factor rule costs no decision gas but acts only once LTV reaches the threshold. On identical price paths
          ({HF.setup.positions} positions, {HF.setup.horizon_days} days, {HF.setup.crash_prob_per_day * 100}% daily crash risk), TrustTier's proven
          model soft-liquidates earlier. <strong>Trade-off:</strong> borrowers pay slightly more liquidation bonus in total, and some soft liquidations
          were unnecessary.
        </Callout>
        <div className="grid g2">
          <Card title="Forced liquidations (LTV ≥ threshold)">{metric("forced_liquidations")}</Card>
          <Card title="Insolvent positions (bad debt)">{metric("insolvent_positions")}</Card>
          <Card title="Bad debt, % of initial debt">{metric("bad_debt_pct_of_debt", (v) => v.toFixed(3), "%")}</Card>
          <Card title="Liquidation bonus paid by borrowers, % of debt">{metric("borrower_bonus_paid_pct_of_debt", (v) => v.toFixed(2), "%")}</Card>
        </div>
        {HF.seeds && (
          <Card title="Robustness over ten more scenarios" sub="mean, with the range of bad debt">
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Policy</th><th className="num">Forced liquidations</th><th className="num">Insolvencies</th><th className="num">Bad debt % (min–max)</th></tr></thead>
                <tbody>
                  {Object.entries(HF.seeds).map(([k, d]) => (
                    <tr key={k} style={{ cursor: "default" }}>
                      <td>{POLICY[k]}</td>
                      <td className="num">{num(d.forced_liquidations.mean, 1)}</td>
                      <td className="num">{num(d.insolvent_positions.mean, 1)}</td>
                      <td className="num">{d.bad_debt_pct_of_debt.mean.toFixed(3)} ({d.bad_debt_pct_of_debt.min.toFixed(3)}–{d.bad_debt_pct_of_debt.max.toFixed(3)})</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>

      <section className="stack">
        <div className="section-title"><h2>Incentives</h2><span className="muted small">is anyone paid to watch?</span></div>
        <div className="grid g-main">
          <Card title="Watcher profit per slashed claim" sub="ETH, by gas price at the claim">
            <LineChart series={bondSeries} xLabel="gas price (gwei)" yFormat={(v) => v.toFixed(3)} />
          </Card>
          <BondCalculator />
        </div>
        <Card title="Where daily monitoring is affordable" sub={`One decision per position per day; ETH = $${num(BOND.assumptions.eth_usd)}; budget ${BOND.assumptions.target_cost_bps_per_year / 100}% of the debt per year`}>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Network</th><th className="num">TrustTier $/position/yr</th><th className="num">Min. debt</th><th className="num">Always-zk $/position/yr</th><th className="num">Min. debt</th></tr></thead>
              <tbody>
                {BOND.viability.map((r) => (
                  <tr key={r.network} style={{ cursor: "default" }}>
                    <td>{r.network}</td>
                    <td className="num">${num(r.trusttier_usd_per_position_year, 2)}</td>
                    <td className="num">${num(r.trusttier_min_debt_usd)}</td>
                    <td className="num">${num(r.always_zk_usd_per_position_year, 2)}</td>
                    <td className="num">${num(r.always_zk_min_debt_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="small muted" style={{ marginTop: 10 }}>On L1 only large positions justify daily decisions; on a rollup ordinary retail positions do — the intended deployment target.</div>
        </Card>
      </section>

      <Card title="Proving throughput" sub={`Real EZKL proofs, ${POOL.proofs_per_config} per setting, ${POOL.machine.cores}-core machine · inspired by BlockRaFT's leader/worker nodes`}>
        <div className="grid g2">
          <BarChart labelWidth={150} format={(v) => v.toFixed(1)} unit="/min"
            rows={[
              ...POOL.configs.slice(0, 3).map((c) => ({ label: `${c.workers} worker${c.workers > 1 ? "s" : ""} × ${c.threads_per_worker} thr`, value: c.proofs_per_min,
                color: "var(--axis)", note: `${c.latency_mean_s} s per proof · ${c.peak_rss_mb_per_worker} MB each` })),
              ...(POOL.scale_out || []).map((x) => ({ label: `${x.machines} machine${x.machines > 1 ? "s" : ""} × ${x.cores_per_machine} cores`, value: x.proofs_per_min,
                color: x.machines > 1 ? "var(--accent)" : "var(--axis)", note: `over HTTP · ${x.latency_mean_s} s per proof` })),
            ]} />
          <div className="stack small ink2">
            <p>One proof already uses every core (23.0 s on 1 thread, 6.4 s on 4), so splitting one machine into more workers buys little throughput and makes each proof slower.</p>
            <p><b style={{ color: "var(--ink)" }}>Scaling out works:</b> two prover workers on separate core sets prove {POOL.scale_out?.[1]?.speedup_vs_one_machine}× faster than one, at the same latency.</p>
            <p>A crash backlog of {POOL.crash_backlog.tier2_positions} Tier-2 proofs: {POOL.crash_backlog.minutes_one_worker} min on one machine, about {POOL.crash_backlog.minutes_projected_by_machines["4"]} min on four (projected).</p>
          </div>
        </div>
      </Card>

      <Card title="Real Aave V2 positions" sub={`${num(AAVE.positions)} position-days from ${num(AAVE.accounts)} borrowers, read from an archive node; outcome = health factor below 1 within 7 days`}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Sample · bands</th><th className="num">Tier 0 / 1 / 2</th><th className="num">Gas saved vs always-zk</th><th className="num">Cheap claims that went bad (7 d)</th></tr></thead>
            <tbody>
              {["adaptive", "fixed_15_5"].flatMap((b) => ["random", "liquidated"].map((smp) => {
                const r = AAVE.policies[b][smp];
                return (
                  <tr key={b + smp} style={{ cursor: "default" }}>
                    <td>{smp} · {b === "adaptive" ? "adaptive" : "fixed 15% / 5%"}</td><td className="num">{r.tiers.map(num).join(" / ")}</td>
                    <td className="num">{r.saving_pct}%</td><td className="num">{num(r.cheap_claims_liquidatable_7d)}</td>
                  </tr>
                );
              }))}
            </tbody>
          </table>
        </div>
        <div className="stack small ink2" style={{ marginTop: 10 }}>
          <p>Approved soft liquidations on the random sample: <b style={{ color: "var(--ink)" }}>{num(AAVE.false_alarms_random_sample.trusttier_model.approved_soft_liquidations)}</b> with the proven model, against {num(AAVE.false_alarms_random_sample.delta_only_baseline.approved_soft_liquidations)} for a δ-only rule; {AAVE.false_alarms_random_sample.trusttier_model.of_which_liquidatable_within_7d} of the model's approvals became liquidatable within a week.</p>
          <p>Early warning: of {AAVE.early_warning.trusttier_model.liquidated_accounts_observed} accounts that became liquidatable, TrustTier approved a soft liquidation at least a day earlier for {AAVE.early_warning.trusttier_model.flagged_at_least_1_day_before} (median lead {AAVE.early_warning.trusttier_model.median_lead_days_when_flagged} days). The health-factor rule acts only once HF &lt; 1.</p>
        </div>
      </Card>
    </>
  );
}
