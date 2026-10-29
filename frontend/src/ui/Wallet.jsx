// Accounts: generated in the browser, imported, or a browser wallet
// (MetaMask). Whichever it is, the account signs in with Ethereum (SIWE) and
// then signs its own transactions; the router never holds the key.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { JsonRpcProvider, formatEther } from "ethers";
import Icon from "./Icon";
import { Callout, useToast } from "./kit";
import { useBackend } from "../api/backend";
import { connectWallet, engineContract, hasInjectedWallet, onWalletChange } from "../wallet";
import { avatarColors, downloadKeystore, explorerAddress, forgetAccount, generateAccount, importAccount, saveAccount, savedAccounts, unlockAccount } from "../lib/account";
import { go } from "../lib/router";
import { eth, short } from "../lib/format";

const Ctx = createContext({});

export function Avatar({ address, size = 22 }) {
  const [a, b] = avatarColors(address);
  return <span aria-hidden="true" style={{ width: size, height: size, borderRadius: "50%", flex: "none", display: "inline-block",
    background: `conic-gradient(from 120deg, ${a}, ${b}, ${a})`, boxShadow: "inset 0 0 0 2px var(--surface)" }} />;
}

export function WalletProvider({ children }) {
  const { backend, refresh } = useBackend();
  const toast = useToast();
  const [state, setState] = useState(null);       // { kind, address, signer, chainId, label }
  const [session, setSession] = useState(null);   // { session_token, address, user }
  const [deployment, setDeployment] = useState(null);
  const [modal, setModal] = useState(false);

  useEffect(() => {
    setDeployment(null);
    setState(null);
    setSession(null);
    if (backend?.mode === "live" || backend?.mode === "chain") backend.deployment().then(setDeployment).catch(() => {});
  }, [backend]);

  useEffect(() => onWalletChange(() => {
    setState((s) => (s?.kind === "injected" ? null : s));
  }), []);

  // Tell the backend who is acting: the router logs actions against the
  // session; the simulation attributes its events to the address.
  useEffect(() => {
    if (!backend) return;
    if (backend.mode === "live") backend.session = session?.session_token || null;
    else backend.actor = session?.address || null;
    if (backend.mode === "chain") backend.signer = session ? state?.signer || null : null;
  }, [backend, session, state]);

  const signIn = useCallback(async (acct) => {
    const { message } = await backend.authNonce(acct.address);
    const signature = await acct.signer.signMessage(message);
    const s = await backend.authVerify(acct.address, signature);
    setState(acct);
    setSession(s);
    refresh();
    return s;
  }, [backend, refresh]);

  /** Use a wallet object (generated, unlocked or imported) as the account. */
  const signInWithWallet = useCallback(async (wallet, label) => {
    let signer = wallet;
    let chainId = null;
    if (backend.mode === "live" || backend.mode === "chain") {
      // No request cache: back-to-back transactions (commit, then reveal) must
      // each read a fresh nonce.
      const provider = new JsonRpcProvider(backend.rpcUrl, undefined, { cacheTimeout: -1 });
      chainId = Number((await provider.getNetwork()).chainId);
      signer = wallet.connect(provider);
    }
    const s = await signIn({ kind: "local", address: wallet.address, signer, chainId, label });
    toast({ kind: "good", title: "Signed in", text: `${short(wallet.address)} proved ownership with a signature. Nothing was spent.` });
    return s;
  }, [backend, signIn, toast]);

  const signInWithBrowserWallet = useCallback(async () => {
    if (backend.mode === "chain" && window.ethereum) {
      const want = `0x${Number(backend.manifest.chainId).toString(16)}`;
      try {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
      } catch {
        throw new Error(`Switch your browser wallet to ${backend.network} (chain ${backend.manifest.chainId}) and try again.`);
      }
    }
    const w = await connectWallet();
    await signIn({ kind: "injected", address: w.address, signer: w.signer, chainId: w.chainId, label: "Browser wallet" });
    toast({ kind: "good", title: "Signed in with your browser wallet" });
  }, [backend, signIn, toast]);

  const signOut = useCallback(async () => {
    try {
      await backend?.authLogout?.();
    } catch {
      /* ignore */
    }
    setState(null);
    setSession(null);
    refresh();
  }, [backend, refresh]);

  /** After a wallet-signed transaction: record it against the session. */
  const record = useCallback((action, positionId, receipt) => {
    backend?.recordAction?.({ action, position_id: positionId == null ? null : Number(positionId),
      tx_hash: receipt?.hash || receipt?.transactionHash || null, gas_used: receipt?.gasUsed != null ? Number(receipt.gasUsed) : null });
    refresh();
  }, [backend, refresh]);

  return (
    <Ctx.Provider value={{ state, session, deployment, signOut, signInWithWallet, signInWithBrowserWallet, record,
      openSignIn: () => setModal(true), connect: () => setModal(true) }}>
      {children}
      {modal && <SignInModal onClose={() => setModal(false)} />}
    </Ctx.Provider>
  );
}

