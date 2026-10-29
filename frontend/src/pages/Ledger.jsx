// The ledger database: every contract event (indexed from the chain, with
// the transaction's sender) and every action requested through the app.
import { useEffect, useState } from "react";
import Icon from "../ui/Icon";
import { Callout, Card, Empty, Stat } from "../ui/kit";
import { Avatar, useWallet } from "../ui/Wallet";
import { useBackend, useData } from "../api/backend";
import { explorerTx } from "../lib/account";
import { go } from "../lib/router";
import { eth, num, short, usd } from "../lib/format";

const PAGE = 25;
const TYPES = ["SafeClaimRecorded", "DecisionLogged", "CommitmentRevealed", "CommitmentContradicted", "BondForfeited",
  "ChallengeCommitted", "DecisionChallenged", "LiquidationApproved", "ApprovalConsumed", "ApprovalExpired",
  "PositionLiquidated", "BondReclaimed", "RewardPaid", "Withdrawn", "Deposited", "FeaturesAnchored", "PositionOpened"];

function when(t) {
  return t ? new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19) : "—";
}

function amountOf(e) {
  if (e.amount_wei && e.amount_wei !== "0") return eth(e.amount_wei);
  if (e.data?.debtRepaidUsd != null) return `repaid ${usd(Number(e.data.debtRepaidUsd) / 1e8)}`;
  if (e.data?.score != null) return `score ${(Number(e.data.score) / (Number(e.data.score) > 1 ? 1e4 : 0.01)).toFixed(1)}%`;
  return "";
}

