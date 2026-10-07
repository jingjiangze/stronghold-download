// Shared server-list validation helpers for the Pages Functions.
// verifyServerHealth() performs the "is this really a Stronghold Protocol server" check:
// it fetches {target}{probe} server-side (no CORS restrictions there) and compares the
// JSON body against the identity fields recorded in data/verify.json (sourced from the
// upstream repo sganggs/Stronghold-Protocol, shared/constants.js).

// 只有协议号（PROTOCOL_VERSION，上游 shared/constants.js）参与门禁；
// 发布号（APP_VERSION）一律只记录不判定 —— 上游一发新版，写死版本会把已升级的好服集体误杀。
const VERIFY = { version: 1 };

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
                    /^172\.(1[6-9]|2[0-9]|3[01])\./];

// Two official healthz shapes are accepted:
//  - node/server build: { ok, version, app, uptimeSec, sockets, sessions, rooms, matches, humans, bots }
//  - cloudflare workers build: { ok, runtime: "cloudflare", version, build: <git sha> }
const HEALTH_FIELDS = ['uptimeSec', 'sockets', 'sessions', 'rooms', 'matches', 'humans', 'bots'];
const VERIFY_TIMEOUT_MS = 5000;
const MAX_HEALTH_BYTES = 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_REDIRECTS = 2;

function isUnsafeHostname(raw) {
  const h = String(raw || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.startsWith('[')) {
    const v6 = h.slice(1, -1);
    if (v6 === '::1' || v6 === '::') return true;
    if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return true;
    return false;
  }
  if (h === '0.0.0.0') return true;
  return PRIVATE_V4.some((re) => re.test(h));
}

/** Canonical form used for "is this the same server?" — origin + path, no query/hash, no
 *  trailing slash. Two instances on one host under different paths or ports are different
 *  servers, so dedup must NOT collapse to the host. */
export function canonicalUrl(raw) {
  const check = validateUrl(raw);
  return check.error ? String(raw || '').trim().toLowerCase() : check.href.toLowerCase();
}

function validateUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return { error: '地址无法解析' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: '仅允许 http/https' };
  if (url.username || url.password) return { error: '地址中不能包含账号密码' };
  if (isUnsafeHostname(url.hostname)) return { error: '拒绝内网/环回/保留地址' };
  // ?room=CODE 这类深链只是邀请进房，不是另一台服务器：丢 query/hash，保留 path（子路径挂载是真的）
  url.search = '';
  url.hash = '';
  return { href: url.href.replace(/\/+$/, '') || url.href, host: url.host, origin: url.origin };
}

/**
 * 证书旁路探针的报告通道。
 * Cloudflare 的 fetch **没有**"忽略证书"开关，所以自签源站（SakuraFrp 这类映射给的自动证书）
 * 在边缘永远只能拿到 525/526 —— 这一路探针跑在能关掉校验的地方（GitHub Runner / 本机盒子），
 * 结果写进 R2 的 site/probes.json，站点侧只消费不信任何多余的东西。
 * 纪律：只有 **ok:true 且带完整协议指纹** 的报告才算证据，且必须在 PROBE_REPORT_TTL_MS 内。
 * 它替代的是"CF 能不能握手"，绝不替代"是不是卫戍协议服务器"。
 */
export const PROBE_REPORT_KEY = 'site/probes.json';
export const RECHECK_KEY = 'site/recheck.json';
export const PROBE_REPORT_TTL_MS = 12 * 3600 * 1000;

/** 报告按归一化后的地址为键，和清单里的 url 同一套口径。 */
export function probeKey(raw) {
  const n = normalizeTarget(raw);
  return n.error ? null : n.url;
}

