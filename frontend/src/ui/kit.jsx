// Shared UI pieces: badges, stat tiles, toasts, drawer, gauge, feature bars.
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import Icon from "./Icon";
import { STATE_META, TIER_LABEL, TIER_SHORT, tierIndex } from "../lib/format";

export function TierBadge({ tier, short = false }) {
  const i = tierIndex(tier);
  if (i == null) return <span className="pill">—</span>;
  return (
    <span className={`pill pill-t${i}`}>
      <span className="dot" />
      {short ? TIER_SHORT[i] : TIER_LABEL[i]}
    </span>
  );
}

const KIND_ICON = { good: "check", warn: "clock", crit: "alert", neutral: "info" };
const KIND_CLASS = { good: "pill-good", warn: "pill-warn", crit: "pill-crit", neutral: "" };

export function StateBadge({ state }) {
  const m = STATE_META[state] || STATE_META.UNDECIDED;
  return (
    <span className={`pill ${KIND_CLASS[m.kind]}`} title={m.text}>
      <Icon name={KIND_ICON[m.kind]} />
      {m.label}
    </span>
  );
}

export function Stat({ label, value, note, accent }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={accent ? { color: "var(--accent)" } : undefined}>{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

export function Card({ title, sub, right, children, pad = true, className = "" }) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <div className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          {right}
        </div>
      )}
      <div className={pad ? "card-body" : ""}>{children}</div>
    </section>
  );
}

export function Callout({ icon = "info", kind = "", children }) {
  return (
    <div className={`callout ${kind}`}>
      <Icon name={icon} />
      <div>{children}</div>
    </div>
  );
}

// ---- toasts --------------------------------------------------------------

const ToastCtx = createContext(() => {});

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setItems((xs) => [...xs, { id, kind: "info", ...t }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.ms || 5200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Icon name={t.kind === "good" ? "check" : t.kind === "bad" ? "alert" : "info"} />
            <div>
              <div className="t-title">{t.title}</div>
              {t.text && <div className="t-text">{t.text}</div>}
            </div>
            <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))} aria-label="Dismiss">
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

/** Run an async action with busy state and toasts. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const run = useCallback(
    async (key, fn, { ok, okText } = {}) => {
      setBusy(key);
      try {
        const r = await fn();
        if (ok) toast({ kind: "good", title: ok, text: typeof okText === "function" ? okText(r) : okText });
        return r;
      } catch (e) {
        const reverted = /revert|custom error|CALL_EXCEPTION/i.test(e.message || "");
        toast({ kind: "bad", title: reverted ? "Transaction reverted" : "Not completed", text: cleanError(e.shortMessage || e.message), ms: 8000 });
        return null;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return [busy, run];
}

export function cleanError(msg = "") {
  const m = msg.match(/custom error '([^']+)'/) || msg.match(/reverted with reason string '([^']+)'/);
  return m ? m[1] : msg.replace(/^execution reverted: /, "").slice(0, 220);
}

// ---- drawer --------------------------------------------------------------

export function Drawer({ open, onClose, title, right, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const fn = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "Details"}>
        <div className="drawer-head">
          <div style={{ minWidth: 0 }}>{title}</div>
          <div className="spacer" />
          {right}
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

// ---- delta gauge ---------------------------------------------------------

/** Semicircle over delta from -20% to +40%, banded by the tiers the chain allows. */
export function DeltaGauge({ deltaBps, size = 240 }) {
  const lo = -2000;
  const hi = 4000;
  const w = size;
  const h = size * 0.62;
  const cx = w / 2;
  const cy = h - 10;
  const r = w / 2 - 18;
  const ang = (b) => Math.PI * (1 - (Math.min(hi, Math.max(lo, b)) - lo) / (hi - lo));
  const pt = (b, rr = r) => [cx + rr * Math.cos(ang(b)), cy - rr * Math.sin(ang(b))];
  const arc = (a, b) => {
    const [x1, y1] = pt(a);
    const [x2, y2] = pt(b);
    return `M${x1} ${y1} A${r} ${r} 0 0 1 ${x2} ${y2}`;
  };
  const bands = [
    [lo, 500, "var(--t2)"],
    [500, 1500, "var(--t1)"],
    [1500, hi, "var(--t0)"],
  ];
  const [mx, my] = pt(deltaBps ?? 0);
  const tier = deltaBps > 1500 ? 0 : deltaBps > 500 ? 1 : 2;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="gauge" width="100%" style={{ maxWidth: size }} role="img"
      aria-label={`Distance to liquidation ${(deltaBps / 100).toFixed(2)} percent; weakest tier allowed: ${TIER_SHORT[tier]}`}>
      {bands.map(([a, b, c]) => (
        <path key={a} d={arc(a + 25, b - 25)} stroke={c} strokeWidth="14" fill="none" strokeLinecap="round" opacity="0.9" />
      ))}
      {[0, 500, 1500].map((b) => {
        const [x, y] = pt(b, r + 13);
        return <text key={b} x={x} y={y} textAnchor="middle" fontSize="10.5" fill="var(--muted)">{b / 100}%</text>;
      })}
      <circle cx={mx} cy={my} r="10" fill="var(--ink)" stroke="var(--surface)" strokeWidth="3" />
      <circle cx={mx} cy={my} r="3.5" fill="var(--surface)" />
      <text x={cx} y={cy - 20} textAnchor="middle" fontSize="28" fontWeight="750" fill="var(--ink)">
        {deltaBps == null ? "—" : `${(deltaBps / 100).toFixed(1)}%`}
      </text>
      <text x={cx} y={cy} textAnchor="middle" fontSize="11" fill="var(--muted)">δ = threshold − LTV</text>
    </svg>
  );
}

// ---- features ----------------------------------------------------------

const FEATURES = [
  ["ltv", "Loan-to-value", (v) => v.toFixed(3)],
  ["collateral_volatility_30d", "30-day volatility", (v) => `${(v * 100).toFixed(1)}%`],
  ["price_momentum_24h", "24-hour momentum", (v) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`],
  ["time_since_last_topup_days", "Days since top-up", (v) => v.toFixed(0)],
  ["account_age_days", "Account age (days)", (v) => v.toFixed(0)],
];

export function FeatureBars({ q, features }) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      {FEATURES.map(([k, label, fmt], i) => (
        <div className="feature-row" key={k}>
          <div className="ink2">{label}</div>
          <div className="feature-track" title={`q = ${q?.[i]} / 1024`}>
            <span style={{ width: `${((q?.[i] ?? 0) / 1024) * 100}%`, transition: "width .5s" }} />
          </div>
          <div className="tnum" style={{ textAlign: "right", fontWeight: 600 }}>{features ? fmt(features[k]) : "—"}</div>
        </div>
      ))}
      <div className="small muted">
        Bars show the quantized value <span className="mono">q ∈ [0, 1024]</span> the contract computes and the circuit proves on:{" "}
        <span className="hash">[{q?.join(", ")}]</span>
      </div>
    </div>
  );
}

export function Proving({ label = "Generating a Tier-2 proof" }) {
  return (
    <div className="proving">
      <Icon name="cpu" className="spin" />
      <span>{label}…</span>
      <div className="proving-bar"><span /></div>
    </div>
  );
}

export function Empty({ icon = "layers", title, children }) {
  return (
    <div className="empty">
      <Icon name={icon} />
      <div style={{ fontWeight: 600, color: "var(--ink-2)" }}>{title}</div>
      {children}
    </div>
  );
}
