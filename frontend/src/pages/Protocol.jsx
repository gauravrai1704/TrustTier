import { Fragment, useState } from "react";
import { DEFAULT_RPC, MANIFESTS } from "../api/chain";
import { explorerAddress } from "../lib/account";
import { useAction } from "../ui/kit";
import Icon from "../ui/Icon";
import { Callout, Card, useToast } from "../ui/kit";
import { useBackend, useData } from "../api/backend";
import { short } from "../lib/format";
import { MODEL_HASH } from "../sim/model";

const TRUST = [
  ["link", "The lending protocol's accounting", "Collateral, debt and threshold come from the protocol (or the Aave V3 adapter). TrustTier trusts exactly what the protocol already trusts."],
  ["trend", "Chainlink feeds", "Price, 24-hour round and realized volatility. Stale answers, a bad 24-hour round, phase-boundary rounds and a down L2 sequencer are all rejected on-chain."],
  ["protocol", "Governance pointers", "The verifier, the position source and the liquidator are owner-settable — behind an M-of-N multisig and a timelock in a governed deployment."],
  ["key", "The proving setup", "The KZG SRS is self-generated for the testnet demo; production needs a ceremony SRS."],
  ["cpu", "Nothing else", "No oracle supplies features, no router chooses the tier, and no party can liquidate without a verified proof."],
];