export async function readProbeReports(env) {
  const out = {};
  if (!env || !env.R2BUCKET) return out;
  let res;
  try { res = await env.R2BUCKET.get(PROBE_REPORT_KEY); } catch { return out; }
  if (!res) return out;
  let doc;
  try { doc = JSON.parse(await res.text()); } catch { return out; }
  const reports = (doc && doc.reports && typeof doc.reports === 'object') ? doc.reports : {};
  const now = Date.now();
  for (const raw of Object.keys(reports)) {
    const key = probeKey(raw);
    const r = reports[raw] || {};
    if (!key || !r || typeof r !== 'object') continue;
    const at = Date.parse(r.at || '');
    if (!Number.isFinite(at) || now - at > PROBE_REPORT_TTL_MS) continue;
    if (r.ok !== true) continue;
    const fp = clampFingerprint(r.fingerprint && typeof r.fingerprint === 'object' ? r.fingerprint : r);
    if (!fp) continue;   // 没有完整协议指纹的报告一律不信
    const path = typeof r.probePath === 'string' && r.probePath.startsWith('/') ? r.probePath.slice(0, 64) : null;
    out[key] = {
      at: new Date(at).toISOString(), ageMin: Math.round((now - at) / 60000),
      probePath: path, fingerprint: fp,
      source: String(r.source || '').slice(0, 32) || 'tls-probe',
      reason: String(r.reason || '').slice(0, 90),
      tls: String(r.tls || '').slice(0, 32),
      // 入口页（玩家真正会点的那条）在探针那边打不打得开：探针顺手测一次，站点就少一次瞎猜
      entryOk: typeof r.entryOk === 'boolean' ? r.entryOk : null,
      entryStatus: Number.isInteger(r.entryStatus) && r.entryStatus >= 100 && r.entryStatus <= 599 ? r.entryStatus : null,
    };
  }
  return out;
}

/**
 * 待复核清单：submit 把"边缘看不见"的地址登记到公开的 site/recheck.json，
 * 证书旁路探针就能在没有管理口令的 GitHub Runner 上读到要复核谁。
 * 只写地址与探针路径 —— 提交者 IP、备注、浏览器证据都留在 KV 队列里不出去。
 */
export async function rememberRecheck(env, url, probe, maxItems) {
  const key = probeKey(url);
  if (!key || !env || !env.R2BUCKET) return false;
  try {
    const res = await env.R2BUCKET.get(RECHECK_KEY);
    let doc = null;
    try { doc = res ? JSON.parse(await res.text()) : null; } catch { doc = null; }
    const items = Array.isArray(doc && doc.items) ? doc.items : [];
    const at = new Date().toISOString();
    const idx = items.findIndex((it) => it && probeKey(it.url) === key);
    if (idx >= 0) items[idx] = { url: key, probe: probe || null, at, tries: (Number(items[idx].tries) || 0) + 1 };
    else items.unshift({ url: key, probe: probe || null, at, tries: 1 });
    const cap = maxItems || 200;
    while (items.length > cap) items.pop();
    await env.R2BUCKET.put(RECHECK_KEY, JSON.stringify({ updated: at, items }, null, 2) + '\n', {
      httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=120' },
    });
    return true;
  } catch { return false; }
}


/** Fetch with manual redirects; every hop is re-validated (scheme + host class). */
async function safeFetch(url, init, redirects) {
  let res;
  try {
    res = await fetch(url, { ...init, redirect: 'manual' });
  } catch (err) {
    // A timeout or an unreachable host must degrade to "this one server failed". Letting it
    // reject used to abort Promise.all in servers/verify and 500 the whole round (CF 1101),
    // so one flaky entry starved every visitor of fresh verdicts.
    const name = (err && err.name) || 'Error';
    return { error: name === 'TimeoutError' || name === 'AbortError' ? '探测超时' : '连接失败（' + name + '）' };
  }
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) return { error: '重定向缺少目标' };
    if (redirects >= MAX_REDIRECTS) return { error: '重定向次数过多' };
    let next;
    try { next = new URL(location, url); } catch { return { error: '重定向目标无效' }; }
    if (next.protocol !== 'https:' && next.protocol !== 'http:') return { error: '重定向到非 http(s)' };
    if (isUnsafeHostname(next.hostname)) return { error: '重定向到内网地址' };
    next.search = ''; next.hash = '';
    return safeFetch(next, init, redirects + 1);
  }
  return { res };
}

