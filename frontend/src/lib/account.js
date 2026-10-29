// Accounts generated in the browser.
//
// A new account is a random secp256k1 key with a BIP-39 recovery phrase
// (ethers Wallet.createRandom). It is stored only on this device, encrypted
// with the user's password as a standard Ethereum keystore (scrypt + AES,
// the format geth and MetaMask import). The private key never leaves the
// browser: the router only ever sees signatures and signed transactions.
import { HDNodeWallet, Wallet, getAddress, isHexString } from "ethers";

const KEY = "trusttier.keystores.v1";

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function savedAccounts() {
  return read();
}

export function generateAccount() {
  const w = Wallet.createRandom();
  return { wallet: w, address: w.address, phrase: w.mnemonic.phrase };
}

/** A wallet from a 0x private key or a 12/24-word recovery phrase. */
export function importAccount(secret) {
  const s = secret.trim();
  if (isHexString(s.startsWith("0x") ? s : `0x${s}`, 32)) return new Wallet(s.startsWith("0x") ? s : `0x${s}`);
  const words = s.split(/\s+/);
  if (words.length === 12 || words.length === 24) return HDNodeWallet.fromPhrase(words.join(" "));
  throw new Error("Enter a 32-byte private key (0x…) or a 12/24-word recovery phrase.");
}

export async function saveAccount(wallet, password, label, onProgress) {
  if (!password || password.length < 8) throw new Error("Use a password of at least 8 characters.");
  const json = await wallet.encrypt(password, onProgress);
  const list = read().filter((a) => a.address !== wallet.address);
  list.unshift({ address: getAddress(wallet.address), label: label || "My account", json, createdAt: Date.now() });
  if (!write(list)) throw new Error("This browser blocks local storage, so the account cannot be saved here.");
  return list[0];
}

export async function unlockAccount(address, password, onProgress) {
  const entry = read().find((a) => a.address === address);
  if (!entry) throw new Error("No saved account with that address on this device.");
  try {
    return await Wallet.fromEncryptedJson(entry.json, password, onProgress);
  } catch {
    throw new Error("Wrong password.");
  }
}

export function forgetAccount(address) {
  write(read().filter((a) => a.address !== address));
}

export function downloadKeystore(address) {
  const entry = read().find((a) => a.address === address);
  if (!entry) return;
  const blob = new Blob([entry.json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `trusttier-keystore-${address.slice(2, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Deterministic two-color avatar for an address. */
export function avatarColors(address = "") {
  const h = parseInt(address.slice(2, 8) || "0", 16);
  return [`hsl(${h % 360} 70% 55%)`, `hsl(${(h >> 9) % 360} 70% 45%)`];
}

export function explorerTx(chainId, hash) {
  if (!hash) return null;
  hash = hash.startsWith("0x") ? hash : `0x${hash}`;
  if (chainId === 11155111) return `https://sepolia.etherscan.io/tx/${hash}`;
  if (chainId === 1) return `https://etherscan.io/tx/${hash}`;
  return null;
}

export function explorerAddress(chainId, address) {
  if (chainId === 11155111) return `https://sepolia.etherscan.io/address/${address}`;
  if (chainId === 1) return `https://etherscan.io/address/${address}`;
  return null;
}
