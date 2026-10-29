import { useState } from "react";
import { connectWallet, hasInjectedWallet, signSiweMessage } from "../wallet";
import { authNonce, authVerify } from "../api";

function short(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function WalletConnect({ onAuthenticated, onWallet }) {
  const [state, setState] = useState("disconnected"); // disconnected | connecting | signing | authenticated | error
  const [address, setAddress] = useState(null);
  const [error, setError] = useState(null);

  async function handleConnect() {
    setError(null);
    setState("connecting");
    try {
      const wallet = await connectWallet();
      onWallet?.(wallet);
      setAddress(wallet.address);

      setState("signing");
      const { message } = await authNonce(wallet.address);
      const signature = await signSiweMessage(wallet.signer, message);
      const result = await authVerify(wallet.address, signature);

      setState("authenticated");
      onAuthenticated?.({ address: result.address, sessionToken: result.session_token, wallet });
    } catch (e) {
      setError(e.message);
      setState("error");
    }
  }

  if (!hasInjectedWallet()) {
    return (
      <div className="wallet-badge wallet-missing">
        No wallet detected — install MetaMask to connect and interact on-chain.
      </div>
    );
  }

  if (state === "authenticated") {
    return (
      <div className="wallet-badge wallet-connected">
        <span className="dot live" />
        Signed in as <strong>{short(address)}</strong>
        <span className="wallet-subtext">verified by wallet signature (SIWE)</span>
      </div>
    );
  }

  return (
    <div className="wallet-connect">
      <button className="btn btn-primary" onClick={handleConnect} disabled={state === "connecting" || state === "signing"}>
        {state === "connecting" && "Connecting…"}
        {state === "signing" && "Sign the message in your wallet…"}
        {(state === "disconnected" || state === "error") && "Connect Wallet"}
      </button>
      {error && <div className="error-text wallet-error">{error}</div>}
    </div>
  );
}