function Leader({ title, rows, unit, icon }) {
  return (
    <Card title={title}>
      {!rows?.length ? <div className="small muted">Nobody yet.</div> : (
        <div className="feed">
          {rows.map((r, i) => (
            <div key={r.address} className="feed-item" style={{ gridTemplateColumns: "26px 1fr auto" }}>
              <div className="tnum muted" style={{ fontWeight: 700 }}>#{i + 1}</div>
              <a className="row" style={{ gap: 8, minWidth: 0, color: "inherit" }} href={`#/ledger/account/${r.address}`}>
                <Avatar address={r.address} /><span className="mono small">{short(r.address, 6)}</span>
              </a>
              <div className="small tnum" style={{ textAlign: "right" }}>
                <b>{r.count}</b> {unit}{r.amount_wei && r.amount_wei !== "0" ? <div className="muted">{eth(r.amount_wei, 3)}</div> : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function EventTable({ fixedActor }) {
  const { backend } = useBackend();
  const [f, setF] = useState({ type: "", position_id: "", actor: fixedActor || "" });
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [f.type, f.position_id, f.actor]);
  const { data } = useData((b) => b.dbEvents({ ...f, limit: PAGE, offset: page * PAGE }), [f.type, f.position_id, f.actor, page], { poll: 5000 });
  const { data: dep } = useData((b) => b.deployment(), []);
  const chainId = dep?.chainId;
  const total = data?.total ?? 0;

  function csv() {
    if (backend.mode === "live") {
      window.open(backend.dbCsvUrl({ type: f.type, position_id: f.position_id, actor: f.actor }), "_blank");
      return;
    }
    backend.dbEvents({ ...f, limit: 100000 }).then((d) => {
      const cols = ["block_number", "block_time", "tx_hash", "type", "position_id", "actor", "tier", "amount_wei"];
      const text = [cols.join(","), ...d.events.map((e) => cols.map((c) => JSON.stringify(e[c] ?? "")).join(","))].join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      a.download = "trusttier-events.csv";
      a.click();
    });
  }

  return (
    <Card title="Events" sub={`${num(total)} matching · indexed from the contracts, with each transaction's sender`} pad={false}
      right={<button className="btn btn-sm" onClick={csv}><Icon name="download" />CSV</button>}>
      <div className="row-wrap" style={{ padding: "12px 20px 0" }}>
        <select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          <option value="">All event types</option>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input className="input" style={{ width: 150 }} placeholder="Position #" value={f.position_id} onChange={(e) => setF({ ...f, position_id: e.target.value.replace(/\D/g, "") })} />
        {!fixedActor && <input className="input" style={{ width: 260 }} placeholder="Sender address 0x…" value={f.actor} onChange={(e) => setF({ ...f, actor: e.target.value.trim() })} />}
      </div>
      {!data?.events?.length ? <Empty icon="database" title="No events match" /> : (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="table">
            <thead><tr><th>Block</th><th>Time (UTC)</th><th>Event</th><th>Position</th><th>Sender</th><th>Detail</th><th>Tx</th></tr></thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={`${e.tx_hash}${e.log_index}`} style={{ cursor: "default" }}>
                  <td className="tnum">{e.block_number}</td>
                  <td className="tnum small">{when(e.block_time)}</td>
                  <td><b style={{ fontWeight: 600 }}>{e.type}</b>{e.tier && <span className="muted"> · {e.tier}</span>}</td>
                  <td>{e.position_id ? <a href={`#/positions/${e.position_id}`}>#{e.position_id}</a> : "—"}</td>
                  <td>{e.actor ? <a className="row" style={{ gap: 6, color: "inherit" }} href={`#/ledger/account/${e.actor}`}><Avatar address={e.actor} size={16} /><span className="mono small">{short(e.actor, 4)}</span></a> : "—"}</td>
                  <td className="small">{amountOf(e)}</td>
                  <td>{explorerTx(chainId, e.tx_hash) ? <a className="mono small" href={explorerTx(chainId, e.tx_hash)} target="_blank" rel="noreferrer">{short(e.tx_hash, 6)}</a> : <span className="mono small muted">{short(e.tx_hash, 6)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ padding: "12px 20px 16px" }}>
        <span className="small muted">{total ? `${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)} of ${num(total)}` : ""}</span>
        <div className="spacer" />
        <button className="btn btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
        <button className="btn btn-sm" disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </Card>
  );
}

function ActionLog({ rows, title = "Action log", sub = "Every action requested through the app, with who asked and what it cost" }) {
  return (
    <Card title={title} sub={sub} pad={false}>
      {!rows?.length ? <Empty icon="doc" title="No actions yet" /> : (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="table">
            <thead><tr><th>When (UTC)</th><th>Action</th><th>Position</th><th>Account</th><th>Result</th><th className="num">Gas</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} style={{ cursor: "default" }}>
                  <td className="tnum small">{when(a.ts)}</td>
                  <td><b style={{ fontWeight: 600 }}>{a.action}</b></td>
                  <td>{a.position_id ? <a href={`#/positions/${a.position_id}`}>#{a.position_id}</a> : "—"}</td>
                  <td>{a.address ? <a className="row" style={{ gap: 6, color: "inherit" }} href={`#/ledger/account/${a.address}`}><Avatar address={a.address} size={16} /><span className="mono small">{short(a.address, 4)}</span></a> : <span className="muted small">anonymous</span>}</td>
                  <td className="small">{a.ok ? <span className="pill pill-good"><Icon name="check" />ok</span> : <span className="pill pill-crit"><Icon name="x" />failed</span>} <span className="muted">{(a.detail || "").slice(0, 60)}</span></td>
                  <td className="num">{a.gas_used ? num(a.gas_used) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Account({ address }) {
  const w = useWallet();
  const { data } = useData((b) => b.dbAccount(address), [address], { poll: 5000 });
  const mine = w.state?.address?.toLowerCase() === address.toLowerCase();
  const count = (t) => (data?.events || []).filter((e) => e.type === t).length;
  return (
    <>
      <div className="row">
        <button className="btn btn-sm btn-ghost" onClick={() => go("ledger")}><Icon name="chevron" className="" />All records</button>
      </div>
      <section className="card card-pad row" style={{ gap: 16 }}>
        <Avatar address={address} size={52} />
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}><h2 style={{ fontSize: 18 }}>{mine ? "Your account" : "Account"}</h2>{data?.user && <span className="pill pill-good"><Icon name="check" />signed in {data.user.sign_ins}×</span>}</div>
          <div className="mono small muted" style={{ wordBreak: "break-all" }}>{address}</div>
          {data?.user && <div className="small muted">first seen {when(data.user.created_at)} · last seen {when(data.user.last_seen)}</div>}
        </div>
      </section>
      <div className="grid g4">
        <Stat label="Safe-claims made" value={count("SafeClaimRecorded")} />
        <Stat label="Claims slashed (as watcher)" value={count("DecisionChallenged")} />
        <Stat label="Liquidations executed" value={count("PositionLiquidated")} />
        <Stat label="Actions through the app" value={data?.actions?.length ?? 0} />
      </div>
      <EventTable fixedActor={address} />
      <ActionLog rows={data?.actions} title="Actions by this account" sub="Requests made through the router while signed in" />
    </>
  );
}

export default function Ledger({ params }) {
  const { backend } = useBackend();
  const { data: s } = useData((b) => b.dbSummary(), [], { poll: 5000 });
  const { data: lb } = useData((b) => b.dbLeaderboard(), [], { poll: 8000 });
  const { data: acts } = useData((b) => b.dbActions(40), [], { poll: 5000 });
  const { data: deps } = useData((b) => b.dbDeployments(), [], { poll: 15000 });
  if (params?.[0] === "account" && params[1]) return <Account address={params[1]} />;
  return (
    <>
      <Callout icon="database">
        <strong>{backend?.mode === "live" ? "SQLite ledger, indexed from the chain." : "Simulated ledger, kept in this browser."}</strong>{" "}
        The chain is the source of truth: the indexer stores every event the contracts emit, with the sender and block time, and can rebuild
        this database from scratch at any time. The action log adds what the chain cannot know — who asked the router for what.
        {deps?.deployments?.length > 1 && ` ${deps.deployments.length} chain runs are kept separately.`}
      </Callout>
      <div className="grid g4">
        <Stat label="Events indexed" value={s ? num(s.events) : "—"} note={s ? `up to block ${s.indexed_block ?? "—"}` : ""} accent />
        <Stat label="Accounts seen · signed in" value={s ? `${s.actors} · ${s.users}` : "—"} note="senders on-chain · SIWE users" />
        <Stat label="ETH slashed from false claims" value={s ? eth(s.slashed_wei, 3) : "—"} note={s ? `forfeited ${eth(s.forfeited_wei, 3)} · rewards ${eth(s.rewards_wei, 3)}` : ""} />
        <Stat label="Debt repaid by soft liquidations" value={s ? usd(s.debt_repaid_usd, 0) : "—"} note={s ? `${s.by_type?.PositionLiquidated || 0} liquidations · ${num(s.actions)} app actions` : ""} />
      </div>
      <div className="grid g3">
        <Leader title="Top watchers" rows={lb?.watchers} unit="slashed" />
        <Leader title="Top claimants" rows={lb?.claimants} unit="claims" />
        <Leader title="Top liquidators" rows={lb?.liquidators} unit="executed" />
      </div>
      <EventTable />
      <ActionLog rows={acts?.actions} />
      {deps?.deployments?.length > 0 && (
        <Card title="Chain runs" sub="A local chain that restarts starts a new epoch; earlier runs stay queryable">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Deployment (chain : engine : epoch)</th><th className="num">Events</th><th>From</th><th>To</th></tr></thead>
              <tbody>
                {deps.deployments.map((d) => (
                  <tr key={d.deployment} style={{ cursor: "default" }}>
                    <td className="mono small">{d.deployment}{d.deployment === deps.current && <span className="pill pill-accent" style={{ marginLeft: 8 }}>current</span>}</td>
                    <td className="num">{num(d.events)}</td><td className="small tnum">{when(d.first)}</td><td className="small tnum">{when(d.last)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
