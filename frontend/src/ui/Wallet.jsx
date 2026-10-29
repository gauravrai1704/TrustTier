// Wallet state shared by the app: connection, SIWE sign-in, deployment info.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { useBackend } from "../api/backend";
import { useToast } from "./kit";
import { connectWallet, hasInjectedWallet, onWalletChange } from "../wallet";
import { short } from "../lib/format";

const Ctx = createContext({});

export function WalletProvider({ children }) {
  const { backend } = useBackend();
  const toast = useToast();
  const [state, setState] = useState(null);
  const [session, setSession] = useState(null);
  const [deployment, setDeployment] = useState(null);

  useEffect(() => {
    setDeployment(null);
    if (backend?.mode === "live") backend.deployment().then(setDeployment).catch(() => {});
  }, [backend]);

  useEffect(() => onWalletChange(() => {
    setState(null);
    setSession(null);
  }), []);

  const connect = useCallback(async () => {
    try {
      setState(await connectWallet());
    } catch (e) {
      toast({ kind: "bad", title: "Wallet", text: e.message });
    }
  }, [toast]);

  const signIn = useCallback(async () => {
    if (!state || backend?.mode !== "live") return;
    try {
      const { message } = await backend.authNonce(state.address);
      const signature = await state.signer.signMessage(message);
      setSession(await backend.authVerify(state.address, signature));
      toast({ kind: "good", title: "Signed in with Ethereum", text: "Your signature proved wallet ownership; nothing was spent." });
    } catch (e) {
      toast({ kind: "bad", title: "Sign-in failed", text: e.shortMessage || e.message });
    }
  }, [state, backend, toast]);

  return (
    <Ctx.Provider value={{ state, session, deployment, connect, signIn, disconnect: () => { setState(null); setSession(null); } }}>
      {children}
    </Ctx.Provider>
  );
}

export function useWallet() {
  return useContext(Ctx);
}

export function WalletButton() {
  const { backend } = useBackend();
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const fn = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);

  if (backend?.mode !== "live") return null;
  if (!w.state) {
    return (
      <button className="btn" onClick={w.connect} title={hasInjectedWallet() ? "" : "Install MetaMask to sign transactions yourself"}>
        <Icon name="wallet" /><span className="hide-sm">Connect wallet</span>
      </button>
    );
  }
  const wrongChain = w.deployment && w.deployment.chainId && w.state.chainId !== w.deployment.chainId;
  return (
    <div className="pop-anchor" ref={ref}>
      <button className="btn" onClick={() => setOpen((o) => !o)}>
        <span className="live-dot" style={wrongChain ? { background: "var(--warning)", animation: "none" } : undefined} />
        <span className="mono">{short(w.state.address, 4)}</span>
      </button>
      {open && (
        <div className="popover">
          <div className="small muted">Connected wallet</div>
          <div className="mono" style={{ wordBreak: "break-all" }}>{w.state.address}</div>
          <div className="small">
            Chain {w.state.chainId}
            {wrongChain && <span className="pill pill-warn" style={{ marginLeft: 8 }}><Icon name="alert" />router is on {w.deployment.chainId}</span>}
          </div>
          {w.session ? (
            <span className="pill pill-good"><Icon name="check" />Signed in (SIWE)</span>
          ) : (
            <button className="btn btn-block" onClick={w.signIn}><Icon name="key" />Sign in with Ethereum</button>
          )}
          <div className="small ink2">Challenges, bond settlements and liquidations you trigger are now signed and paid by this wallet.</div>
          <button className="btn btn-ghost btn-block" onClick={w.disconnect}>Disconnect</button>
        </div>
      )}
    </div>
  );
}
