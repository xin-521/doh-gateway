# ESA DoH Gateway

在**阿里云 ESA 边缘节点**上运行的 DNS-over-HTTPS（DoH, RFC 8484）转发网关。一个函数内可配置**多个 DoH 上游**，通过**加权轮询 / 随机 / 对冲（Hedging）竞速**做负载均衡与故障切换，从而在最近的边缘节点用最快的上游解析出 IP。

## 它做什么

```
客户端 (DoH)            ESA 边缘节点 (本函数)                 多个 DoH 上游
──────────              ──────────────────────                ──────────────
GET /dns-query?dns=...  ┌───────────────────────┐   hedge     alidns  ┐
POST application/     → │ 解析 → 选路 → 并发/竞速 │ ────────→  dnspod  ├─ 先返回者胜出
     dns-message        │ 校验 rcode/TC → 熔断   │   failover  doh.pub ┘
GET ?name=&type=        └───────────────────────┘
                                     │ 缓存 / CORS / 计时头
                                     ▼
                              统一返回 dns-message / dns-json
```

- **协议**：兼容 RFC 8484 的 `GET ?dns=<base64url>` 与 `POST application/dns-message`；同时兼容 JSON DoH（`?name=&type=`，`Accept: application/dns-json`）。
- **多上游负载均衡**：
  - `hedge`（默认）：先发首选上游，`DOH_HEDGE_DELAY_MS` 内没返回就并发下一个，谁先成功用谁——显著降低长尾延迟。
  - `weighted`：按权重随机排序后依次尝试。
  - `round-robin`：按上游列表轮询。
  - `random`：完全随机。
- **故障切换**：上游 HTTP 非 2xx、超时、报文过短/非响应、`SERVFAIL`/`REFUSED`、截断（TC=1）都会自动切下一个上游。
- **健康熔断**：某上游失败后进入 `DOH_COOLDOWN_MS` 冷却，期间被排到最后，避免反复踩坑。
- **可选缓存**：`DOH_CACHE_TTL > 0` 时用 ESA Cache API 缓存成功响应。
- **可观测**：响应带 `x-doh-upstream` / `x-doh-timing` / `x-doh-cache` / `x-doh-version` 便于排查。

## 关键限制（来自 ESA 官方文档）

| 项 | 限制 | 本函数的应对 |
| --- | --- | --- |
| fetch 子请求 | 默认 4 个/次 | `DOH_MAX_ATTEMPTS ≤ 4`，缓存另占配额 |
| 网关等待 | 10s 返回 504 | `DOH_TOTAL_TIMEOUT_MS` 默认 5s |
| 单次响应 | 120s | 远小于该值 |
| 语言 | 仅 JavaScript (ES6) | 纯 JS，无依赖 |
| 代码包 | 4 MB | 单文件约 15 KB |

## 目录结构

```
src/index.js              边缘函数（唯一运行时代码）
test/gateway.test.mjs     node:test 单元/集成测试（mock 上游）
scripts/live-check.mjs    真实网络冒烟脚本
esa.jsonc                 ESA CLI / 控制台项目配置
package.json
```

## 快速开始

前置：Node.js ≥ 20、已开通 ESA「函数和 Pages」。

```bash
# 1. 安装依赖（国内镜像已配置，若未配置可加 --registry https://registry.npmmirror.com）
npm install

# 2. 登录（AK/SK，建议用环境变量避免进 shell history）
export ESA_ACCESS_KEY_ID=xxx
export ESA_ACCESS_KEY_SECRET=yyy
npx esa-cli login

# 3. 本地调试（可选）
npx esa-cli dev            # 默认 http://localhost:18080

# 4. 生成版本并上线
npx esa-cli commit -m "init doh gateway"
npx esa-cli deploy

# 5. 绑定域名或路由（域名须属于你的 ESA 站点；也可用路由把某路径指到函数）
npx esa-cli domain add dns.example.com
# 或
npx esa-cli route add --pattern "/dns-query"
```

> `jsonUrl`：JSON DoH 与 wire DoH 不同端点时使用（如 Google）。设置 `"json": false` 可让某上游只处理 wire 请求（Quad9/OpenDNS/dns0.eu 默认即 wire-only）。
>
> 若在本地直接使用 `esa-cli`，也可全局安装：`npm i -g esa-cli`。CI 场景建议固定为项目依赖。

