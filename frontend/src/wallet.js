// Browser-wallet integration (MetaMask or any EIP-1193 injected provider).
//
// This is what makes TrustTier a real DApp rather than a dashboard: the
// connected wallet signs its own transactions (challengeDecision, withdraw,
// reclaimBond) directly against the deployed LiquidationEngine contract -
// the backend never holds the user's funds or submits transactions on
// their behalf for these actions. Authentication (see api.js's auth*
// functions) is Sign-In-With-Ethereum: the wallet's signature over a
// server-issued nonce IS the credential, same pattern real DApps use
// (Uniswap, OpenSea, etc.) - no password, no separate account system.

import { BrowserProvider, Contract } from "ethers";

export function hasInjectedWallet() {
  return typeof window !== "undefined" && !!window.ethereum;
}

export async function connectWallet() {
  if (!hasInjectedWallet()) {
    throw new Error("No wallet found. Install MetaMask (or another injected wallet) to continue.");
  }
  const provider = new BrowserProvider(window.ethereum);
  const accounts = await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const network = await provider.getNetwork();
  return { provider, signer, address: accounts[0], chainId: Number(network.chainId) };
}

export function onAccountsChanged(callback) {
  if (!hasInjectedWallet()) return () => {};
  window.ethereum.on("accountsChanged", callback);
  return () => window.ethereum.removeListener("accountsChanged", callback);
}

export function onChainChanged(callback) {
  if (!hasInjectedWallet()) return () => {};
  window.ethereum.on("chainChanged", callback);
  return () => window.ethereum.removeListener("chainChanged", callback);
}

export async function getEngineContract(signerOrProvider, deployment) {
  return new Contract(deployment.liquidationEngine.address, deployment.liquidationEngine.abi, signerOrProvider);
}

export async function signSiweMessage(signer, message) {
  return signer.signMessage(message);
}
