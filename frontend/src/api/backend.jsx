// Chooses the backend the app talks to and shares it through context:
//   live - the off-chain router + a real chain (local Hardhat node or Sepolia)
//   sim  - the in-browser simulation (src/sim/engine.js), used automatically
//          when no router answers, e.g. on the hosted GitHub Pages site.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { LiveBackend } from "./live";
import { SimEngine } from "../sim/engine";

const KEY = "trusttier.backend";
const DEFAULT_URL = import.meta.env.VITE_ROUTER_URL || (import.meta.env.DEV ? "/api" : "http://127.0.0.1:8000");

function readPref() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

function writePref(p) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

const Ctx = createContext(null);

export function BackendProvider({ children }) {
  const [pref, setPref] = useState(() => ({ mode: "auto", url: DEFAULT_URL, ...readPref() }));
  const [backend, setBackend] = useState(null);
  const [status, setStatus] = useState("connecting");
  const [version, setVersion] = useState(0); // bump to make views refetch

  useEffect(() => {
    let cancelled = false;
    async function pick() {
      setStatus("connecting");
      if (pref.mode !== "sim") {
        const live = new LiveBackend(pref.url);
        try {
          await live.health();
          if (!cancelled) {
            setBackend(live);
            setStatus("live");
          }
          return;
        } catch {
          if (pref.mode === "live" && !cancelled) {
            setBackend(null);
            setStatus("unreachable");
            return;
          }
        }
      }
      if (!cancelled) {
        setBackend(new SimEngine());
        setStatus("sim");
      }
    }
    pick();
    return () => {
      cancelled = true;
    };
  }, [pref.mode, pref.url]);

  const update = useCallback((next) => {
    setPref((p) => {
      const merged = { ...p, ...next };
      writePref(merged);
      return merged;
    });
  }, []);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const value = useMemo(() => ({ backend, status, pref, update, version, refresh }), [backend, status, pref, update, version, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBackend() {
  return useContext(Ctx);
}

/** Fetch `fn(backend)` and refetch whenever the backend changes, `refresh()`
 *  is called, or every `poll` ms. */
export function useData(fn, deps = [], { poll = 0 } = {}) {
  const { backend, version } = useBackend();
  const [state, setState] = useState({ data: null, error: null, loading: true });
  useEffect(() => {
    if (!backend) return undefined;
    let cancelled = false;
    async function load() {
      try {
        const data = await fn(backend);
        if (!cancelled) setState({ data, error: null, loading: false });
      } catch (e) {
        if (!cancelled) setState((s) => ({ data: s.data, error: e.message, loading: false }));
      }
    }
    load();
    const t = poll ? setInterval(load, poll) : null;
    return () => {
      cancelled = true;
      if (t) clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, version, ...deps]);
  return state;
}