## 环境变量（在控制台「函数变量 / ESA CLI env」中配置）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DOH_UPSTREAMS` | 见下 | JSON 数组，上游列表。元素可为 URL 字符串或 `{name,url,jsonUrl,weight,json,wire}`。仅接受 `https://`。 |
| `DOH_STRATEGY` | `hedge` | `hedge` \| `weighted` \| `random` \| `round-robin` |
| `DOH_MAX_ATTEMPTS` | `3` | 1–4，单次请求最多尝试的上游数 |
| `DOH_HEDGE_DELAY_MS` | `300` | 对冲延迟；越小越激进 |
| `DOH_ATTEMPT_TIMEOUT_MS` | `1200` | 单个上游超时 |
| `DOH_TOTAL_TIMEOUT_MS` | `5000` | 整次请求预算（< 网关 10s） |
| `DOH_COOLDOWN_MS` | `30000` | 失败上游冷却时长 |
| `DOH_CACHE_TTL` | `30` | 缓存秒数，`0` 关闭 |
| `DOH_RETRY_RCODES` | `2,5` | 触发切换的 DNS rcode（SERVFAIL/REFUSED） |
| `DOH_RETRY_TRUNCATED` | `true` | 截断响应是否切换 |
| `DOH_RETRY_EMPTY` | `false` | 空答案是否切换 |
| `DOH_FORWARD_ECS` | `true` | 透传客户端 IP 作为 EDNS Client Subnet（利于就近解析） |
| `DOH_CORS` | `true` | 是否加 CORS 头 |
| `DOH_DEBUG` | `false` | 调试开关 |

`DOH_UPSTREAMS` 不配置时使用内置默认上游；默认上游全部为国外顶级公共 DNS：

| 名称 | 端点 | JSON | 权重 |
| --- | --- | --- | --- |
| cloudflare | `https://cloudflare-dns.com/dns-query` | ✅ 同端点 | 4 |
| google | `https://dns.google/dns-query`（JSON：`https://dns.google/resolve`） | ✅ | 3 |
| quad9 | `https://dns.quad9.net/dns-query` | ❌ 仅 wire | 3 |
| opendns | `https://doh.opendns.com/dns-query` | ❌ 仅 wire | 2 |
| adguard | `https://dns.adguard-dns.com/dns-query` | ✅ | 2 |
| dns0.eu | `https://dns0.eu/` | ❌ 仅 wire | 1 |

自定义示例：

```json
[
  { "name": "cloudflare", "url": "https://cloudflare-dns.com/dns-query", "weight": 5 },
  { "name": "quad9",      "url": "https://dns.quad9.net/dns-query", "weight": 3 },
  { "name": "mydns",      "url": "https://dns.example.com/dns-query", "weight": 1 }
]
```

## 客户端接入

```bash
# wire 格式（RFC 8484）
curl -s -o /dev/null -w '%{http_code}\n' \
  'https://dns.example.com/dns-query?dns=AAABAAABAAAAAAAAA3d3dwZ0YW9iYW8DY29tAAABAAE' \
  -H 'accept: application/dns-message'

# JSON 格式
curl -s 'https://dns.example.com/dns-query?name=www.taobao.com&type=A' \
  -H 'accept: application/dns-json'

# curl 自带 DoH 支持（JSON 输出）
curl --doh-url https://dns.example.com/dns-query https://www.taobao.com
```

`dig`（需 doh 工具如 `dog` / `q`）：`dog www.taobao.com @https://dns.example.com/dns-query`

存活探测：不带查询参数的 `GET`/`HEAD` 会返回 `200` + `{"status":200,...}`（而不是 400），方便客户端在填写服务器地址时做可用性校验；`OPTIONS` 返回 204。带 `?dns=`/`?name=` 时才是真正的解析请求。

## 本地验证

```bash
# 单元/集成测试（mock 上游，无需联网）：19 个用例，覆盖转发/故障切换/对冲/校验/HEAD 探测/CORS
npm test

# 真实网络冒烟（需能访问国外 DoH；国内本机直连可能超时，ESA 边缘节点可正常访问）
npm run live-check -- www.taobao.com A
```

测试与冒烟脚本把 `x-doh-upstream` 打印出来，用于确认负载均衡确实生效。

## 安全与注意

- 上游仅允许 `https://`，避免明文 DNS 回源。
- 本函数默认对所有来源开放。如需限制，可在 ESA 侧用 WAF / 访问控制，或在函数里校验来源。
- 缓存按「URL + 格式」缓存，DNS 报文内含事务 ID，因此只对相同查询字符串有效；如需按域名聚合缓存，可再演进为按 name/type 归一化。
- 若发现上游频繁打满，调大 `DOH_HEDGE_DELAY_MS` 或调小 `DOH_MAX_ATTEMPTS`（对冲会成倍消耗子请求）。
- 切勿把 AK/SK 写进代码，用 ESA 函数变量/密钥。

## 已验证

- `node --test test/gateway.test.mjs` → **16/16 通过**
