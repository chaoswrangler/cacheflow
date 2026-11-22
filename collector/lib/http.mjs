// Polite HTTP: one request at a time per host, randomized gaps, bounded backoff on 429/5xx/timeouts,
// honors Retry-After, never retries 403/404 (an access failure is recorded, not hammered).
import https from 'node:https';
import http from 'node:http';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Node's native http(s).request, as an alternative transport for hosts whose rule sets transport: "node".
   Same request, same honest user agent and headers as fetch(); it only uses Node's built-in client instead of
   undici. Returns a minimal Response-like object (status, ok, statusText, headers.get, text). */
export function nodeRequest(url, { method = 'GET', headers = {}, body, signal } = {}, redirects = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), mod = u.protocol === 'http:' ? http : https;
    const h = { 'accept-encoding': 'gzip, deflate, br', ...headers };
    if (body != null && !Object.keys(h).some(k => k.toLowerCase() === 'content-length')) h['content-length'] = Buffer.byteLength(body);
    const req = mod.request(u, { method, headers: h }, res => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc && redirects > 0) {
        res.resume();
        const next = new URL(loc, u).toString(), m = res.statusCode === 303 ? 'GET' : method;
        return resolve(nodeRequest(next, { method: m, headers, body: m === 'GET' ? undefined : body, signal }, redirects - 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        try {
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          if (enc === 'gzip') buf = gunzipSync(buf); else if (enc === 'br') buf = brotliDecompressSync(buf); else if (enc === 'deflate') buf = inflateSync(buf);
        } catch { /* keep the raw body */ }
        const hdr = res.headers;
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, statusText: res.statusMessage || '',
          headers: { get: k => { const v = hdr[String(k).toLowerCase()]; return v == null ? null : Array.isArray(v) ? v.join(', ') : String(v); } },
          text: async () => buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (signal) { if (signal.aborted) req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); }
    if (body != null) req.write(body);
    req.end();
  });
}

