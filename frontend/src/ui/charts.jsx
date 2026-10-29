// Hand-built SVG charts: thin marks, 4px rounded data-ends, hairline grids,
// hover tooltips, selective direct labels, and a table view for each.
import { useMemo, useRef, useState } from "react";

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(v / 1e3).toFixed(1)}K`;
  return `${+v.toFixed(3)}`;
}

/** ~n round tick values covering [min, max], always including 0 when in range. */
function niceTicks(min, max, n = 5) {
  const raw = (max - min) / (n - 1) || 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}

/** Rounded-end bar path: square at the baseline (x0), 4px radius at the data end. */
function hbar(x0, x1, y, h, r = 4) {
  const w = Math.max(0, x1 - x0);
  const rr = Math.min(r, w, h / 2);
  return `M${x0} ${y}H${x0 + w - rr}Q${x0 + w} ${y} ${x0 + w} ${y + rr}V${y + h - rr}Q${x0 + w} ${y + h} ${x0 + w - rr} ${y + h}H${x0}Z`;
}

/**
 * Horizontal bars. rows: [{label, value, color?, note?}]. One series:
 * every bar the same color unless a row sets `color` (identity or emphasis).
 */
export function BarChart({ rows, format = compact, unit = "", height, labelWidth = 150, max }) {
  const ref = useRef(null);
  const [tip, setTip] = useState(null);
  const W = 560;
  const bar = 18;
  const gap = 16;
  const H = height || rows.length * (bar + gap) + 24;
  const x0 = labelWidth;
  const x1 = W - 70;
  const m = niceMax(max ?? Math.max(...rows.map((r) => r.value)));
  const sx = (v) => x0 + (v / m) * (x1 - x0);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * m);
  return (
    <div className="chart-wrap" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={rows.map((r) => `${r.label}: ${format(r.value)}${unit}`).join("; ")}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={sx(t)} x2={sx(t)} y1={4} y2={H - 20} />
            <text x={sx(t)} y={H - 6} textAnchor="middle">{compact(t)}</text>
          </g>
        ))}
        <line className="baseline" x1={x0} x2={x0} y1={4} y2={H - 20} />
        {rows.map((r, i) => {
          const y = 8 + i * (bar + gap);
          return (
            <g key={r.label}
              onMouseMove={(e) => {
                const b = ref.current.getBoundingClientRect();
                setTip({ x: e.clientX - b.left, y: e.clientY - b.top, r });
              }}
              onMouseLeave={() => setTip(null)}>
              <rect x={0} y={y - gap / 2} width={W} height={bar + gap} fill="transparent" />
              <text className="lbl" x={x0 - 10} y={y + bar / 2 + 4} textAnchor="end">{r.label}</text>
              <path d={hbar(x0, sx(r.value), y, bar)} fill={r.color || "var(--accent)"} style={{ transition: "d .4s" }} />
              <text className="val" x={sx(r.value) + 8} y={y + bar / 2 + 4}>{format(r.value)}{unit}</text>
            </g>
          );
        })}
      </svg>
      {tip && (
        <div className="tooltip" style={{ left: tip.x, top: tip.y }}>
          <div className="tt-title">{tip.r.label}</div>
          <div className="tt-row"><i style={{ background: tip.r.color || "var(--accent)" }} />Value<b>{format(tip.r.value)}{unit}</b></div>
          {tip.r.note && <div className="tt-row" style={{ marginTop: 4 }}>{tip.r.note}</div>}
        </div>
      )}
      <TableView head={["", "Value"]} rows={rows.map((r) => [r.label, `${format(r.value)}${unit}`])} />
    </div>
  );
}

/**
 * Lines over a numeric x. series: [{name, color, points: [{x, y}]}]. One y-axis.
 * Crosshair + tooltip on hover; values labelled at the right end.
 */
export function LineChart({ series, xLabel, yFormat = compact, xFormat = (x) => x, zeroLine = true, height = 260 }) {
  const ref = useRef(null);
  const [hx, setHx] = useState(null);
  const W = 600;
  const H = height;
  const L = 52;
  const R = 110;
  const T = 12;
  const B = 34;
  const xs = series[0].points.map((p) => p.x);
  const all = series.flatMap((s) => s.points.map((p) => p.y));
  const yt = useMemo(() => niceTicks(Math.min(0, ...all), Math.max(...all)), [all.join()]);
  const lo = yt[0];
  const hi = yt[yt.length - 1];
  const sx = (x) => L + ((x - xs[0]) / (xs[xs.length - 1] - xs[0])) * (W - L - R);
  const sy = (y) => T + (1 - (y - lo) / (hi - lo)) * (H - T - B);
  const nearest = hx == null ? null : xs.reduce((a, b) => (Math.abs(sx(b) - hx) < Math.abs(sx(a) - hx) ? b : a));
  return (
    <div className="chart-wrap" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart"
        onMouseMove={(e) => {
          const b = ref.current.getBoundingClientRect();
          setHx(((e.clientX - b.left) / b.width) * W);
        }}
        onMouseLeave={() => setHx(null)}
        role="img" aria-label={series.map((s) => s.name).join(" vs ")}>
        {yt.map((t) => (
          <g key={t}>
            <line className="gridline" x1={L} x2={W - R} y1={sy(t)} y2={sy(t)} />
            <text x={L - 8} y={sy(t) + 4} textAnchor="end">{yFormat(t)}</text>
          </g>
        ))}
        {zeroLine && lo < 0 && <line className="baseline" x1={L} x2={W - R} y1={sy(0)} y2={sy(0)} />}
        {xs.filter((x, i) => i === xs.length - 1 || xs.slice(i + 1).every((y) => sx(y) - sx(x) >= 34)).map((x) => (
          <text key={x} x={sx(x)} y={H - 14} textAnchor="middle">{xFormat(x)}</text>
        ))}
        {xLabel && <text x={(L + W - R) / 2} y={H - 1} textAnchor="middle">{xLabel}</text>}
        {series.map((s) => (
          <path key={s.name} d={s.points.map((p, i) => `${i ? "L" : "M"}${sx(p.x)} ${sy(p.y)}`).join("")}
            fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {series.map((s) => {
          const p = s.points[s.points.length - 1];
          return (
            <g key={s.name}>
              <circle cx={sx(p.x)} cy={sy(p.y)} r="4.5" fill={s.color} stroke="var(--surface)" strokeWidth="2" />
              <text className="lbl" x={sx(p.x) + 10} y={sy(p.y) + 4}>{s.short || s.name}</text>
            </g>
          );
        })}
        {nearest != null && (
          <g>
            <line x1={sx(nearest)} x2={sx(nearest)} y1={T} y2={H - B} stroke="var(--axis)" />
            {series.map((s) => {
              const p = s.points.find((q) => q.x === nearest);
              return <circle key={s.name} cx={sx(p.x)} cy={sy(p.y)} r="4.5" fill={s.color} stroke="var(--surface)" strokeWidth="2" />;
            })}
          </g>
        )}
      </svg>
      {nearest != null && (
        <div className="tooltip" style={{ left: `${(sx(nearest) / W) * 100}%`, top: 10, transform: "translate(-50%, 0)" }}>
          <div className="tt-title">{xLabel}: {xFormat(nearest)}</div>
          {series.map((s) => (
            <div className="tt-row" key={s.name}>
              <i style={{ background: s.color }} />{s.name}<b>{yFormat(s.points.find((q) => q.x === nearest).y)}</b>
            </div>
          ))}
        </div>
      )}
      <div className="legend" style={{ marginTop: 6 }}>
        {series.map((s) => <span key={s.name}><i className="line" style={{ background: s.color }} />{s.name}</span>)}
      </div>
      <TableView head={[xLabel, ...series.map((s) => s.name)]}
        rows={xs.map((x) => [xFormat(x), ...series.map((s) => yFormat(s.points.find((p) => p.x === x).y))])} />
    </div>
  );
}

/** Stacked share bar (part-to-whole, <= 3 segments) with a 2px surface gap. */
export function ShareBar({ parts, height = 14 }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div>
      <div style={{ display: "flex", gap: 2, height, borderRadius: 6, overflow: "hidden" }}>
        {parts.filter((p) => p.value > 0).map((p) => (
          <div key={p.label} title={`${p.label}: ${p.value}`} style={{ width: `${(p.value / total) * 100}%`, background: p.color, transition: "width .5s" }} />
        ))}
      </div>
      <div className="legend" style={{ marginTop: 8 }}>
        {parts.map((p) => (
          <span key={p.label}><i style={{ background: p.color }} />{p.label} <b className="tnum" style={{ color: "var(--ink)" }}>{p.value}</b></span>
        ))}
      </div>
    </div>
  );
}

export function Sparkline({ points, width = 120, height = 32 }) {
  if (!points || points.length < 2) return null;
  const ys = points.map((p) => p.price);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const sx = (i) => (i / (points.length - 1)) * (width - 6) + 3;
  const sy = (y) => height - 4 - ((y - min) / (max - min || 1)) * (height - 8);
  const d = points.map((p, i) => `${i ? "L" : "M"}${sx(i)} ${sy(p.price)}`).join("");
  const up = ys[ys.length - 1] >= ys[0];
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={d} fill="none" stroke="var(--muted)" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx={sx(points.length - 1)} cy={sy(ys[ys.length - 1])} r="3.5" fill={up ? "var(--good)" : "var(--critical)"} stroke="var(--surface)" strokeWidth="1.5" />
    </svg>
  );
}

export function TableView({ head, rows }) {
  return (
    <details className="table-view">
      <summary>Table view</summary>
      <table className="table">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} style={{ cursor: "default" }}>{r.map((c, j) => <td key={j} className={j ? "num" : ""}>{c}</td>)}</tr>)}</tbody>
      </table>
    </details>
  );
}
