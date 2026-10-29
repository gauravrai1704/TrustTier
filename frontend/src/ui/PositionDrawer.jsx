// Everything about one position: the chain's own view of it, the model's
// verdict, its decision lifecycle, and the actions available in its state.
import { useEffect, useState } from "react";
import Icon from "./Icon";
import { Callout, DeltaGauge, Drawer, FeatureBars, Proving, StateBadge, TierBadge, useAction } from "./kit";
import { useBackend, useData } from "../api/backend";
import { useWallet } from "./Wallet";
import { AbiCoder, hexlify, keccak256, randomBytes } from "ethers";
import { engineContract, liquidatorContract, walletChallenge } from "../wallet";
import { explorerTx } from "../lib/account";
import { duration, eth, gas, num, short, usd } from "../lib/format";

const EVENT_TEXT = {
  PositionOpened: ["Position opened", "plus"],
  FeaturesSnapshotted: ["Features snapshotted for the claim", "lock"],
  SafeClaimRecorded: ["Bonded safe-claim recorded", "shield"],
  DecisionLogged: ["Decision written to the audit log", "doc"],
  CommitmentRevealed: ["Tier-1 commitment opened", "key"],
  CommitmentContradicted: ["Commitment contradicted its own claim", "alert"],
  ChallengeCommitted: ["Challenge committed", "lock"],
  DecisionChallenged: ["Claim slashed by a Tier-2 proof", "hammer"],
  LiquidationApproved: ["Liquidation approved by a verified proof", "check"],
  ClaimSuperseded: ["Open claim superseded by Tier 2", "layers"],
  ApprovalConsumed: ["Approval executed by the liquidator", "bolt"],
  PositionLiquidated: ["Soft liquidation executed", "bolt"],
  ApprovalExpired: ["Approval expired unexecuted", "clock"],
  BondReclaimed: ["Bond settled to the claimant", "coin"],
  RewardPaid: ["Claim reward paid", "coin"],
  BondForfeited: ["Unopened commitment forfeited", "alert"],
  PositionReopened: ["Position re-opened", "refresh"],
  FeaturesAnchored: ["Features anchored for a slow proof", "lock"],
};