// What a refusal (403/429) actually said, so the cause can be told apart: an explicit quota (Retry-After, RateLimit-*),
// a bot-management challenge (HTML challenge page, cf-mitigated, Akamai reference), or a plain denial. The body is
// untrusted: only its type and a short tag-stripped excerpt are kept, never interpreted.
const REFUSAL_HEADERS = /^(retry-after|ratelimit|x-ratelimit|x-rate-limit|x-ms-request-id|x-request-id|request-id|x-correlation-id|x-ms-correlation|x-azure-ref|x-cache|cf-ray|cf-mitigated|server|via|content-type|x-amzn-requestid|x-akamai|akamai|x-eightfold|x-envoy|x-frame-options)/i;
export async function refusalInfo(res) {
  const headers = {};
  try { res.headers.forEach((v, k) => { if (REFUSAL_HEADERS.test(k)) headers[k.toLowerCase()] = String(v).slice(0, 160); }); } catch { /* headers not iterable */ }
  let body = '';
  try { body = (await res.text()).slice(0, 4000); } catch { /* body unreadable */ }
  const ct = headers['content-type'] || '';
  const kind = !body.trim() ? 'empty'
    : /json/i.test(ct) || /^\s*[{[]/.test(body) ? 'json'
    : /captcha|challenge|cf-chl|akamai|reference #|access denied|bot|are you a robot|incapsula|perimeterx|_abck/i.test(body) ? 'html_challenge_or_denial'
    : /<html|<!doctype/i.test(body) ? 'html' : 'text';
  const excerpt = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  return { headers, body_kind: kind, excerpt };
}
export class Http {
  constructor({ minDelay = 700, maxDelay = 1800, concurrency = 6, timeoutMs = 25000, retries = 3, userAgent, fetchImpl, log = () => {}, hostRules = [] } = {}) {
    Object.assign(this, { minDelay, maxDelay, concurrency, timeoutMs, retries, userAgent, log, hostRules });
    this.fetch = fetchImpl || globalThis.fetch;
    this.mocked = !!fetchImpl; // tests pass their own fetch; transports apply only to real network calls
    this.hostChains = new Map();
    this.active = 0; this.waiters = [];
    this.stats = { requests: 0, retries: 0, byStatus: {}, challenges: 0, transport: {} };
    this.challenged = new Map(); // queue key -> { at, status, mitigated }: a bot check was served; skip the rest of that queue this run
  }
  async slot() {
    if (this.active < this.concurrency) { this.active++; return; }
    await new Promise(r => this.waiters.push(r)); this.active++;
  }
  release() { this.active--; const w = this.waiters.shift(); if (w) w(); }
  rule(host) {
    // per-host overrides, e.g. Workday tenants rate-limit hard, so they get slower pacing and more patient retries
    const r = this.hostRules.find(x => host.endsWith(x.suffix));
    return { minDelay: r?.minDelayMs ?? this.minDelay, maxDelay: r?.maxDelayMs ?? this.maxDelay, retries: r?.retries ?? this.retries, backoffMs: r?.backoffMs ?? 2000, maxRetryAfterMs: r?.maxRetryAfterMs ?? 60000, group: r?.group || null, transport: r?.transport || 'fetch' };
  }
  // Requests queue per host. Hosts in a shared group (e.g. every Workday board, which sits on the same Workday
  // servers and is rate-limited as one) share a single queue: one request at a time across the whole group.
  perHost(host, fn) {
    const R = this.rule(host);
    host = R.group ? 'group:' + R.group : host;
    const prev = this.hostChains.get(host) || Promise.resolve();
    const next = prev.then(async () => {
      const out = await fn();
      await sleep(R.minDelay + Math.random() * (R.maxDelay - R.minDelay));
      return out;
    }, async () => fn());
    this.hostChains.set(host, next.catch(() => {}));
    return next;
  }
  async request(url, { method = 'GET', headers = {}, body, as = 'json' } = {}) {
    const host = new URL(url).host;
    const R = this.rule(host);
    const qkey = host; // challenges are tracked per site: one board's bot check doesn't stop the others
    return this.perHost(host, async () => {
      // A Cloudflare challenge (cf-mitigated) means the site's bot protection refused this client. It is an access
      // control, not a rate limit: no retries, and no further requests to that site (or site group) this run.
      const ch = this.challenged.get(qkey);
      if (ch) return { ok: false, status: ch.status, challenge: true, mitigated: ch.mitigated, skipped: true, attempts: 0 };
      await this.slot();
      try {
        for (let attempt = 0; ; attempt++) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
          let res, err;
          this.stats.requests++;
          try {
            const send = R.transport === 'node' && !this.mocked ? nodeRequest : this.fetch;
            this.stats.transport[R.transport] = (this.stats.transport[R.transport] || 0) + 1;
            res = await send(url, { method, body, signal: ctrl.signal,
              headers: { 'accept': as === 'json' ? 'application/json' : '*/*', 'user-agent': this.userAgent, ...headers } });
          } catch (e) { // fetch reports "fetch failed"; the real reason (DNS, refused, reset, TLS) is in e.cause
            const c = e.cause; const why = [c?.code, c?.reason || c?.message].filter(Boolean).join(' ');
            err = e.name === 'AbortError' ? 'timeout' : `network_error: ${e.message}${why ? ` (${why})` : ''}`; }
          finally { clearTimeout(timer); }
          const status = res?.status;
          if (status) this.stats.byStatus[status] = (this.stats.byStatus[status] || 0) + 1;
          const mitigated = res?.headers?.get?.('cf-mitigated');
          if (mitigated) {
            this.stats.challenges++; this.challenged.set(qkey, { at: new Date().toISOString(), status, mitigated });
            this.log(`bot check (cf-mitigated: ${mitigated}, HTTP ${status}) at ${host}; no retries, skipping the rest of ${host} this run`);
            return { ok: false, status, statusText: res.statusText, challenge: true, mitigated, retryAfter: res.headers.get('retry-after'), server: res.headers.get('server'), attempts: attempt + 1, refusal: await refusalInfo(res) };
          }
          const retryable = err || status === 429 || (status >= 500 && status <= 599);
          // Retry-After longer than the in-run limit: don't wait it out here and don't retry; report it so the
          // collector can schedule the source for after that time (next_eligible_at)
          const raH = res?.headers?.get?.('retry-after');
          const raMs = raH ? (isFinite(Number(raH)) ? Number(raH) * 1000 : Math.max(0, new Date(raH) - Date.now())) : null;
          if (status === 429 && raMs != null && raMs > (R.maxRetryAfterMs ?? 60000)) {
            this.stats.deferred = (this.stats.deferred || 0) + 1;
            this.log(`429 at ${host} asks for ${Math.round(raMs / 1000)}s; not retrying this run`);
            return { ok: false, status, statusText: res.statusText, retryAfter: raH, retryAfterMs: raMs, defer: true, server: res.headers?.get?.('server') || null, attempts: attempt + 1, refusal: await refusalInfo(res) };
          }
          if (retryable && attempt < R.retries) {
            let wait = Math.min(60000, R.backoffMs * 2 ** attempt + Math.random() * 1000);
            if (raMs != null) wait = raMs;
            this.stats.retries++; this.log(`retry ${attempt + 1} ${url} (${err || status}) in ${Math.round(wait)}ms`);
            // give up the shared request slot while waiting, so one throttled site can't hold up the others
            this.release(); try { await sleep(wait); } finally { await this.slot(); }
            continue;
          }
          if (err) return { ok: false, status: null, error: err.startsWith('timeout') ? 'timeout' : 'network_error', detail: err, attempts: attempt + 1 };
          if (!res.ok) return { ok: false, status, statusText: res.statusText, retryAfter: res.headers?.get?.('retry-after') || null, server: res.headers?.get?.('server') || null, attempts: attempt + 1,
            refusal: [403, 429].includes(status) ? await refusalInfo(res) : undefined };
          const text = await res.text();
          if (as === 'text') return { ok: true, status, data: text, attempts: attempt + 1 };
          try { return { ok: true, status, data: JSON.parse(text), attempts: attempt + 1 }; }
          catch { return { ok: false, status, error: 'parse_error', detail: text.slice(0, 200), attempts: attempt + 1 }; }
        }
      } finally { this.release(); }
    });
  }
  challengeFor(url) { try { return this.challenged.get(new URL(url).host) || null; } catch { return null; } }
  json(url, opts = {}) { return this.request(url, { ...opts, as: 'json' }); }
  text(url, opts = {}) { return this.request(url, { ...opts, as: 'text' }); }
}
