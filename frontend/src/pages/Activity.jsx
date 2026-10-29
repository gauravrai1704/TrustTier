import { useState } from "react";
import Icon from "../ui/Icon";
import { Card, Empty } from "../ui/kit";
import { useData } from "../api/backend";
import { eth, short, usd } from "../lib/format";

const META = {
  SafeClaimRecorded: ["Safe-claim recorded", "shield", "claims"],
  DecisionLogged: ["Decision logged", "doc", "claims"],
  CommitmentRevealed: ["Commitment opened", "key", "claims"],
  CommitmentContradicted: ["Commitment contradicted its claim", "alert", "slashing"],
  BondForfeited: ["Bond forfeited", "alert", "slashing"],
  ChallengeCommitted: ["Challenge committed", "lock", "slashing"],
  DecisionChallenged: ["Claim slashed", "hammer", "slashing"],
  LiquidationApproved: ["Liquidation approved", "check", "liquidations"],
  ApprovalConsumed: ["Approval consumed", "bolt", "liquidations"],
  PositionLiquidated: ["Soft liquidation", "bolt", "liquidations"],
  ApprovalExpired: ["Approval expired", "clock", "liquidations"],
  BondReclaimed: ["Bond settled", "coin", "money"],
  RewardPaid: ["Reward paid", "coin", "money"],
  Withdrawn: ["Withdrawal", "wallet", "money"],
  PositionOpened: ["Position opened", "plus", "claims"],
  PriceUpdated: ["Price feed updated", "trend", "claims"],
  FeaturesAnchored: ["Features anchored", "lock", "liquidations"],
};
const TONE = { slashing: "var(--critical)", liquidations: "var(--accent)", money: "var(--good-ink)", claims: "var(--ink-2)" };

export default function Activity() {
  const { data } = useData((b) => b.events(), [], { poll: 3000 });
  const [f, setF] = useState("all");
  const events = (data?.events || []).filter((e) => e.type !== "FeaturesSnapshotted" && e.type !== "ClaimSuperseded" && e.type !== "PositionReopened")
    .filter((e) => f === "all" || (META[e.type] || [])[2] === f).slice().reverse().slice(0, 120);
  return (
    <Card title="On-chain activity" sub={data ? `Latest block ${data.latest_block} · read straight from contract events` : "Loading…"}
      right={
        <div className="seg">
          {[["all", "All"], ["claims", "Claims"], ["slashing", "Slashing"], ["liquidations", "Liquidations"], ["money", "Payouts"]].map(([k, l]) => (
            <button key={k} className={f === k ? "on" : ""} onClick={() => setF(k)}>{l}</button>
          ))}
        </div>
      }>
      {!events.length ? (
        <Empty icon="activity" title="No events yet"><span className="small">Run the guided demo on the overview page.</span></Empty>
      ) : (
        <div className="feed">
          {events.map((e, i) => {
            const [t, ic, cat] = META[e.type] || [e.type, "info", "claims"];
            return (
              <div className="feed-item" key={`${e.txHash}${i}`}>
                <div className="feed-ic" style={{ color: TONE[cat] }}><Icon name={ic} /></div>
                <div style={{ minWidth: 0 }}>
                  <div className="feed-title">
                    {t}{e.positionId != null && <> · <a href={`#/positions/${e.positionId}`}>#{e.positionId}</a></>}
                    {e.tier && <span className="muted"> · {e.tier}</span>}
                    {e.market && <span className="muted"> · {e.market} {usd(e.price)}</span>}
                  </div>
                  <div className="feed-meta">
                    {e.bond && `bond ${eth(e.bond)} · `}{e.amount && `${eth(e.amount)} · `}
                    {e.claimant && `claimant ${short(e.claimant)} · `}{e.challenger && `by ${short(e.challenger)} · `}
                    {e.debtRepaidUsd != null && `repaid ${usd(e.debtRepaidUsd)} · `}
                    <span className="mono">{short(e.txHash, 8)}</span>
                  </div>
                </div>
                <div className="small muted tnum">#{e.blockNumber}</div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
