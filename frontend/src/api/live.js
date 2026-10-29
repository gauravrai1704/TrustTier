// Client for the off-chain router (off-chain/main.py). In development the
// Vite dev server proxies /api to it (vite.config.js); a deployed build can
// point at any router URL from the settings menu (the router's CORS list
// must include the site's origin - TRUSTTIER_CORS).
export class LiveBackend {
  constructor(base = "/api") {
    this.mode = "live";
    this.base = base.replace(/\/$/, "");
    this.session = null; // SIWE session token, sent as X-Session
  }

  /** Absolute URL of the router's JSON-RPC proxy (for in-browser wallets). */
  get rpcUrl() {
    return new URL(`${this.base}/rpc`, window.location.href).href;
  }

  url(path) {
    return new URL(`${this.base}${path}`, window.location.href).href;
  }

  async _req(path, { method = "GET", body, timeout } = {}) {
    const ctrl = new AbortController();
    const timer = timeout ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...(this.session ? { "X-Session": this.session } : {}) },
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
  authMe() { return this._req("/auth/me"); }
  authLogout() { return this._req("/auth/logout", { method: "POST" }); }
  faucet(address) { return this._req("/faucet", { method: "POST", body: { address } }); }
  currentProof(id) { return this._req(`/positions/${id}/proof`, { method: "POST" }); }
  recordAction(a) { return this._req("/actions", { method: "POST", body: a }).catch(() => null); }
  dbSummary() { return this._req("/db/summary"); }
  dbDeployments() { return this._req("/db/deployments"); }
  dbLeaderboard() { return this._req("/db/leaderboard"); }
  dbActions(limit = 50) { return this._req(`/db/actions?limit=${limit}`); }
  dbAccount(address) { return this._req(`/db/accounts/${address}`); }
  dbEvents(f = {}) {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== "" && v != null));
    return this._req(`/db/events?${q}`);
  }
  dbCsvUrl(f = {}) {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== "" && v != null));
    return this.url(`/db/events.csv?${q}`);
  }
}