export function useWallet() {
  return useContext(Ctx);
}

// ---------------------------------------------------------------------------

function Progress({ value, label }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="small ink2">{label} {Math.round((value || 0) * 100)}%</div>
      <div className="proving-bar"><span style={{ width: `${(value || 0) * 100}%`, animation: "none", transform: "none" }} /></div>
    </div>
  );
}

function SignInModal({ onClose }) {
  const { backend } = useBackend();
  const w = useWallet();
  const saved = savedAccounts();
  const [tab, setTab] = useState(saved.length ? "unlock" : "create");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);

  // create
  const [fresh, setFresh] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [backedUp, setBackedUp] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  // unlock
  const [pick, setPick] = useState(saved[0]?.address || "");
  // import
  const [secret, setSecret] = useState("");

  useEffect(() => {
    const fn = (e) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [busy, onClose]);

  async function run(fn) {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      onClose();
    } catch (e) {
      setErr(e.shortMessage || e.message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const create = () => run(async () => {
    if (pw !== pw2) throw new Error("The passwords do not match.");
    await saveAccount(fresh.wallet, pw, "TrustTier account", (p) => setProgress(p));
    await w.signInWithWallet(fresh.wallet, "TrustTier account");
  });
  const unlock = () => run(async () => {
    const wallet = await unlockAccount(pick, pw, (p) => setProgress(p));
    await w.signInWithWallet(wallet, saved.find((a) => a.address === pick)?.label);
  });
  const doImport = () => run(async () => {
    const wallet = importAccount(secret);
    await saveAccount(wallet, pw, "Imported account", (p) => setProgress(p));
    await w.signInWithWallet(wallet, "Imported account");
  });

  const pwFields = (confirm) => (
    <>
      <label className="field">Password (encrypts the key on this device)
        <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" placeholder="at least 8 characters" />
      </label>
      {confirm && (
        <label className="field">Confirm password
          <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
        </label>
      )}
    </>
  );

  return (
    <>
      <div className="scrim" onClick={() => !busy && onClose()} />
      <div className="modal" role="dialog" aria-modal="true" aria-label="Sign in">
        <div className="modal-head">
          <div>
            <h3>Sign in with Ethereum</h3>
            <div className="small muted">Your key is created and encrypted in this browser. Only signatures leave it.</div>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} disabled={busy} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="seg" style={{ alignSelf: "flex-start" }}>
          {[["create", "Create account"], ["unlock", `Unlock${saved.length ? ` (${saved.length})` : ""}`], ["import", "Import"], ["injected", "Browser wallet"]].map(([k, l]) => (
            <button key={k} className={tab === k ? "on" : ""} onClick={() => { setTab(k); setErr(null); }} disabled={busy}>{l}</button>
          ))}
        </div>

        {tab === "create" && (
          <div className="stack">
            {!fresh ? (
              <>
                <p className="ink2 small">Generates a new Ethereum account: a random private key and a 12-word recovery phrase. Anyone with the phrase controls the account, so write it down and keep it secret.</p>
                <button className="btn btn-primary" onClick={() => setFresh(generateAccount())}><Icon name="key" />Generate a new account</button>
              </>
            ) : (
              <>
                <div className="row"><Avatar address={fresh.address} size={30} /><div><div className="small muted">Your new address</div><div className="mono" style={{ wordBreak: "break-all" }}>{fresh.address}</div></div></div>
                <div className={`phrase ${revealed ? "" : "hidden"}`} onClick={() => setRevealed(true)}>
                  {fresh.phrase.split(" ").map((word, i) => <span key={i}><i>{i + 1}</i>{word}</span>)}
                  {!revealed && <div className="phrase-cover"><Icon name="eye" />Click to reveal your recovery phrase</div>}
                </div>
                <div className="row-wrap">
                  <button className="btn btn-sm" disabled={!revealed} onClick={() => navigator.clipboard?.writeText(fresh.phrase)}><Icon name="doc" />Copy phrase</button>
                  <button className="btn btn-sm btn-ghost" onClick={() => { setFresh(generateAccount()); setRevealed(false); setBackedUp(false); }}><Icon name="refresh" />Generate another</button>
                </div>
                <label className="check"><input type="checkbox" checked={backedUp} onChange={(e) => setBackedUp(e.target.checked)} />I saved my recovery phrase somewhere safe</label>
                {pwFields(true)}
                <button className="btn btn-primary" disabled={!backedUp || busy} onClick={create}><Icon name="lock" />{busy ? "Encrypting…" : "Encrypt, save and sign in"}</button>
              </>
            )}
          </div>
        )}

        {tab === "unlock" && (
          <div className="stack">
            {!saved.length ? (
              <p className="small muted">No accounts are saved in this browser yet. Create or import one.</p>
            ) : (
              <>
                <div className="stack" style={{ gap: 6 }}>
                  {saved.map((a) => (
                    <label key={a.address} className={`acct-row ${pick === a.address ? "on" : ""}`}>
                      <input type="radio" name="acct" checked={pick === a.address} onChange={() => setPick(a.address)} />
                      <Avatar address={a.address} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{a.label}</div>
                        <div className="mono small muted">{short(a.address, 8)}</div>
                      </div>
                      <button className="btn btn-ghost btn-sm btn-icon" title="Download encrypted keystore" onClick={(e) => { e.preventDefault(); downloadKeystore(a.address); }}><Icon name="doc" /></button>
                    </label>
                  ))}
                </div>
                {pwFields(false)}
                <button className="btn btn-primary" disabled={busy || !pw} onClick={unlock}><Icon name="key" />{busy ? "Decrypting…" : "Unlock and sign in"}</button>
              </>
            )}
          </div>
        )}

        {tab === "import" && (
          <div className="stack">
            <label className="field">Private key or recovery phrase
              <textarea className="input" style={{ height: 76, padding: 10, resize: "vertical" }} value={secret} onChange={(e) => setSecret(e.target.value)}
                placeholder="0x… or twelve words" spellCheck={false} autoComplete="off" />
            </label>
            {pwFields(false)}
            <button className="btn btn-primary" disabled={busy || !secret || !pw} onClick={doImport}><Icon name="plus" />{busy ? "Encrypting…" : "Import and sign in"}</button>
            {backend?.mode === "live" && <div className="small muted">On a local Hardhat chain you can import one of its public test keys to act as a funded account.</div>}
          </div>
        )}

        {tab === "injected" && (
          <div className="stack">
            <p className="small ink2">Use MetaMask or another browser wallet. It keeps your key; TrustTier asks it for one sign-in signature, then for each transaction.</p>
            <button className="btn btn-primary" disabled={busy || !hasInjectedWallet()} onClick={() => run(w.signInWithBrowserWallet)}><Icon name="wallet" />Connect browser wallet</button>
            {!hasInjectedWallet() && <div className="small muted">No browser wallet found. Create an account instead — no extension needed.</div>}
          </div>
        )}

        {progress != null && <Progress value={progress} label={busy && tab === "unlock" ? "Decrypting keystore (scrypt)" : "Encrypting keystore (scrypt)"} />}
        {err && <Callout icon="alert" kind="crit">{err}</Callout>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

export function WalletButton() {
  const { backend, refresh } = useBackend();
  const w = useWallet();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState(null);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const addr = w.state?.address;

  useEffect(() => {
    const fn = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);

  const loadBalances = useCallback(async () => {
    if (!addr || !backend) return;
    try {
      if (backend.mode === "live" || backend.mode === "chain") {
        const provider = w.state.signer.provider;
        setBalance((await provider.getBalance(addr)).toString());
        if (w.deployment) setPending((await engineContract(provider, w.deployment).pendingWithdrawals(addr)).toString());
      } else {
        setBalance(await backend.balanceOf(addr));
        setPending(await backend.pendingOf(addr));
      }
    } catch {
      /* ignore */
    }
  }, [addr, backend, w.state, w.deployment]);

  useEffect(() => {
    loadBalances();
    const t = setInterval(loadBalances, 6000);
    return () => clearInterval(t);
  }, [loadBalances]);

  if (!w.state) {
    return (
      <button className="btn btn-primary" onClick={w.openSignIn}>
        <Icon name="key" /><span className="hide-sm">Sign in</span>
      </button>
    );
  }

  async function faucet() {
    setBusy(true);
    try {
      await backend.faucet(addr);
      toast({ kind: "good", title: "Funded with 10 test ETH" });
      loadBalances();
    } catch (e) {
      toast({ kind: "bad", title: "Faucet", text: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    setBusy(true);
    try {
      const r = await (await engineContract(w.state.signer, w.deployment).withdraw()).wait();
      w.record("withdraw", null, r);
      toast({ kind: "good", title: "Withdrawn", text: "Your bonds, rewards and slashed winnings are in your account." });
      loadBalances();
      refresh();
    } catch (e) {
      toast({ kind: "bad", title: "Withdraw failed", text: e.shortMessage || e.message });
    } finally {
      setBusy(false);
    }
  }

  const live = backend?.mode === "live" || backend?.mode === "chain";
  const local = backend?.mode === "live" && [31337, 1337].includes(w.state.chainId);
  const wrongChain = w.deployment?.chainId && w.state.chainId && w.state.chainId !== w.deployment.chainId;
  const explorer = explorerAddress(w.state.chainId, addr);
  return (
    <div className="pop-anchor" ref={ref}>
      <button className="btn" onClick={() => setOpen((o) => !o)}>
        <Avatar address={addr} />
        <span className="mono hide-sm">{short(addr, 4)}</span>
      </button>
      {open && (
        <div className="popover">
          <div className="row">
            <Avatar address={addr} size={34} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 650 }}>{w.state.label || "Account"}</div>
              <div className="mono small muted" style={{ wordBreak: "break-all" }}>{addr}</div>
            </div>
          </div>
          <div className="row-wrap">
            <span className="pill pill-good"><Icon name="check" />Signed in (SIWE)</span>
            <span className="pill">{w.state.kind === "local" ? "Key in this browser" : "Browser wallet"}</span>
            {wrongChain && <span className="pill pill-warn"><Icon name="alert" />wrong network</span>}
          </div>
          <dl className="kv">
            <dt>Balance</dt><dd>{balance == null ? "—" : `${Number(formatEther(balance)).toFixed(4)} ${live ? "ETH" : "sim ETH"}`}</dd>
            <dt>Owed to you</dt><dd>{pending == null ? "—" : eth(pending)}</dd>
          </dl>
          <div className="row-wrap">
            {(local || !live) && <button className="btn btn-sm" disabled={busy} onClick={faucet}><Icon name="coin" />Get 10 test ETH</button>}
            {live && pending && pending !== "0" && <button className="btn btn-sm" disabled={busy} onClick={withdraw}><Icon name="wallet" />Withdraw</button>}
            <button className="btn btn-sm" onClick={() => { go(`ledger/account/${addr}`); setOpen(false); }}><Icon name="doc" />My history</button>
            {explorer && <a className="btn btn-sm" href={explorer} target="_blank" rel="noreferrer"><Icon name="external" />Etherscan</a>}
          </div>
          {live && !local && <div className="small muted">Fund this address from a Sepolia faucet (Google Cloud, Alchemy or Infura) to send transactions.</div>}
          <div className="divider" />
          <div className="row-wrap">
            {w.state.kind === "local" && <button className="btn btn-sm btn-ghost" onClick={() => downloadKeystore(addr)}><Icon name="doc" />Keystore file</button>}
            <button className="btn btn-sm btn-ghost" onClick={() => { w.signOut(); setOpen(false); }}><Icon name="lock" />Sign out</button>
            {w.state.kind === "local" && (
              <button className="btn btn-sm btn-ghost" style={{ color: "var(--critical)" }}
                onClick={() => { if (window.confirm("Remove this account from this browser? Without its recovery phrase it cannot be restored.")) { forgetAccount(addr); w.signOut(); setOpen(false); } }}>
                <Icon name="x" />Forget on this device
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