/**
 * 地址归一化：玩家报上来的形态五花八门 —— `dx.frp-gap.com`、`dx.frp-gap.com:29943`、
 * `HTTPS://Host:29943//`、`http://1.2.3.4:3000/`。以前没有协议就直接"地址无法解析"，
 * 等于把能进游戏的服务器挡在门外。规则：
 *   - 缺协议一律补 `https:`（不再退回 http —— 清单页是 https，http 条目浏览器根本不让探）；
 *   - 去首尾空白、重复斜杠、query/hash、尾斜杠；host 转小写（端口保留）；
 *   - 内网/环回/保留/带账号密码 照旧拒绝（这条不放宽，见 isUnsafeHostname）。
 * 返回 { url } 或 { error }。
 */
export function normalizeTarget(raw) {
  let s = String(raw || '').trim();
  if (!s) return { error: '地址不能为空' };
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  let url;
  try { url = new URL(s); } catch { return { error: '地址无法解析' }; }
  url.protocol = url.protocol.toLowerCase();
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: '仅允许 http/https' };
  if (url.username || url.password) return { error: '地址中不能包含账号密码' };
  url.hostname = url.hostname.toLowerCase().replace(/\.+$/, '');   // 尾点 FQDN 也算同一个 host
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (isUnsafeHostname(url.hostname)) return { error: '拒绝内网/环回/保留地址' };
  const href = url.href.replace(/\/+$/, '');
  return { url: href || url.href, host: url.host, hostname: url.hostname, protocol: url.protocol };
}

/**
 * 健康端点候选：各家挂载点不一样（rainya 用 `/api/status`，默认 `/healthz`），
 * 只打一条会把活着的服务器判成"不是卫戍协议"。按顺序试、**第一个应答合法就停**，
 * 并把命中的路径回传（存进条目的 `probe`，之后每轮校验只打那一条，不多敲门）。
 */
export const PROBE_PATHS = ['/healthz', '/api/status', '/api/health', '/health'];

/**
 * 失败分类 —— 这是"不放宽判定"的关键：
 *   negative     = 我们**看见了它不是**卫戍协议服务器（读到了 JSON，但 ok 不是 true / 缺协议字段）
 *                  → 仍然当场拒收。
 *   inconclusive = 我们**看不见**（CF 52x 源站证书问题、403 防火墙、超时、连接失败、
 *                  所有候选路径都 404/自定义）→ 不进清单，但**进暂存区**等维护者复核，
 *                  而不是把报料丢掉。dx.frp-gap.com:29943 就是这一类：SakuraFrp 给的自签证书
 *                  CF 验不过，玩家点过「继续访问」能进游戏，绕开校验后 /healthz 是完整指纹。
 * 注意"响应不是 JSON"也归 inconclusive 而不是 negative：很多面板在任意路径都回一张首页，
 * 那是**这条路径没挂对**，不是"这台不是卫戍服" —— 当成否定会把挂在别的路径上的活服一票否决，
 * 并且立刻 break 掉后面的候选路径。
 */
export function classifyProbeFailure(error) {
  const s = String(error || '');
  if (/不是卫戍协议服务器|ok 字段不是 true|缺少字段/.test(s)) return 'negative';
  return 'inconclusive';
}


/**
 * 一份「完整协议指纹」：健康端点回报 ok:true 且带协议字段。
 * 证书旁路探针只有拿出这个才算数 —— 它替代的是「CF 能不能握手」，不是「是不是卫戍服」。
 */
export function looksLikeProtocolFingerprint(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.ok !== true) return false;
  if (body.runtime === 'cloudflare' || typeof body.version === 'string') return true;   // workers 版
  if (!Number.isInteger(body.version)) return false;                                     // node 版：协议号必须是数字
  return HEALTH_FIELDS.some((f) => Number.isFinite(body[f]));
}