export default function PositionDrawer({ id, onClose }) {
  const { backend, refresh } = useBackend();
  const wallet = useWallet();
  const { data: p, error } = useData((b) => b.getPosition(id), [id], { poll: 4000 });
  const { data: ev } = useData((b) => b.events(), [id], { poll: 4000 });
  const [busy, run] = useAction();
  const [proof, setProof] = useState(null);
  const [dishonest, setDishonest] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  useEffect(() => {
    setProof(null);
    setLastResult(null);
  }, [id]);

  const events = (ev?.events || []).filter((e) => Number(e.positionId) === Number(id));
  const live = backend?.mode === "live";
  const signer = live && wallet.state?.signer && wallet.deployment ? wallet.state.signer : null;
  const chainId = wallet.deployment?.chainId;

  /** The signed-in account decides the position itself: its key, its bond, its gas. */
  async function decideMyself() {
    const engine = engineContract(signer, wallet.deployment);
    const required = await engine.requiredBond();
    const bond = required > 10n ** 16n ? (required * 5n) / 4n : required;
    let tier = dishonest ? (p.allowed_tier === "HEURISTIC" ? "HEURISTIC" : "COMMITMENT") : p.allowed_tier;
    if (tier === "COMMITMENT" && !dishonest && p.model_label === 1) tier = "ZK_PROOF"; // never make a claim a watcher could slash
    if (tier === "HEURISTIC") {
      const r = await (await engine.decideHeuristic(id, p.past_round, { value: bond })).wait();
      wallet.record("decide_tier0", id, r);
      return { tier, gas: r.gasUsed, hash: r.hash };
    }
    if (tier === "COMMITMENT") {
      const score = BigInt(Math.round(p.model_p_high * 1e6));
      const salt = hexlify(randomBytes(32));
      const q = p.features_q.map(BigInt);
      const commitment = keccak256(AbiCoder.defaultAbiCoder().encode(["uint256[]", "int256", "bytes32"], [q, score, salt]));
      const r = await (await engine.decideCommitment(id, p.past_round, wallet.deployment.modelHash, commitment, { value: bond })).wait();
      wallet.record("decide_tier1", id, r);
      let gasUsed = r.gasUsed;
      if (!dishonest) {
        const r2 = await (await engine.revealCommitment(id, q, score, salt)).wait();
        wallet.record("reveal_commitment", id, r2);
        gasUsed += r2.gasUsed;
      }
      return { tier, gas: gasUsed, hash: r.hash };
    }
    const proof = await backend.currentProof(id);
    if (!proof.high_risk) return { tier, low: true };
    const r = await (await engine.decideZkProof(id, proof.past_round, proof.model_hash, proof.proof, proof.public_inputs.map(BigInt))).wait();
    wallet.record("decide_tier2", id, r);
    return { tier, gas: r.gasUsed, hash: r.hash };
  }

  async function routeMyself() {
    await run("mine", decideMyself, {
      ok: "Decided from your account",
      okText: (r) => (r.low ? "The proof shows low risk: nothing to submit." : `${r.tier.replace("_", " ")} · ${num(r.gas)} gas, paid by you${r.tier !== "ZK_PROOF" ? " · bond posted" : ""}`),
    });
    refresh();
  }

  async function route() {
    const force = dishonest ? (p.allowed_tier === "HEURISTIC" ? "HEURISTIC" : "COMMITMENT") : null;
    const r = await run("route", () => backend.evaluate(id, force), {
      ok: "Position routed",
      okText: (r) => r.outcome === "NOT_LIQUIDATED"
        ? "The proof shows low risk: nothing to liquidate, nothing submitted."
        : `${r.tier.replace("_", " ")} · ${num(r.gas_used)} gas${r.revealed ? " (claim + reveal)" : ""}`,
    });
    if (r) setLastResult(r);
    refresh();
  }

  async function check() {
    const r = await run("prove", () => backend.challengeProof(id));
    if (r) setProof(r);
  }

  async function challenge() {
    if (signer) {
      const r = await run("challenge", () => walletChallenge(signer, wallet.deployment, id, proof), {
        ok: "Claim slashed from your account", okText: "Commit + reveal confirmed; the bond is credited to you.",
      });
      if (r) wallet.record("challenge", id, r);
    } else {
      await run("challenge", () => backend.challenge(id), {
        ok: "Claim slashed", okText: (r) => (r.slashed ? `Commit-reveal challenge · ${num(r.gas_used)} gas` : r.detail),
      });
    }
    setProof(null);
    refresh();
  }

  async function liquidate() {
    if (signer) {
      const r = await run("liq", async () => (await liquidatorContract(signer, wallet.deployment).liquidate(id)).wait(), {
        ok: "Soft liquidation executed from your account", okText: "The 5% liquidation bonus was credited to you in the pool.",
      });
      if (r) wallet.record("liquidate", id, r);
    } else {
      await run("liq", () => backend.liquidate(id), {
        ok: "Soft liquidation executed", okText: (r) => `50% of the debt closed · ${num(r.gas_used)} gas`,
      });
    }
    refresh();
  }

  async function reclaim() {
    if (signer) {
      const r = await run("reclaim", async () => (await engineContract(signer, wallet.deployment).reclaimBond(id)).wait(), { ok: "Bond settled" });
      if (r) wallet.record("settle_bond", id, r);
    } else {
      await run("reclaim", () => backend.reclaim(id), { ok: "Bond settled", okText: (r) => `${num(r.gas_used)} gas` });
    }
    refresh();
  }

  const title = (
    <div>
      <div className="row" style={{ gap: 8 }}>
        <h3 style={{ fontSize: 16 }}>Position #{id}</h3>
        {p && <StateBadge state={p.state} />}
      </div>
      <div className="small muted">Read from the lending pool and Chainlink feeds by the contract itself</div>
    </div>
  );

  return (
    <Drawer open onClose={onClose} title={title}>
      {error && !p && <Callout icon="alert" kind="crit">{error}</Callout>}
      {!p ? (
        <Proving label="Reading the position" />
      ) : (
        <>
          <div className="card card-pad" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 16, alignItems: "center" }}>
            <DeltaGauge deltaBps={p.delta_bps} size={230} />
            <dl className="kv">
              <dt>Collateral</dt><dd>{usd(p.collateral_usd)}</dd>
              <dt>Debt</dt><dd>{usd(p.debt_usd)}</dd>
              <dt>Threshold</dt><dd>{(p.liquidation_threshold_bps / 100).toFixed(0)}%</dd>
              <dt>Chain allows</dt><dd><TierBadge tier={p.allowed_tier} short /></dd>
              <dt>Liquidations</dt><dd>{p.liquidations || 0}</dd>
            </dl>
          </div>

          <div className={`verdict ${p.model_label ? "high" : "low"}`}>
            <div className="verdict-score">{(p.model_p_high * 100).toFixed(1)}%</div>
            <div>
              <div style={{ fontWeight: 650 }}>{p.model_label ? "Model: HIGH RISK" : "Model: low risk"}</div>
              <div className="small ink2">P(high) from the registered model on these exact features — the value a Tier-2 proof would attest to.</div>
            </div>
          </div>

          <section className="card card-pad stack">
            <h3 style={{ fontSize: 14 }}>On-chain features</h3>
            <FeatureBars q={p.features_q} features={p.features} />
          </section>

          <section className="card card-pad stack">
            <h3 style={{ fontSize: 14 }}>Actions</h3>
            {p.state === "CLAIM_OPEN" && (
              <Callout icon="clock" kind="warn">
                <strong>{p.tier} claim open</strong> — bond {eth(p.bond_wei)} by {short(p.claimant)}, challengeable for{" "}
                <span className="countdown">{duration(p.seconds_until_deadline)}</span>.
                {p.tier === "Commitment" && (p.commitment_revealed ? " Commitment opened." : " Commitment NOT opened — it forfeits if it stays closed.")}
              </Callout>
            )}
            {p.state === "APPROVED" && (
              <Callout icon="bolt" kind="crit">
                <strong>Liquidation approved.</strong> Executable through TrustTierLiquidator for{" "}
                <span className="countdown">{duration(p.approval_expires_in)}</span>; it closes 50% of the debt with a 5% bonus to the executor.
              </Callout>
            )}

            {["UNDECIDED", "SETTLED", "AWAITING_SETTLEMENT", "SLASHED", "APPROVAL_EXPIRED"].includes(p.state) && (
              <div className="stack" style={{ gap: 10 }}>
                <label className="check">
                  <input type="checkbox" checked={dishonest} onChange={(e) => setDishonest(e.target.checked)} />
                  Act as a dishonest router: claim the cheapest tier and keep any commitment closed
                </label>
                <button className="btn btn-primary" disabled={!!busy} onClick={route}>
                  <Icon name="play" />
                  {busy === "route" ? "Routing…" : dishonest ? "Router: make a cheap claim anyway" : "Route through TrustTier"}
                </button>
                {signer && (
                  <button className="btn" disabled={!!busy} onClick={routeMyself}>
                    <Icon name="key" />{busy === "mine" ? "Waiting for your signatures…" : "Decide it myself (sign with my account)"}
                  </button>
                )}
                {!wallet.state && <div className="small muted"><a href="#" onClick={(e) => { e.preventDefault(); wallet.openSignIn(); }}>Sign in</a> to make claims, challenges and liquidations from your own account.</div>}
                {(busy === "route" || busy === "mine") && p.allowed_tier === "ZK_PROOF" && <Proving />}
              </div>
            )}

            {p.state === "CLAIM_OPEN" && (
              <div className="stack" style={{ gap: 10 }}>
                <button className="btn" disabled={!!busy} onClick={check}>
                  <Icon name="eye" />Check this claim with a Tier-2 proof
                </button>
                {busy === "prove" && <Proving label="Proving the snapshotted features" />}
                {proof && (
                  <div className={`verdict ${proof.high_risk ? "high" : "low"}`}>
                    <Icon name={proof.high_risk ? "alert" : "check"} />
                    <div className="small">
                      <strong>{proof.high_risk ? "HIGH RISK — the safe-claim was false." : "Low risk — the claim holds."}</strong>{" "}
                      Proof ({proof.proof_kind}{proof.proving_seconds ? `, ${proof.proving_seconds}s` : ""}) on snapshot{" "}
                      <span className="hash">[{proof.features_q.join(", ")}]</span>
                    </div>
                  </div>
                )}
                {proof?.high_risk && (
                  <button className="btn btn-danger" disabled={!!busy} onClick={challenge}>
                    <Icon name="hammer" />
                    {busy === "challenge" ? "Committing, then revealing…" : signer ? "Slash it from my account (commit + reveal)" : "Slash the bond (commit + reveal)"}
                  </button>
                )}
              </div>
            )}

            {p.state === "AWAITING_SETTLEMENT" && (
              <button className="btn" disabled={!!busy} onClick={reclaim}><Icon name="coin" />Settle the bond</button>
            )}
            {p.state === "APPROVED" && (
              <button className="btn btn-danger" disabled={!!busy} onClick={liquidate}>
                <Icon name="bolt" />{busy === "liq" ? "Executing…" : signer ? "Execute from my account (earn the bonus)" : "Execute the soft liquidation"}
              </button>
            )}
            {lastResult && (
              <div className="small ink2">
                Last route: <TierBadge tier={lastResult.tier} short /> {lastResult.tier_reason}
              </div>
            )}
          </section>

          <section className="card card-pad stack">
            <h3 style={{ fontSize: 14 }}>Lifecycle</h3>
            {events.length === 0 ? (
              <div className="small muted">No events yet.</div>
            ) : (
              <ul className="timeline">
                {events.slice().reverse().slice(0, 14).map((e, i) => {
                  const [text, icon] = EVENT_TEXT[e.type] || [e.type, "info"];
                  return (
                    <li key={i}>
                      <span className="node"><Icon name={icon} /></span>
                      <div className="t-title">{text}</div>
                      <div className="t-meta">
                        {explorerTx(chainId, e.txHash) ? <a href={explorerTx(chainId, e.txHash)} target="_blank" rel="noreferrer">block {e.blockNumber}</a> : <>block {e.blockNumber}</>}
                        {e.tier ? ` · ${e.tier}` : ""}
                        {e.bond ? ` · ${eth(e.bond)}` : ""}
                        {e.amount ? ` · ${eth(e.amount)}` : ""}
                        {e.debtRepaidUsd ? ` · repaid ${usd(e.debtRepaidUsd)}` : ""}
                        {e.score != null ? ` · score ${(e.score * 100).toFixed(1)}%` : ""}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="small muted">Gas figures are measured on the real contracts; Tier 2 uses the real EZKL verifier ({gas(878059)} gas).</div>
          </section>
        </>
      )}
    </Drawer>
  );
}
