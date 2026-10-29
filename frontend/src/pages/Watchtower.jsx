import { useState } from "react";
import Icon from "../ui/Icon";
import { Callout, Card, Empty, Proving, Stat, TierBadge, useAction } from "../ui/kit";
import { useBackend, useData } from "../api/backend";
import { go } from "../lib/router";
import { duration, eth, num, short } from "../lib/format";
import GAS from "../../../off-chain/evaluation/results/gas_measurements.json";

export default function Watchtower() {
  const { backend, refresh } = useBackend();
  const { data: ov } = useData((b) => b.overview(), [], { poll: 5000 });
  const { data, loading } = useData((b) => b.listPositions(), [], { poll: 4000 });
  const [busy, run] = useAction();
  const [scan, setScan] = useState({});
  const pr = ov?.protocol;
  const claims = (data?.positions || []).filter((p) => p.state === "CLAIM_OPEN");
  const approvals = (data?.positions || []).filter((p) => p.state === "APPROVED");
  const baseFee = pr ? Number(pr.base_fee_wei) : 0;
  const challengeCost = (GAS.commitChallenge + GAS.revealChallenge) * baseFee;

  async function scanAll() {
    await run("scan", async () => {
      const out = {};
      for (const c of claims) {
        const p = await backend.challengeProof(c.position_id);
        out[c.position_id] = p;
        setScan((s) => ({ ...s, [c.position_id]: p }));
      }
      return out;
    }, { ok: "Scan complete", okText: (o) => `${Object.values(o).filter((p) => p.high_risk).length} of ${Object.keys(o).length} claims are false` });
  }

  async function slash(id) {
    await run(`c${id}`, () => backend.challenge(id), { ok: `Claim #${id} slashed`, okText: (r) => (r.slashed ? `Bond credited to the watcher · ${num(r.gas_used)} gas` : r.detail) });
    refresh();
  }

  async function execute(id) {
    await run(`l${id}`, () => backend.liquidate(id), { ok: `Position #${id} soft-liquidated`, okText: (r) => `${num(r.gas_used)} gas` });
    refresh();
  }

  return (
    <>
      <div className="grid g4">
        <Stat label="Bond required now" value={pr ? eth(pr.required_bond_wei, 3) : "—"} note={`max(0.01 ETH, 1.5M gas × base fee)`} accent />
        <Stat label="Challenge cost at this base fee" value={!pr ? "—" : challengeCost < 1e14 ? `${num(challengeCost / 1e9, 0)} gwei` : `${Number((challengeCost / 1e18).toPrecision(2))} ETH`}
          note={`${num(GAS.commitChallenge + GAS.revealChallenge)} gas, commit + reveal`} />
        <Stat label="Reward pool" value={pr ? eth(pr.reward_pool_wei, 3) : "—"} note={pr ? `${eth(pr.claim_reward_wei, 4)} per honest claim, ≤1/day/position` : ""} />
        <Stat label="Open claims · approvals" value={`${claims.length} · ${approvals.length}`} note="claims are challengeable for 1 hour" />
      </div>

      <Callout icon="shield">
        <strong>Why anyone watches.</strong> Every cheap claim posts a bond that pays for the challenge that would slash it, at
        {" "}{!baseFee ? "—" : Number(pr.required_bond_wei) / challengeCost > 100 ? "over 100" : (Number(pr.required_bond_wei) / challengeCost).toFixed(1)}×
        the cost at the current base fee, and the bond rises with the base fee. A watcher that finds a false claim profits; one that
        commits first cannot be front-run.
      </Callout>

      <div className="grid g2">
        <Card title="Open claims" sub="Bonded safe-claims inside their challenge window"
          right={claims.length > 0 && <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={scanAll}><Icon name="eye" />Scan all</button>}>
          {busy === "scan" && <div style={{ marginBottom: 12 }}><Proving label="Proving each claim's snapshot" /></div>}
          {loading && !data ? <Proving label="Reading positions from the chain" /> : !claims.length ? (
            <Empty icon="watch" title="No open claims">
              <span className="small">Route a position in Tier 0/1 — or act as a dishonest router — to create one.</span>
            </Empty>
          ) : (
            <div className="feed">
              {claims.map((c) => {
                const s = scan[c.position_id];
                return (
                  <div key={c.position_id} className="feed-item" style={{ gridTemplateColumns: "32px 1fr auto" }}>
                    <div className="feed-ic"><Icon name="shield" /></div>
                    <div style={{ minWidth: 0 }}>
                      <div className="feed-title row" style={{ gap: 8 }}>
                        <a href={`#/positions/${c.position_id}`}>#{c.position_id}</a> <TierBadge tier={c.tier} short />
                        {s && (s.high_risk ? <span className="pill pill-crit"><Icon name="alert" />false</span> : <span className="pill pill-good"><Icon name="check" />holds</span>)}
                      </div>
                      <div className="feed-meta">
                        bond {eth(c.bond_wei)} · {short(c.claimant)} · <span className="countdown">{duration(c.seconds_until_deadline)}</span> left
                        {c.tier === "Commitment" && !c.commitment_revealed && " · commitment closed"}
                      </div>
                    </div>
                    {s?.high_risk ? (
                      <button className="btn btn-danger btn-sm" disabled={!!busy} onClick={() => slash(c.position_id)}><Icon name="hammer" />Slash</button>
                    ) : (
                      <button className="btn btn-sm" onClick={() => go(`positions/${c.position_id}`)}>Inspect</button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card title="Approved liquidations" sub="Verified Tier-2 approvals waiting for the liquidator">
          {loading && !data ? <Proving label="Reading positions from the chain" /> : !approvals.length ? (
            <Empty icon="bolt" title="Nothing to execute">
              <span className="small">A Tier-2 proof that a position is high risk creates an approval here.</span>
            </Empty>
          ) : (
            <div className="feed">
              {approvals.map((a) => (
                <div key={a.position_id} className="feed-item">
                  <div className="feed-ic" style={{ color: "var(--critical)" }}><Icon name="bolt" /></div>
                  <div>
                    <div className="feed-title"><a href={`#/positions/${a.position_id}`}>#{a.position_id}</a> · δ {(a.delta_bps / 100).toFixed(1)}% · P(high) {(a.model_p_high * 100).toFixed(0)}%</div>
                    <div className="feed-meta">expires in <span className="countdown">{duration(a.approval_expires_in)}</span> · closes 50% of the debt, 5% bonus to the executor</div>
                  </div>
                  <button className="btn btn-danger btn-sm" disabled={!!busy} onClick={() => execute(a.position_id)}><Icon name="bolt" />Execute</button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