/** 指纹字段洗白：浏览器证据与探针报告共用一套上限（只有活人才会填满这些字段）。 */
function clampFingerprint(fp) {
  if (!fp || typeof fp !== 'object' || Array.isArray(fp) || fp.ok !== true) return null;
  const clean = { ok: true };
  if (Number.isInteger(fp.version) && fp.version >= 0 && fp.version < 1e6) clean.version = fp.version;
  if (fp.runtime === 'cloudflare') clean.runtime = 'cloudflare';
  if (typeof fp.app === 'string') clean.app = fp.app.slice(0, 32);
  if (typeof fp.build === 'string' && /^[0-9a-f]{6,40}$/i.test(fp.build)) clean.build = fp.build;
  for (const f of HEALTH_FIELDS) {
    if (Number.isFinite(fp[f]) && fp[f] >= 0 && fp[f] < 1e7) clean[f] = Math.round(fp[f]);
  }
  return looksLikeProtocolFingerprint(clean) ? clean : null;
}

const BV_KINDS = new Set(['protocol', 'not-protocol', 'not-json', 'http', 'tls', 'dns', 'timeout', 'blocked', 'cors']);

/**
 * 访客浏览器探针回执的清洗（见 js/servers.js 的 browserVerify）。
 * **只当复核材料，绝不作为放行依据**：这个对象来自访客的请求体，任何人都能伪造；
 * 它的价值在于浏览器是**唯一能穿过"证书警告 + 继续访问"**这条路径的观察点 ——
 * 边缘（Cloudflare）在 TLS 握手就断掉的自签源站，只有玩家自己的浏览器看得见真相。
 * 所以这里做的是收紧而不是照单全收：只留白名单字段、路径必须相对、数字必须有限、
 * 条数与长度都有上限，且 `level` 由服务端自己算，不信客户端自称的结论。
 */
export function sanitizeBrowserVerify(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};

  const results = [];
  // 先看 32 条再截 8 条：**截在清洗之前**的话，伪造的 junk 项会把真证据挤掉
  for (const item of Array.isArray(raw.results) ? raw.results.slice(0, 32) : []) {
    if (results.length >= 8) break;
    if (!item || typeof item !== 'object') continue;
    const path = String(item.path || '').slice(0, 64);
    const kind = String(item.kind || '');
    if (!path.startsWith('/') || !BV_KINDS.has(kind)) continue;
    const one = { path, kind };
    if (Number.isInteger(item.code) && item.code >= 100 && item.code <= 599) one.code = item.code;
    results.push(one);
  }
  if (results.length) out.results = results;

  const clean = clampFingerprint(raw.fingerprint);
  if (clean) out.fingerprint = clean;

  const probePath = String(raw.probePath || '').slice(0, 64);
  if (probePath.startsWith('/')) out.probePath = probePath;
  if (typeof raw.reachable === 'boolean') out.reachable = raw.reachable;
  if (typeof raw.entryReachable === 'boolean') out.entryReachable = raw.entryReachable;

  // 证据等级由服务端判定，前端改不动
  const hit = (out.results || []).some((r) => r.kind === 'protocol');
  out.level = out.fingerprint && (hit || !raw.results) ? 'protocol'
    : out.reachable === true || out.entryReachable === true ? 'reachable'
    : 'none';
  return out.level === 'none' && !out.results ? null : out;
}


/**
 * 一次身份核验：按候选路径逐个打，第一个合法指纹就停。
 * 返回 `{ ok:true, verdict:'pass', probePath, rooms, humans, app, build, variant }`
 * 或 `{ ok:false, verdict:'negative'|'inconclusive', error }`。
 * 结果按 origin+probe 缓存 CACHE_TTL_MS，避免这个函数被当成扫描放大器。
 */
const cache = new Map(); // in-memory per isolate; KV-free best-effort cache

