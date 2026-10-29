import { useEffect, useRef, useState } from "react";
import { getEvents } from "../api";

const POLL_MS = 4000;

const EVENT_META = {
  DecisionLogged: { icon: "◈", label: (e) => `Position ${e.positionId} decided — Tier ${e.tier}`, tone: "info" },
  DecisionChallenged: {
    icon: "⚠",
    label: (e) => `Position ${e.positionId} CHALLENGED — bond slashed to ${short(e.challenger)}`,
    tone: "critical",
  },
  BondReclaimed: { icon: "✓", label: (e) => `Position ${e.positionId} bond reclaimed by ${short(e.claimant)}`, tone: "ok" },
  Withdrawn: { icon: "↗", label: (e) => `${short(e.account)} withdrew ${weiToEth(e.amount)} ETH`, tone: "ok" },
};

function short(address) {
  if (!address) return "?";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function weiToEth(wei) {
  return (Number(BigInt(wei)) / 1e18).toFixed(4);
}

export default function EventFeed() {
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const seenKeys = useRef(new Set());

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const data = await getEvents(0);
        if (cancelled) return;
        setError(null);
        const fresh = data.events.filter((e) => {
          const key = `${e.txHash}-${e.type}`;
          if (seenKeys.current.has(key)) return false;
          seenKeys.current.add(key);
          return true;
        });
        if (fresh.length > 0) {
          setEvents((prev) => [...fresh.reverse(), ...prev].slice(0, 50));
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="event-feed">
      {error && <div className="error-text">Live feed unreachable: {error}</div>}
      {events.length === 0 && !error && <div className="panel-note">Watching for on-chain activity…</div>}
      <ul className="event-list">
        {events.map((e, i) => {
          const meta = EVENT_META[e.type] || { icon: "•", label: () => e.type, tone: "info" };
          return (
            <li key={`${e.txHash}-${i}`} className={`event-row tone-${meta.tone}`}>
              <span className="event-icon">{meta.icon}</span>
              <span className="event-label">{meta.label(e)}</span>
              <a
                className="event-tx"
                href={`#`}
                title={e.txHash}
                onClick={(ev) => ev.preventDefault()}
              >
                {e.txHash.slice(0, 10)}…
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
