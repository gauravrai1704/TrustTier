// Client for the off-chain router (off-chain/main.py). In development the
// Vite dev server proxies /api to it (vite.config.js); a deployed build can
// point at any router URL from the settings menu (the router's CORS list
// must include the site's origin - TRUSTTIER_CORS).
export class LiveBackend {
  constructor(base = "/api") {
    this.mode = "live";
    this.base = base.replace(/\/$/, "");
  }

  async _req(path, { method = "GET", body, timeout } = {}) {
    const ctrl = new AbortController();
    const timer = timeout ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Request failed: ${res.status}`);
      return data;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  health() { return this._req("/health", { timeout: 2000 }); }
  costModel() { return this._req("/cost-model"); }
  overview() { return this._req("/overview"); }
  markets() { return this._req("/markets"); }
  listPositions() { return this._req("/positions"); }
  getPosition(id) { return this._req(`/positions/${id}`); }
  events() { return this._req("/events"); }
  deployment() { return this._req("/deployment"); }
  openPosition(req) { return this._req("/positions/open", { method: "POST", body: req }); }
  evaluate(id, forceTier = null) {
    return this._req("/positions/evaluate", { method: "POST", body: { position_id: Number(id), force_tier: forceTier } });
  }
  challengeProof(id) { return this._req(`/positions/${id}/challenge-proof`, { method: "POST" }); }
  challenge(id) { return this._req(`/positions/${id}/challenge`, { method: "POST" }); }
  reclaim(id) { return this._req(`/positions/${id}/reclaim`, { method: "POST" }); }
  liquidate(id) { return this._req(`/positions/${id}/liquidate`, { method: "POST" }); }
  setPrice(market, price) { return this._req(`/markets/${market}/price`, { method: "POST", body: { price } }); }
  advance(seconds) { return this._req("/chain/advance", { method: "POST", body: { seconds } }); }
  simulate(n) { return this._req(`/simulate?n_positions=${n}`, { method: "POST" }); }
  authNonce(address) { return this._req(`/auth/nonce?address=${encodeURIComponent(address)}`); }
  authVerify(address, signature) { return this._req("/auth/verify", { method: "POST", body: { address, signature } }); }
}