export async function verifyServerHealth(origin, probe, timeoutMs) {
  const single = probe && String(probe).trim() ? [String(probe).trim()] : null;
  const candidates = single || PROBE_PATHS;
  const cacheKey = origin + '|' + candidates.join(',');
  const hit = cache.get(cacheKey);
  // A cached verdict must carry the same payload as a fresh one: returning only {ok:true}
  // used to blank rooms/humans/app for every server served from cache, and the list page
  // then wrote an occupancy doc with no version and no load.
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return Object.assign({ cached: true }, hit.verdict || (hit.ok ? {} : { ok: false, error: hit.error }));
  }

  let lastError = '地址无法解析';
  let lastVerdict = 'inconclusive';
  for (const path of candidates) {
    const one = await probeOnce(origin, path, timeoutMs);
    if (one.ok) {
      cache.set(cacheKey, { ok: true, verdict: one, at: Date.now() });
      return one;
    }
    lastError = one.error;
    lastVerdict = one.verdict;
    // 已经"看见它不是"就不用再敲别的门了（也只有这种才允许提前收工）
    if (one.verdict === 'negative') break;
  }
  const fail = { ok: false, verdict: lastVerdict, error: lastError };
  cache.set(cacheKey, { ok: false, error: lastError, verdict: fail, at: Date.now() });
  return fail;
}

/** 打一个候选路径。ok:false 时带 verdict（见 classifyProbeFailure）。 */
async function probeOnce(origin, probe, timeoutMs) {
  const cacheKey = origin + (probe || '/healthz');
  let target;
  try { target = new URL(probe || '/healthz', origin + '/'); }
  catch { return { ok: false, verdict: 'inconclusive', error: '地址无法解析' }; }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { ok: false, verdict: 'negative', error: '仅允许 http/https' };
  }
  if (isUnsafeHostname(target.hostname)) {
    return { ok: false, verdict: 'negative', error: '拒绝内网/环回/保留地址' };
  }

  const started = Date.now();
  const outcome = await safeFetch(target.href, {
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': 'stronghold-list-verify/1' },
    signal: AbortSignal.timeout(Math.min(timeoutMs || VERIFY_TIMEOUT_MS, 20000)),
  }, 0);
  if (outcome.error) {
    return { ok: false, verdict: classifyProbeFailure(outcome.error), error: outcome.error };
  }
  const res = outcome.res;
  if (!res.ok) {
    const err = `${probe} 返回 ${res.status}`;
    return { ok: false, verdict: classifyProbeFailure(err), error: err };
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const err = `${probe} 响应不是 JSON`;
    return { ok: false, verdict: classifyProbeFailure(err), error: err };
  }

  const text = await res.text();
  if (text.length > MAX_HEALTH_BYTES) {
    return { ok: false, verdict: 'inconclusive', error: `${probe} 响应过大` };
  }
  let body;
  try { body = JSON.parse(text); }
  catch { return { ok: false, verdict: 'inconclusive', error: `${probe} 响应不是有效 JSON` }; }

  const reasons = [];
  if (body.ok !== true) reasons.push('ok 字段不是 true');

  // Variant detection: the node/server build uses a numeric protocol version while the
  // cloudflare workers build puts the app release string ("0.1.0") in `version` and
  // carries a git `build` hash instead. VERSION IS NOT ENFORCED any more (user decision
  // 2026-10-03): the server is only *labelled* with the app/build it reports, so servers
  // on older or newer builds stay listed instead of being hidden.
  let rooms = null;
  let humans = null;
  let app = body.app || (typeof body.version === 'string' ? body.version : null);
  let build = null;
  const isWorkers = body.runtime === 'cloudflare' || typeof body.version === 'string';
  if (isWorkers) {
    if (typeof body.build === 'string' && /^[0-9a-f]{6,40}$/i.test(body.build)) {
      build = body.build;
    }
    // app 只放真正的版本号（workers 版把它写在 version 里）。以前这里回落到 build 哈希，
    // 于是哈希会被拼成「v5d1154951c87」这种版本号显示出去 —— 版本号与构建哈希是两回事。
    if (typeof app !== 'string' || !/^\d+(\.\d+){1,3}/.test(app)) app = null;
  } else {
    for (const field of HEALTH_FIELDS) {
      const value = body[field];
      if (typeof value !== 'number' || !Number.isFinite(value)) reasons.push(`缺少字段 ${field}`);
    }
    rooms = body.rooms;
    humans = body.humans;
  }
  // Identity gate: must be recognisably a Stronghold Protocol server, but any app/build
  // version passes and is only recorded for display.
  if (reasons.length) {
    const err = `不是卫戍协议服务器（${reasons.join('、')}）`;
    return { ok: false, verdict: classifyProbeFailure(err), error: err };
  }

  return { ok: true, elapsedMs: Date.now() - started, rooms, humans, app, build,
           variant: isWorkers ? 'workers' : 'node', probePath: target.pathname };
}

