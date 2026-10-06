/**
 * 本地验证脚本（node:test）——在不依赖 ESA 账号的情况下验证网关核心逻辑。
 *
 *   node --test test/gateway.test.mjs
 *
 * 通过 mock 全局 fetch 来模拟多个 DoH 上游，覆盖：转发、故障切换、
 * SERVFAIL 重试、对冲(hedging)竞速、JSON 透传、参数校验、CORS。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import gateway, { orderProviders, readConfig, inspectWire } from '../src/index.js';

// ---------------------------------------------------------------------------
// 构造最小可用 DNS wire 报文
// ---------------------------------------------------------------------------
function makeQueryWire(id = 0x1234) {
  const labels = ['example', 'com'];
  const qnameLen = labels.reduce((n, l) => n + 1 + l.length, 0) + 1;
  const buf = new Uint8Array(12 + qnameLen + 4);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, id);
  dv.setUint16(2, 0x0100); // RD
  dv.setUint16(4, 1); // QDCOUNT
  let o = 12;
  for (const label of labels) {
    buf[o++] = label.length;
    for (const ch of label) buf[o++] = ch.charCodeAt(0);
  }
  buf[o++] = 0;
  dv.setUint16(o, 1); // QTYPE A
  dv.setUint16(o + 2, 1); // QCLASS IN
  return buf;
}

function makeResponseWire({ id = 0x1234, rcode = 0, ancount = 1, tc = false } = {}) {
  const buf = new Uint8Array(12 + 4);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, id);
  let flags = 0x8180; // QR + RD + RA
  if (tc) flags |= 0x0200;
  dv.setUint16(2, flags);
  dv.setUint16(4, 0);
  dv.setUint16(6, ancount);
  buf[3] = (buf[3] & 0xf0) | (rcode & 0x0f);
  return buf;
}

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

// 每个测试独立构造 fetch mock
function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u.toString(), host: u.hostname, method: init?.method || 'GET' });
    const handler = routes[u.hostname];
    if (!handler) throw new Error('ECONNREFUSED ' + u.hostname);
    return handler(u, init);
  };
  return calls;
}

function wireResponse(body, { status = 200 } = {}) {
  return new Response(body, { status, headers: { 'content-type': 'application/dns-message' } });
}

function jsonResponse(obj, { status = 200 } = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/dns-json' },
  });
}

const BASE_ENV = {
  DOH_CACHE_TTL: '0',
  DOH_STRATEGY: 'hedge',
  DOH_HEDGE_DELAY_MS: '50',
  DOH_ATTEMPT_TIMEOUT_MS: '1000',
  DOH_TOTAL_TIMEOUT_MS: '3000',
  DOH_COOLDOWN_MS: '0',
  DOH_UPSTREAMS: JSON.stringify([
    { name: 'a', url: 'https://a.example/dns-query', weight: 1e6 },
    { name: 'b', url: 'https://b.example/dns-query', weight: 1 },
  ]),
};

test('GET wire: 转发到首选上游并返回 dns-message', async () => {
  const calls = installFetch({
    'a.example': () => wireResponse(makeResponseWire()),
  });
  const url = 'https://gw.example/dns-query?dns=' + b64url(makeQueryWire());
  const res = await gateway.fetch(new Request(url), {}, BASE_ENV);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/dns-message');
  assert.equal(res.headers.get('x-doh-upstream'), 'a');
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.equal(buf[2] & 0x80, 0x80);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /[?&]dns=/);
});

test('HTTP 500 触发故障切换到下一个上游', async () => {
  const calls = installFetch({
    'a.example': () => wireResponse(makeResponseWire(), { status: 500 }),
    'b.example': () => wireResponse(makeResponseWire()),
  });
  const res = await gateway.fetch(
    new Request('https://gw.example/dns-query?dns=' + b64url(makeQueryWire())),
    {},
    BASE_ENV,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-doh-upstream'), 'b');
  assert.equal(calls.length, 2);
});

test('SERVFAIL rcode 触发切换到下一个上游', async () => {
  installFetch({
    'a.example': () => wireResponse(makeResponseWire({ rcode: 2 })),
    'b.example': () => wireResponse(makeResponseWire({ rcode: 0 })),
  });
  const res = await gateway.fetch(
    new Request('https://gw.example/dns-query?dns=' + b64url(makeQueryWire())),
    {},
    BASE_ENV,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-doh-upstream'), 'b');
});

test('短响应/非响应报文触发切换', async () => {
  installFetch({
    'a.example': () => wireResponse(new Uint8Array([0, 1, 2])),
    'b.example': () => wireResponse(makeResponseWire()),
  });
  const res = await gateway.fetch(
    new Request('https://gw.example/dns-query?dns=' + b64url(makeQueryWire())),
    {},
    BASE_ENV,
  );
  assert.equal(res.headers.get('x-doh-upstream'), 'b');
});

test('对冲(hedging)：慢上游未返回时，快上游胜出', async () => {
  installFetch({
    'a.example': () =>
      new Promise((resolve) => setTimeout(() => resolve(wireResponse(makeResponseWire())), 400)),
    'b.example': () => wireResponse(makeResponseWire()),
  });
  const res = await gateway.fetch(
    new Request('https://gw.example/dns-query?dns=' + b64url(makeQueryWire())),
    {},
    { ...BASE_ENV, DOH_HEDGE_DELAY_MS: '40' },
  );
  assert.equal(res.headers.get('x-doh-upstream'), 'b');
});

test('POST application/dns-message 透传 body', async () => {
  let seenLen = 0;
  installFetch({
    'a.example': async (u, init) => {
      const body = init.body;
      seenLen = body.byteLength;
      return wireResponse(makeResponseWire());
    },
  });
  const body = makeQueryWire();
  const res = await gateway.fetch(
    new Request('https://gw.example/dns-query', {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message' },
      body,
    }),
    {},
    BASE_ENV,
  );
  assert.equal(res.status, 200);
  assert.equal(seenLen, body.byteLength);
});

test('JSON DoH (?name=) 透传并保留 json content-type', async () => {
  installFetch({
    'a.example': (u) => {
      assert.equal(u.searchParams.get('name'), 'example.com');
      return jsonResponse({ Status: 0, Answer: [{ name: 'example.com', type: 1, data: '1.2.3.4' }] });
    },
  });
  const res = await gateway.fetch(
    new Request('https://gw.example/dns-query?name=example.com&type=A', {
      headers: { accept: 'application/dns-json' },
    }),
    {},
    BASE_ENV,
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/dns-json/);
  const data = await res.json();
  assert.equal(data.Answer[0].data, '1.2.3.4');
});

test('OPTIONS 预检返回 204 + CORS', async () => {
  installFetch({});
  const res = await gateway.fetch(new Request('https://gw.example/dns-query', { method: 'OPTIONS' }), {}, BASE_ENV);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('缺少 ?dns= 返回 400', async () => {
  installFetch({});
  const res = await gateway.fetch(new Request('https://gw.example/dns-query'), {}, BASE_ENV);
  assert.equal(res.status, 400);
});

test('非法 base64url 返回 400', async () => {
  installFetch({});
  const res = await gateway.fetch(new Request('https://gw.example/dns-query?dns=@@@'), {}, BASE_ENV);
  assert.equal(res.status, 400);
});

test('全部上游失败返回 502', async () => {
  installFetch({});
  const res = await gateway.fetch(
    new Request('https://gw.example/dns-query?dns=' + b64url(makeQueryWire())),
    {},
    BASE_ENV,
  );
  assert.equal(res.status, 502);
});

test('orderProviders: 加权乱序倾向高权重上游', () => {
  const cfg = { strategy: 'weighted', cooldown: 0 };
  const providers = [
    { name: 'light', url: 'https://l.example/', weight: 1 },
    { name: 'heavy', url: 'https://h.example/', weight: 1000 },
  ];
  let heavyFirst = 0;
  for (let i = 0; i < 200; i++) {
    if (orderProviders(providers, cfg)[0].name === 'heavy') heavyFirst++;
  }
  assert.ok(heavyFirst > 190, 'heavyFirst=' + heavyFirst);
});

test('orderProviders: round-robin 轮换', () => {
  const cfg = { strategy: 'round-robin', cooldown: 0 };
  const providers = [
    { name: 'p1', url: 'https://p1.example/', weight: 1 },
    { name: 'p2', url: 'https://p2.example/', weight: 1 },
    { name: 'p3', url: 'https://p3.example/', weight: 1 },
  ];
  const seen = new Set();
  for (let i = 0; i < 6; i++) seen.add(orderProviders(providers, cfg)[0].name);
  assert.deepEqual([...seen].sort(), ['p1', 'p2', 'p3']);
});

test('冷却：失败上游被降权排序', async () => {
  const env = {
    ...BASE_ENV,
    DOH_COOLDOWN_MS: '60000',
    DOH_MAX_ATTEMPTS: '2',
    DOH_UPSTREAMS: JSON.stringify([
      { name: 'bad', url: 'https://bad.example/dns-query', weight: 1e6 },
      { name: 'good', url: 'https://good.example/dns-query', weight: 1 },
    ]),
  };
  installFetch({
    'bad.example': () => wireResponse(makeResponseWire(), { status: 500 }),
    'good.example': () => wireResponse(makeResponseWire()),
  });
  const res = await gateway.fetch(
    new Request('https://gw.example/dns-query?dns=' + b64url(makeQueryWire())),
    {},
    env,
  );
  assert.equal(res.status, 200);
  const cfg = readConfig(env);
  assert.equal(orderProviders(cfg.providers, cfg)[0].name, 'good');
});

test('readConfig: 非法 DOH_UPSTREAMS 回退默认值', () => {
  const cfg = readConfig({ DOH_UPSTREAMS: '{not-json' });
  assert.ok(cfg.providers.length > 0);
  assert.equal(cfg.strategy, 'hedge');
  assert.equal(cfg.maxAttempts, 3);
});

test('readConfig: 默认上游全为国外顶级 DNS，且默认开 ECS', () => {
  const cfg = readConfig({});
  assert.deepEqual(cfg.providers.map((p) => p.name).sort(), [
    'adguard',
    'cloudflare',
    'dns0',
    'google',
    'opendns',
    'quad9',
  ]);
  for (const p of cfg.providers) assert.match(p.url, /^https:\/\//);
  assert.equal(cfg.forwardEcs, true);
});

test('JSON 模式下 wire-only 上游被过滤', async () => {
  const env = {
    ...BASE_ENV,
    DOH_UPSTREAMS: JSON.stringify([
      { name: 'wireonly', url: 'https://w.example/dns-query', weight: 1e6, json: false },
      { name: 'both', url: 'https://b2.example/dns-query', weight: 1 },
    ]),
  };
  installFetch({ 'b2.example': () => jsonResponse({ Status: 0 }) });
  const res = await gateway.fetch(
    new Request('https://gw.example/dns-query?name=example.com&type=A', {
      headers: { accept: 'application/dns-json' },
    }),
    {},
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-doh-upstream'), 'both');
});

test('inspectWire: 直接接收 ArrayBuffer', () => {
  const ab = makeResponseWire().buffer;
  assert.equal(inspectWire(ab, { retryRcodes: [2, 5], retryTruncated: true, retryEmpty: false }), null);
});