export default function Protocol() {
  const { backend, status, pref, update } = useBackend();
  const toast = useToast();
  const { data: ov } = useData((b) => b.overview(), []);
  const { data: dep } = useData((b) => b.deployment(), []);
  const [url, setUrl] = useState(pref.url);
  const [rpc, setRpc] = useState(pref.rpc || DEFAULT_RPC[pref.network] || DEFAULT_RPC.sepolia);
  const [busy, run] = useAction();
  const networks = Object.keys(MANIFESTS);
  const { data: stale } = useData((b) => (b.mode === "chain" ? b.staleFeeds() : Promise.resolve([])), []);
  const chainId = dep?.chainId;
  return (
    <>
      <div className="grid g2">
        <Card title="Connection" sub={status === "live" ? `Router: ${ov?.network} · chain ${ov?.protocol?.chain_id}` : status === "chain" ? `Direct: ${backend?.network} over ${backend?.rpcUrl}` : status === "sim" ? "In-browser simulation" : status}>
          <div className="stack">
            <div className="seg" role="radiogroup" aria-label="Backend">
              {[["auto", "Auto"], ["live", "Router"], ...(networks.length ? [["chain", "Direct to chain"]] : []), ["sim", "Simulation"]].map(([k, l]) => (
                <button key={k} className={pref.mode === k ? "on" : ""} onClick={() => update({ mode: k })}>{l}</button>
              ))}
            </div>
            <label className="field">Router URL
              <div className="row">
                <input className="input" style={{ flex: 1 }} value={url} onChange={(e) => setUrl(e.target.value)} />
                <button className="btn" onClick={() => update({ url })}>Connect</button>
              </div>
            </label>
            {networks.length > 0 && (
              <label className="field">Direct mode: network and RPC
                <div className="row">
                  <select className="select" value={pref.network || ""} onChange={(e) => { update({ network: e.target.value, rpc: null }); setRpc(DEFAULT_RPC[e.target.value] || DEFAULT_RPC.sepolia); }}>
                    {networks.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <input className="input" style={{ flex: 1 }} value={rpc} onChange={(e) => setRpc(e.target.value)} />
                  <button className="btn" onClick={() => update({ rpc })}>Use</button>
                </div>
              </label>
            )}
            {backend?.mode === "chain" && stale?.length > 0 && (
              <Callout icon="clock" kind="warn">
                <strong>{stale.length} price feed(s) are close to stale</strong> ({stale.map((f) => f.label).join(", ")}). Decisions revert on a stale feed.
                {stale.some((f) => f.mock) && (
                  <div style={{ marginTop: 8 }}>
                    <button className="btn btn-sm" disabled={!!busy} onClick={() => run("refresh", () => backend.refreshFeeds(), { ok: "Feeds refreshed" })}>
                      <Icon name="refresh" />Refresh the demo feeds (signed by you)
                    </button>
                  </div>
                )}
              </Callout>
            )}
            {backend?.mode === "sim" && (
              <button className="btn" onClick={() => { backend.reset(); update({}); toast({ kind: "good", title: "Simulation reset" }); setTimeout(() => window.location.reload(), 300); }}>
                <Icon name="reset" />Reset the simulation
              </button>
            )}
            <Callout icon="cpu">
              <strong>Run it on-chain:</strong> <span className="mono">npx hardhat node</span>, then{" "}
              <span className="mono">npx hardhat run scripts/deploy.js --network localhost</span>, then in <span className="mono">off-chain/</span>{" "}
              <span className="mono">uvicorn main:app --port 8000</span>. This page connects automatically (set <span className="mono">TRUSTTIER_CORS</span> to this site's origin when it is hosted).
            </Callout>
          </div>
        </Card>
        <Card title="Deployment" sub={ov ? `verifier: ${ov.verifier_mode}` : ""}>
          <dl className="kv">
            <dt>Model hash</dt><dd className="mono" title={ov?.model_hash || MODEL_HASH}>{short(ov?.model_hash || MODEL_HASH, 10)}</dd>
            {Object.entries(dep?.contracts || {}).map(([k, v]) => (
              <Fragment key={k}><dt>{k}</dt><dd className="mono" title={v}>
                {explorerAddress(chainId, v) ? <a href={explorerAddress(chainId, v)} target="_blank" rel="noreferrer">{short(v, 8)}</a> : short(v, 8)}
              </dd></Fragment>
            ))}
            {dep?.deployedAt && <><dt>Deployed</dt><dd>{dep.deployedAt.slice(0, 10)} · block {dep.deployBlock}</dd></>}
            {ov && <><dt>Challenge window</dt><dd>{ov.protocol.challenge_window_s / 60} min</dd></>}
            {ov && <><dt>Approval TTL</dt><dd>{ov.protocol.approval_ttl_s / 60} min</dd></>}
            {ov && <><dt>Anchor TTL</dt><dd>{ov.protocol.anchor_ttl_s / 60} min</dd></>}
          </dl>
          {backend?.mode === "sim" && <div className="small muted" style={{ marginTop: 10 }}>In simulation there are no contract addresses; the rules are the same.</div>}
        </Card>
      </div>

      {!MANIFESTS.sepolia && (
        <Card title="Deploy to Ethereum (Sepolia)" sub="One click from GitHub Actions">
          <ol className="small ink2" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
            <li>Create a testnet-only key and fund it with ~0.2 Sepolia ETH from a faucet. You can generate one with <b>Sign in → Create account</b> here and download its keystore.</li>
            <li>In the repository: Settings → Secrets and variables → Actions, add <span className="mono">SEPOLIA_RPC_URL</span>, <span className="mono">PRIVATE_KEY</span> and (for Etherscan verification) <span className="mono">ETHERSCAN_API_KEY</span>.</li>
            <li>Actions → <b>Deploy to Sepolia</b> → Run workflow. It deploys, verifies on Etherscan, commits <span className="mono">deployments/sepolia.json</span> and rebuilds this site, which then connects to Sepolia directly.</li>
          </ol>
        </Card>
      )}

      <Card title="What you still have to trust" sub="Everything else is checked by the contract">
        <div className="trust-list">
          {TRUST.map(([ic, t, d]) => (
            <div key={t} className="trust-item"><div className="ic"><Icon name={ic} /></div><div><h4>{t}</h4><p>{d}</p></div></div>
          ))}
        </div>
      </Card>

      <Card title="Contracts" sub="Solidity 0.8.24 · 126 Hardhat tests">
        <div className="grid g3" style={{ gap: 12 }}>
          {[
            ["LiquidationEngine", "On-chain features and δ, tier enforcement, bonded windows, reveals, commit-reveal challenges, anchors, approvals."],
            ["TrustTierLiquidator", "The consumer: liquidates only on an open Tier-2 approval, and consumes it."],
            ["Halo2Verifier", "EZKL-generated zk-SNARK verifier for the risk model's circuit (15.6 KB)."],
            ["ModelRegistry", "The model hashes governance has authorized."],
            ["TierAuditLog", "One decision record per position — no shared counters."],
            ["Multisig + Timelock", "M-of-N proposer of an OpenZeppelin TimelockController that owns every contract."],
          ].map(([n, d]) => (
            <div key={n} className="trust-item" style={{ gridTemplateColumns: "1fr" }}><div><h4 className="mono">{n}</h4><p>{d}</p></div></div>
          ))}
        </div>
      </Card>
    </>
  );
}
