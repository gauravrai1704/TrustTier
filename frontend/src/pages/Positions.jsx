import { useState } from "react";
import Icon from "../ui/Icon";
import { Card, Empty, StateBadge, TierBadge, useAction } from "../ui/kit";
import PositionDrawer from "../ui/PositionDrawer";
import { useBackend, useData } from "../api/backend";
import { go } from "../lib/router";
import { usd } from "../lib/format";

function OpenForm({ markets, onOpened }) {
  const { backend, refresh } = useBackend();
  const [busy, run] = useAction();
  const [f, setF] = useState({ market: 0, ltv: 0.72, age: 30, topup: 60 });
  const m = markets?.[f.market];
  const lt = (m?.thresholdBps ?? 8000) / 10_000;
  const delta = lt - f.ltv;
  const tier = delta > 0.15 ? "HEURISTIC" : delta > 0.05 ? "COMMITMENT" : "ZK_PROOF";
  async function open() {
    const p = await run("open", () => backend.openPosition({
      market: Number(f.market), ltv: Number(f.ltv), account_age_days: Number(f.age), time_since_last_topup_days: Number(f.topup),
    }), { ok: "Position opened", okText: (p) => `#${p.position_id} · δ ${(p.delta_bps / 100).toFixed(2)}% · model P(high) ${(p.model_p_high * 100).toFixed(0)}%` });
    if (p) {
      refresh();
      onOpened(p.position_id);
    }
  }
  return (
    <Card title="Open a position" sub="One unit of collateral in the demo lending pool">
      <div className="stack">
        <label className="field">Market
          <select className="select" value={f.market} onChange={(e) => setF({ ...f, market: Number(e.target.value) })}>
            {(markets || []).map((mk, i) => <option key={mk.name} value={i}>{mk.name} · {usd(mk.price, mk.price < 100 ? 2 : 0)} · LT {(mk.thresholdBps ?? 0) / 100}%</option>)}
          </select>
        </label>
        <label className="field">Loan-to-value
          <div className="range-row">
            <input type="range" min="0.2" max="1.0" step="0.01" value={f.ltv} onChange={(e) => setF({ ...f, ltv: Number(e.target.value) })} />
            <span className="range-val">{f.ltv.toFixed(2)}</span>
          </div>
        </label>
        <div className="grid g2" style={{ gap: 12 }}>
          <label className="field">Account age (days)
            <input className="input" type="number" min="0" max="5000" value={f.age} onChange={(e) => setF({ ...f, age: e.target.value })} />
          </label>
          <label className="field">Days since top-up
            <input className="input" type="number" min="0" max="5000" value={f.topup} onChange={(e) => setF({ ...f, topup: e.target.value })} />
          </label>
        </div>
        <div className="row small ink2">
          δ ≈ <b className="tnum" style={{ color: "var(--ink)" }}>{(delta * 100).toFixed(1)}%</b> → the chain will accept <TierBadge tier={tier} short /> or stronger
        </div>
        <button className="btn btn-primary" disabled={!!busy} onClick={open}><Icon name="plus" />{busy ? "Opening…" : "Open position"}</button>
      </div>
    </Card>
  );
}

function MarketShock({ markets }) {
  const { backend, refresh } = useBackend();
  const [busy, run] = useAction();
  async function shock(i, factor) {
    const m = markets[i];
    await run(`${i}${factor}`, () => backend.setPrice(i, +(m.price * factor).toFixed(m.price < 100 ? 4 : 2)), {
      ok: `${m.name} ${factor < 1 ? "crashed" : "recovered"} ${Math.abs((factor - 1) * 100).toFixed(0)}%`,
      okText: "Every position on this market now has a new δ and features.",
    });
    refresh();
  }
  async function stream() {
    await run("stream", () => backend.simulate(9), {
      ok: "Stream routed", okText: (r) => Object.entries(r.tier_counts).map(([k, v]) => `${k.replace("_", " ")}: ${v}`).join(" · "),
    });
    refresh();
  }
  return (
    <Card title="Market controls" sub="Mock feeds only — real Chainlink feeds cannot be moved">
      <div className="stack" style={{ gap: 10 }}>
        {(markets || []).map((m, i) => (
          <div className="row" key={m.name}>
            <div style={{ width: 56, fontWeight: 650 }}>{m.name}</div>
            <div className="tnum small ink2" style={{ width: 90 }}>{usd(m.price, m.price < 100 ? 2 : 0)}</div>
            <div className="spacer" />
            <button className="btn btn-sm" disabled={!!busy} onClick={() => shock(i, 0.85)}><Icon name="down" />−15%</button>
            <button className="btn btn-sm" disabled={!!busy} onClick={() => shock(i, 1.1)}><Icon name="trend" />+10%</button>
          </div>
        ))}
        <div className="divider" />
        <button className="btn" disabled={!!busy} onClick={stream}><Icon name="layers" />{busy === "stream" ? "Routing a stream…" : "Open & route a stream of 9"}</button>
      </div>
    </Card>
  );
}

