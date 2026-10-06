// src/index.js
var VERSION = "1.0.0";
var DEFAULT_PROVIDERS = [
  { name: "alidns", url: "https://dns.alidns.com/dns-query", jsonUrl: "https://dns.alidns.com/resolve", weight: 3, json: true },
  { name: "dnspod", url: "https://doh.pub/dns-query", weight: 3, json: true },
  { name: "cloudflare", url: "https://cloudflare-dns.com/dns-query", weight: 2, json: true },
  { name: "google", url: "https://dns.google/dns-query", jsonUrl: "https://dns.google/resolve", weight: 2, json: true }
];
var RCODE_SERVFAIL = 2;
var RCODE_REFUSED = 5;
var rrCounter = 0;
var health = /* @__PURE__ */ new Map();
function logAlert(...args) {
  try {
    const fn = typeof console !== "undefined" && (console.alert || console.log) || function() {
    };
    fn.apply(console, args);
  } catch (_) {
  }
}
function toInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function toBool(value, fallback) {
  if (value === void 0 || value === null || value === "") return fallback;
  const v = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}
function parseProviders(raw) {
  if (!raw) return DEFAULT_PROVIDERS.map((p) => ({ ...p }));
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (_) {
    logAlert("[doh] DOH_UPSTREAMS \u4E0D\u662F\u5408\u6CD5 JSON\uFF0C\u4F7F\u7528\u9ED8\u8BA4\u4E0A\u6E38");
    return DEFAULT_PROVIDERS.map((p) => ({ ...p }));
  }
  if (!Array.isArray(arr) || arr.length === 0) return DEFAULT_PROVIDERS.map((p) => ({ ...p }));
  const out = [];
  for (const item of arr) {
    const obj = typeof item === "string" ? { url: item } : item;
    if (!obj || typeof obj.url !== "string") continue;
    const url = obj.url.trim();
    if (!/^https:\/\//i.test(url)) continue;
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch (_) {
      continue;
    }
    out.push({
      name: obj.name || host,
      url,
      jsonUrl: typeof obj.jsonUrl === "string" && /^https:\/\//i.test(obj.jsonUrl) ? obj.jsonUrl : void 0,
      weight: Number(obj.weight) > 0 ? Number(obj.weight) : 1,
      json: obj.json !== false,
      wire: obj.wire !== false
    });
  }
  return out.length ? out : DEFAULT_PROVIDERS.map((p) => ({ ...p }));
}
function parseRcodes(raw, fallback) {
  if (raw === void 0 || raw === null || raw === "") return fallback.slice();
  const list = String(raw).split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0 && n <= 15);
  return list.length ? list : fallback.slice();
}
function readConfig(env2) {
  const e = env2 || {};
  const maxAttempts = toInt(e.DOH_MAX_ATTEMPTS, 3, 1, 4);
  return {
    providers: parseProviders(e.DOH_UPSTREAMS),
    strategy: String(e.DOH_STRATEGY || "hedge").toLowerCase(),
    maxAttempts,
    // 单个上游超时；对冲延迟(hedgeDelay)应明显小于它，才能提前并发下一个上游
    attemptTimeout: toInt(e.DOH_ATTEMPT_TIMEOUT_MS, 1200, 100, 8e3),
    // 对冲延迟：主上游无响应时，提前并发下一个上游
    hedgeDelay: toInt(e.DOH_HEDGE_DELAY_MS, 300, 0, 5e3),
    // 整次请求总预算：留足网关 10s 限制的余量
    totalTimeout: toInt(e.DOH_TOTAL_TIMEOUT_MS, 5e3, 500, 9e3),
    cooldown: toInt(e.DOH_COOLDOWN_MS, 3e4, 0, 6e5),
    cacheTtl: toInt(e.DOH_CACHE_TTL, 30, 0, 86400),
    cors: toBool(e.DOH_CORS, true),
    forwardEcs: toBool(e.DOH_FORWARD_ECS, false),
    retryRcodes: parseRcodes(e.DOH_RETRY_RCODES, [RCODE_SERVFAIL, RCODE_REFUSED]),
    retryTruncated: toBool(e.DOH_RETRY_TRUNCATED, true),
    retryEmpty: toBool(e.DOH_RETRY_EMPTY, false),
    debug: toBool(e.DOH_DEBUG, false)
  };
}
function weightedShuffle(list) {
  const keyed = list.map((p) => ({ p, k: Math.pow(Math.random(), 1 / Math.max(p.weight, 1e-4)) }));
  keyed.sort((a, b) => b.k - a.k);
  return keyed.map((x) => x.p);
}
function orderProviders(providers, cfg) {
  let list = providers.slice();
  const now = Date.now();
  const penalized = (p) => {
    const h = health.get(p.url);
    return h && cfg.cooldown > 0 && now - h.lastFailAt < cfg.cooldown ? 1 : 0;
  };
  if (cfg.strategy === "round-robin" || cfg.strategy === "rr") {
    const n = list.length;
    const start = n ? rrCounter++ % n : 0;
    list.push(...list.splice(0, start));
  } else if (cfg.strategy === "random") {
    list.sort(() => Math.random() - 0.5);
  } else {
    list = weightedShuffle(list);
  }
  list.sort((a, b) => penalized(a) - penalized(b));
  return list;
}
function markFailure(provider) {
  const h = health.get(provider.url) || { fails: 0, lastFailAt: 0 };
  h.fails += 1;
  h.lastFailAt = Date.now();
  health.set(provider.url, h);
}
function markSuccess(provider) {
  const h = health.get(provider.url);
  if (h) {
    h.fails = 0;
    h.lastFailAt = 0;
  }
}
function base64UrlDecode(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function base64UrlEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function parseClientRequest(request, cfg) {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return { error: { status: 405, message: "Method Not Allowed" } };
  }
  const url = new URL(request.url);
  const params = url.searchParams;
  const accept = request.headers.get("accept") || "";
  const hasDns = params.has("dns");
  const isJson = accept.includes("application/dns-json") || !hasDns && params.has("name");
  const ctx = {
    method,
    isJson,
    accept,
    params,
    dns: params.get("dns") || "",
    body: null,
    ecs: "",
    clientId: ""
  };
  if (isJson) {
    if (!params.has("name")) {
      return { error: { status: 400, message: "missing ?name= (JSON DoH)" } };
    }
  } else if (method === "GET") {
    if (!ctx.dns) {
      return { error: { status: 400, message: "missing ?dns= (RFC 8484)" } };
    }
    try {
      base64UrlDecode(ctx.dns);
    } catch (_) {
      return { error: { status: 400, message: "invalid base64url ?dns=" } };
    }
  } else {
    const ct = request.headers.get("content-type") || "";
    if (ct && !ct.includes("application/dns-message") && !ct.includes("application/octet-stream")) {
      return { error: { status: 415, message: "unsupported content-type: " + ct } };
    }
    const buf = await request.arrayBuffer();
    if (!buf || buf.byteLength < 12 || buf.byteLength > 65535) {
      return { error: { status: 400, message: "invalid DNS message body" } };
    }
    ctx.body = buf;
  }
  if (cfg.forwardEcs && !params.has("edns_client_subnet") && !isJson) {
    const fwd = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "";
    const ip = fwd.split(",")[0].trim();
    if (ip && /^[0-9a-fA-F:.]+$/.test(ip)) ctx.ecs = ip;
  }
  const cid = request.headers.get("dns-id") || (params.get("dns") || params.get("name") || "");
  ctx.clientId = cid;
  return { ctx };
}
function buildUpstreamUrl(provider, ctx) {
  const base = ctx.isJson && provider.jsonUrl ? provider.jsonUrl : provider.url;
  const u = new URL(base);
  const qs = u.searchParams;
  if (ctx.method === "GET") {
    if (ctx.isJson) {
      for (const [k, v] of ctx.params) qs.set(k, v);
    } else {
      qs.set("dns", ctx.dns);
    }
  }
  if (ctx.ecs) qs.set("edns_client_subnet", ctx.ecs);
  u.search = qs.toString();
  return u.toString();
}
async function withTimeout(promise, ms, label) {
  if (promise && typeof promise.catch === "function") promise.catch(() => {
  });
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timeout")), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function inspectWire(buf, cfg) {
  if (!buf || buf.byteLength < 12) return "short-response";
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const b2 = b[2];
  const flags2 = b2;
  if (!(flags2 & 128)) return "not-a-response";
  const tc = (b2 & 2) !== 0;
  const rcode = b[3] & 15;
  const ancount = b[6] << 8 | b[7];
  if (tc && cfg.retryTruncated) return "truncated";
  if (cfg.retryRcodes.includes(rcode)) return "rcode=" + rcode;
  if (cfg.retryEmpty && rcode === 0 && ancount === 0) return "empty-answer";
  return null;
}
async function runAttempt(cfg, ctx, provider) {
  const started = Date.now();
  const url = buildUpstreamUrl(provider, ctx);
  const headers = new Headers();
  headers.set("accept", ctx.isJson ? "application/dns-json" : "application/dns-message");
  if (ctx.method === "POST") headers.set("content-type", "application/dns-message");
  const init = { method: ctx.method, headers, redirect: "follow" };
  if (ctx.method === "POST") init.body = ctx.body;
  const resp = await withTimeout(fetch(url, init), cfg.attemptTimeout, provider.name + " fetch");
  if (!resp || !resp.ok) {
    throw new Error(provider.name + " http " + (resp ? resp.status : "nil"));
  }
  const buf = await withTimeout(resp.arrayBuffer(), cfg.attemptTimeout, provider.name + " body");
  if (!ctx.isJson) {
    const bad = inspectWire(buf, cfg);
    if (bad) throw new Error(provider.name + " bad-response(" + bad + ")");
  }
  const outHeaders = new Headers();
  const upstreamCt = resp.headers.get("content-type");
  outHeaders.set("content-type", ctx.isJson ? "application/dns-json" : "application/dns-message");
  if (upstreamCt && ctx.isJson) outHeaders.set("content-type", upstreamCt);
  const cc = resp.headers.get("cache-control");
  if (cc) outHeaders.set("cache-control", cc);
  outHeaders.set("x-doh-upstream", provider.name);
  return {
    provider,
    buf,
    status: ctx.isJson ? resp.status : 200,
    response: new Response(buf, { status: ctx.isJson ? resp.status : 200, headers: outHeaders }),
    ms: Date.now() - started
  };
}
function raceProviders(cfg, ctx, ordered) {
  const attempts = Math.min(cfg.maxAttempts, ordered.length);
  return new Promise((resolve, reject) => {
    let settled = false;
    let launched = 0;
    let inflight = 0;
    let failed = 0;
    let firstErr = null;
    let hedgeTimer = null;
    let totalTimer = null;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      clearTimeout(totalTimer);
      fn(val);
    };
    const scheduleHedge = () => {
      if (settled || launched >= attempts) return;
      clearTimeout(hedgeTimer);
      hedgeTimer = setTimeout(maybeLaunch, cfg.hedgeDelay);
    };
    const maybeLaunch = () => {
      if (settled || launched >= attempts) return;
      const provider = ordered[launched++];
      inflight += 1;
      runAttempt(cfg, ctx, provider).then((result) => {
        markSuccess(provider);
        finish(resolve, result);
      }).catch((err) => {
        inflight -= 1;
        failed += 1;
        if (!firstErr) firstErr = err;
        markFailure(provider);
        logAlert("[doh] upstream failed: " + provider.name + " -> " + err.message);
        if (launched < attempts) maybeLaunch();
        else if (inflight === 0) finish(reject, firstErr || err);
        else scheduleHedge();
      });
      scheduleHedge();
    };
    totalTimer = setTimeout(() => finish(reject, firstErr || new Error("total timeout")), cfg.totalTimeout);
    maybeLaunch();
  });
}
function cacheStore(cfg) {
  if (!cfg.cacheTtl) return null;
  try {
    if (typeof caches !== "undefined" && caches && caches.default) return caches.default;
  } catch (_) {
  }
  return null;
}
function cacheKey(request, ctx) {
  const u = new URL(request.url);
  u.hostname = "doh.cache";
  u.protocol = "http:";
  if (ctx.isJson) u.searchParams.sort();
  return u.toString() + "|" + (ctx.isJson ? "json" : "wire");
}
function withCors(headers, request) {
  headers.set("access-control-allow-origin", request.headers.get("origin") || "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, accept");
  headers.set("access-control-max-age", "86400");
  return headers;
}
function errorResponse(cfg, request, status, message) {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (cfg.cors) withCors(headers, request);
  return new Response(JSON.stringify({ status, message, version: VERSION }), { status, headers });
}
async function handleRequest(request, env2) {
  const cfg = readConfig(env2);
  if (request.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers: withCors(new Headers(), request) });
  }
  const parsed = await parseClientRequest(request, cfg);
  if (parsed.error) return errorResponse(cfg, request, parsed.error.status, parsed.error.message);
  const ctx = parsed.ctx;
  let pool = cfg.providers.filter((p) => ctx.isJson ? p.json !== false : p.wire !== false);
  if (!pool.length) pool = cfg.providers;
  const cStore = cacheStore(cfg);
  const key = cStore ? cacheKey(request, ctx) : null;
  if (cStore) {
    try {
      const hit = await cStore.get(key);
      if (hit) {
        const buf = await hit.arrayBuffer();
        const headers2 = new Headers(hit.headers);
        headers2.set("x-doh-cache", "HIT");
        if (cfg.cors) withCors(headers2, request);
        return new Response(buf, { status: hit.status, headers: headers2 });
      }
    } catch (e) {
      logAlert("[doh] cache get error: " + (e && e.message));
    }
  }
  const ordered = orderProviders(pool, cfg);
  const started = Date.now();
  let result;
  try {
    result = await raceProviders(cfg, ctx, ordered);
  } catch (err) {
    return errorResponse(cfg, request, 502, "all upstreams failed: " + (err && err.message));
  }
  const headers = new Headers(result.response.headers);
  headers.set("x-doh-cache", "MISS");
  headers.set("x-doh-timing", Date.now() - started + "ms");
  headers.set("x-doh-version", VERSION);
  if (cfg.cors) withCors(headers, request);
  const out = new Response(result.buf, { status: result.status, headers });
  if (cStore) {
    try {
      const h = new Headers(result.response.headers);
      h.set("cache-control", "max-age=" + cfg.cacheTtl);
      const cacheResp = new Response(result.buf, { status: result.status, headers: h });
      await cStore.put(key, cacheResp);
    } catch (e) {
      logAlert("[doh] cache put error: " + (e && e.message));
    }
  }
  return out;
}
var index_default = {
  async fetch(request, context, env2) {
    try {
      return await handleRequest(request, env2);
    } catch (err) {
      logAlert("[doh] gateway error: " + (err && err.stack ? err.stack : err));
      return errorResponse({ cors: true, cacheTtl: 0 }, request, 500, "internal error: " + (err && err.message));
    }
  }
};
if (typeof addEventListener === "function") {
  try {
    addEventListener("fetch", (event) => {
      event.respondWith(handleRequest(event.request, typeof env !== "undefined" ? env : void 0));
    });
  } catch (_) {
  }
}
export {
  base64UrlDecode,
  base64UrlEncode,
  index_default as default,
  handleRequest,
  inspectWire,
  orderProviders,
  readConfig
};
