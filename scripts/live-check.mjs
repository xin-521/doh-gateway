/**
 * 真实网络冒烟脚本：用 Node 的原生 fetch 直接调用网关逻辑，连真实 DoH 上游。
 * 需要能访问外网（国内节点建议配置代理，或让 DOH_UPSTREAMS 只含国内上游）。
 *
 *   node scripts/live-check.mjs
 */
import gateway from '../src/index.js';

const NAME = process.argv[2] || 'www.taobao.com';
const TYPE = process.argv[3] || 'A';

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function makeQuery(name, type = 1) {
  const labels = name.split('.');
  const qnameLen = labels.reduce((n, l) => n + 1 + l.length, 0) + 1;
  const buf = new Uint8Array(12 + qnameLen + 4);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, 0x1234);
  dv.setUint16(2, 0x0100);
  dv.setUint16(4, 1);
  let o = 12;
  for (const l of labels) {
    buf[o++] = l.length;
    for (const ch of l) buf[o++] = ch.charCodeAt(0);
  }
  buf[o++] = 0;
  dv.setUint16(o, type);
  dv.setUint16(o + 2, 1);
  return buf;
}

const env = {
  DOH_CACHE_TTL: '0',
  DOH_STRATEGY: process.env.DOH_STRATEGY || 'hedge',
  DOH_DEBUG: '1',
};
// 允许通过环境变量临时覆盖上游，便于本机验证（国内直连国外 DoH 可能超时）
if (process.env.DOH_UPSTREAMS) env.DOH_UPSTREAMS = process.env.DOH_UPSTREAMS;

async function resolveWire() {
  const url = `https://gw.local/dns-query?dns=${b64url(makeQuery(NAME, TYPE === 'AAAA' ? 28 : 1))}`;
  const started = Date.now();
  const res = await gateway.fetch(new Request(url), {}, env);
  const buf = new Uint8Array(await res.arrayBuffer());
  console.log(
    `[wire] status=${res.status} upstream=${res.headers.get('x-doh-upstream')} ` +
      `type=${res.headers.get('content-type')} bytes=${buf.byteLength} timing=${Date.now() - started}ms`,
  );
  if (res.status !== 200) return;
  const ancount = (buf[6] << 8) | buf[7];
  console.log(`[wire] rcode=${buf[3] & 0x0f} ancount=${ancount}`);
}

async function resolveJson() {
  const url = `https://gw.local/dns-query?name=${encodeURIComponent(NAME)}&type=${TYPE}`;
  const started = Date.now();
  const res = await gateway.fetch(new Request(url, { headers: { accept: 'application/dns-json' } }), {}, env);
  console.log(`[json] status=${res.status} upstream=${res.headers.get('x-doh-upstream')} timing=${Date.now() - started}ms`);
  if (res.status === 200) {
    const data = await res.json();
    console.log('[json] Status=' + data.Status);
    for (const a of data.Answer || []) console.log(`  ${a.name} ${a.type} ${a.data}`);
  }
}

await resolveWire();
await resolveJson();
