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

export function evaluatePosition(positionId, features) {
  return request("/positions/evaluate", {
    method: "POST",
    body: JSON.stringify({ position_id: positionId, features }),
  });
}
