// Browser-wallet integration (MetaMask or any EIP-1193 injected provider).
//
// In live mode the connected wallet signs its own transactions against the
// deployed contracts - challenges (commit, then reveal), bond reclaims,
// withdrawals and liquidations - so the router never holds user funds.
// Sign-In-With-Ethereum authenticates the wallet to the router.
import { AbiCoder, BrowserProvider, Contract, keccak256 } from "ethers";

export function hasInjectedWallet() {
  return typeof window !== "undefined" && !!window.ethereum;
}

export async function connectWallet() {
  if (!hasInjectedWallet()) throw new Error("No wallet found. Install MetaMask to sign transactions yourself.");
  const provider = new BrowserProvider(window.ethereum);
  const accounts = await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const network = await provider.getNetwork();
  return { provider, signer, address: accounts[0], chainId: Number(network.chainId) };
}

export function onWalletChange(callback) {
  if (!hasInjectedWallet()) return () => {};
  window.ethereum.on("accountsChanged", callback);
  window.ethereum.on("chainChanged", callback);
  return () => {
    window.ethereum.removeListener("accountsChanged", callback);
    window.ethereum.removeListener("chainChanged", callback);
  };
}

export function engineContract(signer, deployment) {
  return new Contract(deployment.liquidationEngine.address, deployment.liquidationEngine.abi, signer);
}

export function liquidatorContract(signer, deployment) {
  if (!deployment.liquidator) throw new Error("This deployment has no TrustTierLiquidator.");
  return new Contract(deployment.liquidator.address, deployment.liquidator.abi, signer);
}

/** Commit-reveal challenge from the user's wallet: two transactions. */
export async function walletChallenge(signer, deployment, positionId, proof) {
  const engine = engineContract(signer, deployment);
  const snapshot = await engine.featureSnapshot(positionId);
  const me = await signer.getAddress();
  const commitment = keccak256(
    AbiCoder.defaultAbiCoder().encode(["address", "uint256", "bytes32", "bytes32"], [me, positionId, snapshot, keccak256(proof.proof)]),
  );
  await (await engine.commitChallenge(positionId, commitment)).wait();
  // Explicit gas: estimation simulates the commit's own block, where a reveal is invalid by design.
  const tx = await engine.revealChallenge(positionId, proof.model_hash, proof.proof, proof.public_inputs.map(BigInt), { gasLimit: 2_000_000 });
  return tx.wait();
}
