import { useState } from "react";
import { getChallengeProof } from "../api";
import { getEngineContract } from "../wallet";

// Real on-chain write actions, signed by the connected wallet directly
// against LiquidationEngine - not proxied through the backend. This is the
// interactive core of the DApp: a connected user can actually challenge a
// suspicious decision, reclaim their own bond, or withdraw funds they're
// owed, with MetaMask prompting them to confirm and pay gas themselves.
//
// The challenge proof: a challenge must carry a Tier-2 proof whose five
// feature inputs equal the features the contract SNAPSHOTTED when the claim
// was made (computed on-chain from the lending protocol and Chainlink feeds),
// and whose label is 1 (high risk). The backend's watcher endpoint builds
// that proof from the snapshot (a real EZKL proof against the real verifier,
// ~16 s); the DApp shows the
// proven label and only offers the challenge if it contradicts the claim.
// The proof is public data: the user still signs and pays for the
// challenge transaction from their own wallet.
export default function WalletActions({ wallet, deployment, positionId, status, onActionComplete }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [txHash, setTxHash] = useState(null);
  const [proof, setProof] = useState(null);
  const [proving, setProving] = useState(false);

  if (!wallet) {
    return <div className="panel-note">Connect your wallet to challenge decisions, reclaim bonds, or withdraw funds.</div>;
  }
  if (!deployment) {
    return <div className="panel-note">Loading contract info…</div>;
  }

  async function run(fn) {
    setBusy(true);
    setError(null);
    setTxHash(null);
    try {
      const contract = await getEngineContract(wallet.signer, deployment);
      const tx = await fn(contract);
      setTxHash(tx.hash);
      await tx.wait();
      onActionComplete?.();
    } catch (e) {
      setError(e.shortMessage || e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleGetProof() {
    setProving(true);
    setError(null);
    setProof(null);
    try {
      setProof(await getChallengeProof(positionId));
    } catch (e) {
      setError(e.message);
    } finally {
      setProving(false);
    }
  }

  async function handleChallenge() {
    const inputs = proof.public_inputs.map((x) => BigInt(x));
    await run((contract) => contract.challengeDecision(positionId, proof.model_hash, proof.proof, inputs));
  }

  async function handleReclaim() {
    await run((contract) => contract.reclaimBond(positionId));
  }

  async function handleWithdraw() {
    await run((contract) => contract.withdraw());
  }

  const challengeable = status?.challengeable;
  const reclaimable = status && status.tier !== "ZkProof" && !status.challenged && status.seconds_until_deadline === 0 && Number(status.bond_wei) > 0;

  return (
    <div className="wallet-actions">
      {challengeable && (
        <div className="action-row">
          <button className="btn" disabled={busy || proving} onClick={handleGetProof}>
            {proving ? "Proving… (~16 s)" : "Check this claim with a Tier-2 proof"}
          </button>
          {proof && (
            <div className="panel-note">
              Proof ({proof.proof_kind}, {proof.proving_seconds}s) says:{" "}
              <strong>{proof.high_risk ? "HIGH RISK — the cheap claim was false" : "low risk — the claim holds"}</strong>
            </div>
          )}
          {proof?.high_risk && (
            <button className="btn btn-danger" disabled={busy} onClick={handleChallenge}>
              Challenge and slash the bond
            </button>
          )}
        </div>
      )}
      {reclaimable && (
        <button className="btn" disabled={busy} onClick={handleReclaim}>
          Reclaim bond
        </button>
      )}
      <button className="btn" disabled={busy} onClick={handleWithdraw}>
        Withdraw my pending balance
      </button>
      {busy && <div className="panel-note">Confirm in your wallet…</div>}
      {txHash && (
        <div className="panel-note">
          Submitted: <code>{txHash.slice(0, 18)}…</code>
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
