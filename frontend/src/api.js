// Thin fetch wrapper around the off-chain router's HTTP API
// (off-chain/main.py). All requests go through Vite's /api proxy - see
// vite.config.js - so the frontend never needs a hardcoded backend origin
// or CORS configuration beyond what off-chain/main.py already sets up.

const BASE = "/api";

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export function checkHealth() {
  return request("/health");
}

export function runSimulation(nPositions) {
  return request(`/simulate?n_positions=${nPositions}`, { method: "POST" });
}

export function getMarkets() {
  return request("/markets");
}

export function setMarketPrice(market, price) {
  return request(`/markets/${market}/price`, { method: "POST", body: JSON.stringify({ price }) });
}

// Demo: open a MockLendingPool position. Returns the engine's own view of it.
export function openPosition({ market, ltv, accountAgeDays, topupDays }) {
  return request("/positions/open", {
    method: "POST",
    body: JSON.stringify({
      market, ltv, account_age_days: accountAgeDays, time_since_last_topup_days: topupDays,
    }),
  });
}

export function getPositionFeatures(positionId) {
  return request(`/positions/${positionId}/features`);
}

// The router reads features and delta from the chain; the request carries only the ID.
export function evaluatePosition(positionId, forceTier = null) {
  return request("/positions/evaluate", {
    method: "POST",
    body: JSON.stringify({ position_id: positionId, force_tier: forceTier }),
  });
}

// Watcher service: a Tier-2 proof on the features the position's Tier 0/1
// claim snapshotted on-chain (~16 s against the real verifier). Returned
// unsigned - the user submits challengeDecision from their own wallet.
export function getChallengeProof(positionId) {
  return request(`/positions/${positionId}/challenge-proof`, { method: "POST", body: "{}" });
}

export function getDeployment() {
  return request("/deployment");
}

export function getEvents(fromBlock = 0) {
  return request(`/events?from_block=${fromBlock}`);
}

export function getPositionStatus(positionId) {
  return request(`/positions/${positionId}/status`);
}

export function authNonce(address) {
  return request(`/auth/nonce?address=${address}`);
}

export function authVerify(address, signature) {
  return request("/auth/verify", {
    method: "POST",
    body: JSON.stringify({ address, signature }),
  });
}