const ENTRY_TIMEOUT_MS = 4000;

/**
 * 清单里那条**玩家真正会点开的地址**本身打得开吗？
 * 健康端点只证明「后端在应答」：game.rainya.me 的 `/api/status` 一直 200，而 `/play` 是
 * nginx 502 —— 绿灯行 + 打不开的页面。所以闸门必须单独打一次原样地址（path 与 query 都保留，
 * `?room=CODE` 深链也是玩家会用的形态）。
 * 判据刻意收紧：只有 5xx 或连不上算坏；4xx 说明网关和路由都活着，是应用层在回应。
 */
export async function checkEntryUrl(rawUrl, timeoutMs) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { return { ok: false, status: null, error: '入口地址无法解析' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, status: null, error: '入口仅允许 http/https' };
  if (url.username || url.password) return { ok: false, status: null, error: '入口地址含账号密码' };
  if (isUnsafeHostname(url.hostname)) return { ok: false, status: null, error: '入口拒绝内网地址' };

  const cacheKey = 'entry:' + url.href;
  const hit = cache.get(cacheKey);
  if (hit && hit.verdict && Date.now() - hit.at < CACHE_TTL_MS) return hit.verdict;

  const outcome = await safeFetch(url.href, {
    method: 'GET',
    headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8', 'user-agent': 'stronghold-list-verify/1' },
    signal: AbortSignal.timeout(Math.min(timeoutMs || ENTRY_TIMEOUT_MS, 8000)),
  }, 0);
  let verdict;
  if (outcome.error) {
    // 超时/连接失败/重定向异常都归入「入口不可达」，与健康端点的结果分开表述
    verdict = { ok: false, status: null, error: '入口不可达（' + outcome.error + '）' };
  } else {
    const status = outcome.res.status;
    try { if (outcome.res.body) await outcome.res.body.cancel(); } catch { /* 体不读，省流量 */ }
    verdict = status >= 500
      ? { ok: false, status, error: `入口返回 ${status}` }
      : { ok: true, status, error: null };
  }
  cache.set(cacheKey, { verdict, at: Date.now() });
  return verdict;
}

/** Validate a submitted entry list (shared by submit & publish endpoints). */
export function validateEntries(servers) {
  if (!Array.isArray(servers) || !servers.length) return { error: 'servers[] 不能为空' };
  if (servers.length > 64) return { error: '一次最多 64 条' };
  const seen = new Set();
  const cleaned = [];
  for (const entry of servers) {
    if (!entry || typeof entry !== 'object') return { error: '条目格式错误' };
    // 先归一化再校验：`dx.frp-gap.com:29943`、`HTTPS://Host//` 这类玩家手打的形态以前会在
    // new URL() 上直接抛"地址无法解析"，等于把能进游戏的服务器挡在门外（见 normalizeTarget）。
    const norm = normalizeTarget(entry.url);
    if (norm.error) return { error: `${String(entry.url || '(空)').trim() || '(空)'}：${norm.error}` };
    const check = validateUrl(norm.url);
    if (check.error) return { error: `${norm.url}：${check.error}` };
    if (seen.has(check.href)) return { error: `重复地址：${check.href}` };
    seen.add(check.href);

    const id = String(entry.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || `srv-${cleaned.length}`;
    const name = String(entry.name || check.host).trim().slice(0, 48) || check.host;
    // 匿名提交当场上签名清单，名字就是玩家在列表里看到的标题：带 U+FFFD（提交方编码错，
    // 中文经 curl/非 UTF-8 通道常见）或控制字符的一律退回，别等维护者发现。
    if (/[\uFFFD\u0000-\u001f\u007f]/.test(name)) {
      return { error: `${check.host}：服务器名称含无法识别的字符（多为提交端编码不对），请用 UTF-8 重新提交` };
    }
    const clean = { id, name, url: check.href, probe: '/healthz', enabled: entry.enabled !== false };
    if (typeof entry.probe === 'string' && entry.probe.length) {
      if (!entry.probe.startsWith('/') || /[\r\n]/.test(entry.probe)) return { error: '探针路径必须是相对路径' };
      clean.probe = entry.probe.slice(0, 64);
    }
    if (typeof entry.note === 'string' && entry.note.trim()) clean.note = entry.note.trim().slice(0, 48);
    // 国内直连可达、但 Cloudflare 出口拿 403 的服务器：由维护者留证后显式标记，见 verify.js
    if (entry.direct_cn === true) clean.direct_cn = true;
    cleaned.push(clean);
  }
  return { servers: cleaned };
}

export { validateUrl };

/* ---- 清单规范化：服务端 review 与本机 tools/sign-servers.mjs 必须用同一套规则 ---- */
export const UNSIGNED_FIELDS = ['sig', 'unsigned'];

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}