export default function Positions({ params }) {
  const selected = params?.[0] ? Number(params[0]) : null;
  const { data: mk } = useData((b) => b.markets(), [], { poll: 8000 });
  const { data, loading } = useData((b) => b.listPositions(), [], { poll: 5000 });
  const [filter, setFilter] = useState("all");
  const markets = mk?.markets;
  const rows = (data?.positions || []).filter((p) => filter === "all" || (filter === "open" ? ["CLAIM_OPEN", "APPROVED"].includes(p.state) : p.allowed_tier === filter));
  return (
    <>
      <div className="grid g-main">
        <Card title="Positions" sub="The contract's own view — click a row for its proof, lifecycle and actions" pad={false}
          right={
            <div className="seg">
              {[["all", "All"], ["open", "Live"], ["HEURISTIC", "T0"], ["COMMITMENT", "T1"], ["ZK_PROOF", "T2"]].map(([k, l]) => (
                <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{l}</button>
              ))}
            </div>
          }>
          {!rows.length ? (
            <Empty icon="positions" title={loading ? "Loading…" : "No positions yet"}>
              {!loading && <span className="small">Open one on the right, or route a stream.</span>}
            </Empty>
          ) : (
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table className="table">
                <thead>
                  <tr><th>ID</th><th>Mkt</th><th className="num">LTV</th><th>δ</th><th>Chain allows</th><th>Model P(high)</th><th>State</th></tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const dpct = p.delta_bps / 100;
                    const w = Math.max(4, Math.min(110, ((dpct + 20) / 60) * 110));
                    const col = p.delta_bps > 1500 ? "var(--t0)" : p.delta_bps > 500 ? "var(--t1)" : "var(--t2)";
                    return (
                      <tr key={p.position_id} className={selected === p.position_id ? "sel" : ""} onClick={() => go(`positions/${p.position_id}`)}>
                        <td className="mono">#{p.position_id}</td>
                        <td>{markets?.[p.market]?.name ?? "—"}</td>
                        <td className="num">{(p.debt_usd / p.collateral_usd).toFixed(3)}</td>
                        <td>
                          <div className="row" style={{ gap: 8 }}>
                            <span className="delta-bar" style={{ background: "var(--surface-3)" }}><i style={{ width: w, background: col, borderRadius: 999 }} /></span>
                            <span className="tnum small" style={{ width: 48 }}>{dpct.toFixed(1)}%</span>
                          </div>
                        </td>
                        <td><TierBadge tier={p.allowed_tier} short /></td>
                        <td>
                          <div className="row" style={{ gap: 8 }}>
                            <span className="meter"><span style={{ width: `${p.model_p_high * 100}%`, background: p.model_label ? "var(--critical)" : "var(--good)" }} /></span>
                            <span className="tnum small">{(p.model_p_high * 100).toFixed(0)}%</span>
                          </div>
                        </td>
                        <td><StateBadge state={p.state} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="stack" style={{ gap: 18 }}>
          <OpenForm markets={markets} onOpened={(id) => go(`positions/${id}`)} />
          <MarketShock markets={markets} />
        </div>
      </div>
      {selected != null && <PositionDrawer id={selected} onClose={() => go("positions")} />}
    </>
  );
}
