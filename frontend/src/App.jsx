import { useEffect, useRef, useState } from "react";
import Icon, { Logo } from "./ui/Icon";
import { ToastProvider, useAction } from "./ui/kit";
import { WalletButton, WalletProvider } from "./ui/Wallet";
import { BackendProvider, useBackend, useData } from "./api/backend";
import { useRoute } from "./lib/router";
import { useTheme } from "./lib/theme";
import Overview from "./pages/Overview";
import Positions from "./pages/Positions";
import Watchtower from "./pages/Watchtower";
import Economics from "./pages/Economics";
import Activity from "./pages/Activity";
import Protocol from "./pages/Protocol";
import Ledger from "./pages/Ledger";

const PAGES = {
  overview: { title: "Overview", icon: "overview", crumb: "Cost-tiered zero-knowledge verification for DeFi liquidations", C: Overview },
  positions: { title: "Positions", icon: "positions", crumb: "Open, route, challenge and liquidate", C: Positions },
  watchtower: { title: "Watchtower", icon: "watch", crumb: "Catch false claims, execute approvals", C: Watchtower },
  economics: { title: "Economics", icon: "economics", crumb: "Measured gas, baselines and incentives", C: Economics },
  activity: { title: "Activity", icon: "activity", crumb: "Contract events, live", C: Activity },
  ledger: { title: "Ledger", icon: "database", crumb: "The database: every event and every action", C: Ledger },
  protocol: { title: "Protocol", icon: "protocol", crumb: "Deployment, trust assumptions, connection", C: Protocol },
};

function ModePill() {
  const { status } = useBackend();
  if (status === "live") return <span className="pill pill-good"><span className="live-dot" />On-chain</span>;
  if (status === "sim") return <a href="#/protocol" className="pill pill-accent" style={{ textDecoration: "none" }}><Icon name="cpu" />Simulation</a>;
  if (status === "unreachable") return <a href="#/protocol" className="pill pill-crit" style={{ textDecoration: "none" }}><Icon name="alert" />Router unreachable</a>;
  return <span className="pill"><Icon name="refresh" className="spin" />Connecting</span>;
}

function TimeTravel() {
  const { backend, refresh } = useBackend();
  const { data } = useData((b) => b.overview(), [], { poll: 5000 });
  const [busy, run] = useAction();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const fn = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);
  const local = backend?.mode === "sim" || [31337, 1337].includes(data?.protocol?.chain_id);
  if (!local) return null;
  const t = data?.protocol?.block_time;
  const go = async (s, label) => {
    await run("t", () => backend.advance(s), { ok: `Fast-forwarded ${label}`, okText: "Windows, approvals and anchors moved on with the clock." });
    refresh();
    setOpen(false);
  };
  return (
    <div className="pop-anchor" ref={ref}>
      <button className="btn" onClick={() => setOpen((o) => !o)} title="Chain clock">
        <Icon name="clock" />
        <span className="tnum hide-sm">{t ? new Date(t * 1000).toISOString().slice(5, 16).replace("T", " ") : "—"}</span>
      </button>
      {open && (
        <div className="popover" style={{ width: 260 }}>
          <div className="small muted">Local chain clock (UTC). Skip ahead to close challenge windows or expire approvals.</div>
          <div className="row-wrap">
            {[[600, "10 min"], [1860, "31 min"], [3660, "1 hour"], [86400, "1 day"]].map(([s, l]) => (
              <button key={s} className="btn btn-sm" disabled={!!busy} onClick={() => go(s, l)}><Icon name="forward" />{l}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Shell() {
  const route = useRoute();
  const theme = useTheme();
  const page = PAGES[route.page] || PAGES.overview;
  const { status } = useBackend();
  const P = page.C;
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#/overview" style={{ textDecoration: "none", color: "inherit" }}>
          <Logo />
          <div><div className="brand-name">TrustTier</div><div className="brand-sub">Risk-tiered ZK verification</div></div>
        </a>
        <nav className="nav" aria-label="Main">
          <div className="nav-label">App</div>
          {Object.entries(PAGES).map(([k, p]) => (
            <a key={k} href={`#/${k}`} className={route.page === k || (k === "overview" && !PAGES[route.page]) ? "active" : ""}>
              <Icon name={p.icon} />{p.title}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="mode-card">
            {status === "live" ? (
              <><strong>On-chain mode.</strong> Every action is a transaction on the connected chain.</>
            ) : (
              <><strong>Simulation mode.</strong> The contract's rules and the real model, in your browser. <a href="#/protocol">Go on-chain</a>.</>
            )}
          </div>
          <a className="small muted" href="https://github.com/gauravrai1704/TrustTier" target="_blank" rel="noreferrer">
            <Icon name="external" className="" /> Source on GitHub
          </a>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div>
            <h1>{page.title}</h1>
            <div className="crumb">{page.crumb}</div>
          </div>
          <div className="topbar-right">
            <ModePill />
            <TimeTravel />
            <button className="btn btn-icon" onClick={theme.toggle} aria-label={`Switch to ${theme.resolved === "dark" ? "light" : "dark"} mode`}
              title={`Switch to ${theme.resolved === "dark" ? "light" : "dark"} mode`}>
              <Icon name={theme.resolved === "dark" ? "sun" : "moon"} />
            </button>
            <WalletButton />
          </div>
        </header>
        <main className="content">
          <P params={route.params} />
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Main">
        {Object.entries(PAGES).map(([k, p]) => (
          <a key={k} href={`#/${k}`} className={route.page === k ? "active" : ""}><Icon name={p.icon} />{p.title}</a>
        ))}
      </nav>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <BackendProvider>
        <WalletProvider>
          <Shell />
        </WalletProvider>
      </BackendProvider>
    </ToastProvider>
  );
}