/**
 * 待签载荷：剔除 sig / unsigned，对象键递归按字典序，数组顺序保持不变，无多余空白，UTF-8。
 * `updated` 参与签名，所以「只改时间戳不改签名」在这里必然失效。
 */
export function canonicalPayload(doc) {
  const copy = { ...(doc || {}) };
  for (const k of UNSIGNED_FIELDS) delete copy[k];
  return JSON.stringify(sortDeep(copy));
}

/** 载荷的 sha256（十六进制），给维护者在设备上核对「我要签的就是这个」。 */
export async function payloadSha256(doc) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalPayload(doc)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 拆出 host 与去掉尾斜杠的路径（根路径记成 '/'）。解析不了返回 null。 */
export function splitUrlPath(u) {
  try { const x = new URL(u); return { host: x.host, path: x.pathname.replace(/\/+$/, '') || '/' }; }
  catch { return null; }
}

/**
 * 判重总入口：**一台 host 只留一条**，谁的路径更好就用谁。
 *   none      清单里没有同 host 的条目 → 当新条目收
 *   duplicate 已有等价或更好的那条（同 host 一律算同一台：路径相同、清单里存更深路径而来了裸根、
 *             或者两边是不同子路径 —— 一台机挂两个子路径也还是一家服）→ 不该再新增
 *   upgrade   清单那条是裸根、来的是更深路径 → 就地改 url，把玩家点得开的原样地址换上去
 */
export function listCollision(servers, incomingUrl) {
  const x = splitUrlPath(incomingUrl);
  if (!x) return { kind: 'none', index: -1 };
  const list = Array.isArray(servers) ? servers : [];
  for (let i = 0; i < list.length; i += 1) {
    const y = splitUrlPath(list[i] && list[i].url);
    if (!y || y.host !== x.host) continue;
    if (y.path === '/' && x.path !== '/') return { kind: 'upgrade', index: i };
    return { kind: 'duplicate', index: i };
  }
  return { kind: 'none', index: -1 };
}

/** 「清单存的是裸根、来的是更深路径」的判定，包一层 listCollision 让调用点读起来直接。 */
export function rootUpgradeIndex(servers, incomingUrl) {
  const c = listCollision(servers, incomingUrl);
  return c.kind === 'upgrade' ? c.index : -1;
}

const CLIENT_MARKERS = [/viewport-fit=cover/i, /\/vendor\//i, /STRONGHOLD PROTOCOL/i];

/** 这个地址像不像游戏客户端本体（而不是状态页/落地页/任意能打开的路径）。 */
export async function looksLikeClientPage(rawUrl, timeoutMs) {
  try {
    const res = await fetch(String(rawUrl), {
      headers: { 'user-agent': 'stronghold-dl-gate/1', accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs || 8000),
    });
    if (!res.ok) return false;
    const html = (await res.text()).slice(0, 20000);
    return CLIENT_MARKERS.filter((re) => re.test(html)).length >= 2;
  } catch { return false; }
}
