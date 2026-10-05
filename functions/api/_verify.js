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

/** Verify one server. Returns { ok:true } or { ok:false, error }. Results are cached
 *  per origin for CACHE_TTL_MS so the Function cannot be abused as a scan amplifier. */
const cache = new Map(); // in-memory per isolate; KV-free best-effort cache

export async function verifyServerHealth(origin, probe, timeoutMs) {
  const cacheKey = origin + (probe || '/healthz');
  const hit = cache.get(cacheKey);
  // A cached verdict must carry the same payload as a fresh one: returning only {ok:true}
  // used to blank rooms/humans/app for every server served from cache, and the list page
  // then wrote an occupancy doc with no version and no load.
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return Object.assign({ cached: true }, hit.verdict || (hit.ok ? {} : { ok: false, error: hit.error }));
  }

  let target;
  try { target = new URL(probe || '/healthz', origin + '/'); }
  catch { return fail(cacheKey, '地址无法解析'); }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return fail(cacheKey, '仅允许 http/https');
  }
  if (isUnsafeHostname(target.hostname)) return fail(cacheKey, '拒绝内网/环回/保留地址');

  const started = Date.now();
  const outcome = await safeFetch(target.href, {
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': 'stronghold-list-verify/1' },
    signal: AbortSignal.timeout(Math.min(timeoutMs || VERIFY_TIMEOUT_MS, 20000)),
  }, 0);
  if (outcome.error) return fail(cacheKey, outcome.error);
  const res = outcome.res;
  if (!res.ok) return fail(cacheKey, `/healthz 返回 ${res.status}`);

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return fail(cacheKey, '响应不是 JSON');

  const text = await res.text();
  if (text.length > MAX_HEALTH_BYTES) return fail(cacheKey, '响应过大');
  let body;
  try { body = JSON.parse(text); } catch { return fail(cacheKey, '响应不是有效 JSON'); }

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
  if (reasons.length) return fail(cacheKey, `不是卫戍协议服务器（${reasons.join('、')}）`);

  const verdict = { ok: true, elapsedMs: Date.now() - started, rooms, humans, app, build,
                    variant: isWorkers ? 'workers' : 'node' };
  cache.set(cacheKey, { ok: true, verdict, at: Date.now() });
  return verdict;
}

function fail(cacheKey, error) {
  cache.set(cacheKey, { ok: false, error, at: Date.now() });
  return { ok: false, error };
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
    const check = validateUrl(entry.url);
    if (check.error) return { error: `${entry.url || '(空)'}：${check.error}` };
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
