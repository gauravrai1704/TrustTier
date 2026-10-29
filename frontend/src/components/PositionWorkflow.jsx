import { useEffect, useState } from "react";
import { getPositionStatus } from "../api";

function formatCountdown(seconds) {
  if (seconds <= 0) return "closed";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

const STEPS = ["Routed", "Bond posted", "Challenge window", "Resolved"];

function currentStepIndex(status) {
  if (!status.finalized && !status.challenged) return 0;
  if (status.tier === "ZkProof") return 3; // no bond/challenge window needed - already ground truth
  if (status.challenged) return 3;
  if (status.seconds_until_deadline > 0) return 2;
  return 3; // window closed, unchallenged - resolved (reclaimable)
}

export default function PositionWorkflow({ positionId }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (positionId == null) return;
    let cancelled = false;

    async function load() {
      try {
        const data = await getPositionStatus(positionId);
        if (!cancelled) {
          setStatus(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    }

    load();
    const id = setInterval(load, 5000);
    const tickId = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
      clearInterval(tickId);
    };
  }, [positionId]);

  if (positionId == null) {
    return <div className="panel-note">Select a position from the audit trail to see its workflow.</div>;
  }
  if (error) return <div className="error-text">{error}</div>;
  if (!status) return <div className="panel-note">Loading position {positionId}…</div>;
  if (!status.finalized && status.challenged)
    return (
      <div className="panel-note">
        Position {positionId}: the {status.tier} claim was <strong>challenged and its bond slashed</strong>. The position
        is re-opened — the same proof can now liquidate it at Tier 2 while its on-chain features are unchanged.
      </div>
    );
  if (!status.finalized) return <div className="panel-note">Position {positionId} has no decision yet.</div>;

  const liveSecondsLeft = Math.max(0, status.seconds_until_deadline - tick);
  const step = currentStepIndex(status);

  return (
    <div className="workflow">
      <div className="workflow-steps">
        {STEPS.map((label, i) => (
          <div key={label} className={`workflow-step ${i <= step ? "done" : ""} ${i === step ? "active" : ""}`}>
            <div className="workflow-dot">{i + 1}</div>
            <div className="workflow-label">{label}</div>
          </div>
        ))}
      </div>

      <div className="workflow-details">
        <div>
          Tier: <strong>{status.tier}</strong>
        </div>
        {status.tier !== "ZkProof" && (
          <>
            <div>
              Bond: <strong>{(Number(status.bond_wei) / 1e18).toFixed(4)} ETH</strong>{" "}
              {Number(status.bond_wei) === 0 && !status.challenged && "(reclaimed or none posted)"}
            </div>
            <div>
              Status:{" "}
              {status.challenged ? (
                <strong className="tone-critical-text">CHALLENGED — bond slashed</strong>
              ) : liveSecondsLeft > 0 ? (
                <>
                  challenge window open — <strong>{formatCountdown(liveSecondsLeft)}</strong> remaining
                </>
              ) : (
                <strong>window closed — unchallenged, bond reclaimable</strong>
              )}
            </div>
          </>
        )}
        {status.tier === "ZkProof" && (
          <div>
            <strong>No bond needed</strong> — Tier 2 is verified synchronously (already ground truth).
          </div>
        )}
      </div>
    </div>
  );
}
