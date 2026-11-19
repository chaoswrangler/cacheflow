// Polite HTTP: one request at a time per host, randomized gaps, bounded backoff on 429/5xx/timeouts,
// honors Retry-After, never retries 403/404 (an access failure is recorded, not hammered).
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Http {
  constructor({ minDelay = 700, maxDelay = 1800, concurrency = 6, timeoutMs = 25000, retries = 3, userAgent, fetchImpl, log = () => {} } = {}) {
    Object.assign(this, { minDelay, maxDelay, concurrency, timeoutMs, retries, userAgent, log });
    this.fetch = fetchImpl || globalThis.fetch;
    this.hostChains = new Map();
    this.active = 0; this.waiters = [];
    this.stats = { requests: 0, retries: 0, byStatus: {} };
  }
  async slot() {
    if (this.active < this.concurrency) { this.active++; return; }
    await new Promise(r => this.waiters.push(r)); this.active++;
  }
  release() { this.active--; const w = this.waiters.shift(); if (w) w(); }
  perHost(host, fn) {
    const prev = this.hostChains.get(host) || Promise.resolve();
    const next = prev.then(async () => {
      const out = await fn();
      await sleep(this.minDelay + Math.random() * (this.maxDelay - this.minDelay));
      return out;
    }, async () => fn());
    this.hostChains.set(host, next.catch(() => {}));
    return next;
  }
  async request(url, { method = 'GET', headers = {}, body, as = 'json' } = {}) {
    const host = new URL(url).host;
    return this.perHost(host, async () => {
      await this.slot();
      try {
        for (let attempt = 0; ; attempt++) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
          let res, err;
          this.stats.requests++;
          try {
            res = await this.fetch(url, { method, body, signal: ctrl.signal,
              headers: { 'accept': as === 'json' ? 'application/json' : '*/*', 'user-agent': this.userAgent, ...headers } });
          } catch (e) { err = e.name === 'AbortError' ? 'timeout' : `network_error: ${e.message}`; }
          finally { clearTimeout(timer); }
          const status = res?.status;
          if (status) this.stats.byStatus[status] = (this.stats.byStatus[status] || 0) + 1;
          const retryable = err || status === 429 || (status >= 500 && status <= 599);
          if (retryable && attempt < this.retries) {
            let wait = Math.min(60000, 2000 * 2 ** attempt + Math.random() * 1000);
            const ra = res?.headers?.get?.('retry-after');
            if (ra) { const s = Number(ra); wait = Math.min(60000, isFinite(s) ? s * 1000 : Math.max(0, new Date(ra) - Date.now())); }
            this.stats.retries++; this.log(`retry ${attempt + 1} ${url} (${err || status}) in ${Math.round(wait)}ms`);
            await sleep(wait); continue;
          }
          if (err) return { ok: false, status: null, error: err.startsWith('timeout') ? 'timeout' : 'network_error', detail: err, attempts: attempt + 1 };
          if (!res.ok) return { ok: false, status, statusText: res.statusText, attempts: attempt + 1 };
          const text = await res.text();
          if (as === 'text') return { ok: true, status, data: text, attempts: attempt + 1 };
          try { return { ok: true, status, data: JSON.parse(text), attempts: attempt + 1 }; }
          catch { return { ok: false, status, error: 'parse_error', detail: text.slice(0, 200), attempts: attempt + 1 }; }
        }
      } finally { this.release(); }
    });
  }
  json(url, opts = {}) { return this.request(url, { ...opts, as: 'json' }); }
  text(url, opts = {}) { return this.request(url, { ...opts, as: 'text' }); }
}
