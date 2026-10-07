#!/usr/bin/env node
/* ==========================================================================================
   tls-probe.mjs —— 证书旁路探针（第三种探测方法）

   为什么需要它：Cloudflare 的 fetch **没有**"忽略证书"开关。源站是自签证书时
   （SakuraFrp / 零度一类的隧道给的自动证书），CF 边缘在 TLS 握手就断 → 只拿得到 525/526，
   于是服务器活着、玩家进得去，站点却永远"看不见"它。dx.frp-gap.com:29943 就是这一类。

   本脚本跑在**能关校验的地方**（GitHub Runner 或本机盒子），且只补"看不见"这一格：
     · 先按严格校验打，握手失败才降级成 rejectUnauthorized:false（只对这个请求的 agent，
       绝不设全局 NODE_TLS_REJECT_UNAUTHORIZED）；
     · 只有读到 **ok:true + 协议字段** 的完整指纹才写进报告 —— 拿不到指纹就等于没验过；
     · 内网/环回/保留地址一律拒绝，和站点同一套口径。

   谁消费报告：functions/api/_verify.js 的 readProbeReports()（12 小时有效期）→
   submit / review / verify 三处据此放行，并把来源写成 attested_by:'tls-probe'。

   风险边界（说清楚，别当没发生）：关掉校验意味着这一路**不验证服务器的真实身份**，
   中间人理论上能冒充一台"看起来合法"的卫戍服。它换来的只是"CF 因证书拒握手"这一类不再
   被误判为死服；清单里每条都因此带上 attested_by:'tls-probe'，站长随时可按同一地址复核或下架。
   所以三条硬约束：只补 inconclusive（边缘**看见它不是**卫戍协议时绝不翻案）、只信完整协议指纹、
   内网/环回/保留地址一律拒（SSRF 防线与站点同规则）。

   用法：
     node tools/tls-probe.mjs --dir _probe            # CI：读 dir 下的三个 json，写 dir/probes.json
     node tools/tls-probe.mjs --live                  # 本机：从公开 R2 域名读，结果只写本地文件
     node tools/tls-probe.mjs --dir _probe --only URL  # 手工复查某一条
     可选：--max 40 --paths /healthz,/api/status,... --out <file> --quiet
   ========================================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const R2 = 'https://weishucdn.jiangjiangze.icu/site';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : (i >= 0 ? true : def);
};
const live = !!flag('live', false);
const dir = String(flag('dir', path.resolve(HERE, '..', '_probe')));
const outFile = String(flag('out', '')) || path.join(dir, 'probes.json');
const only = String(flag('only', '') || '');
const MAX = Math.max(1, Number(flag('max', 40)) || 40);
const TIMEOUT_MS = 10000;
const PATHS = String(flag('paths', '/healthz,/api/status,/api/health,/health')).split(',').map((s) => s.trim()).filter(Boolean);
const quiet = !!flag('quiet', false);
const log = (...a) => { if (!quiet) console.log(...a); };

/* ---- SSRF 防线（与 functions/api/_verify.js 的 isUnsafeHostname 同规则） ---------------- */
const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./, /^172\.(1[6-9]|2[0-9]|3[01])\./];
function isUnsafeHostname(raw) {
  const h = String(raw || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.startsWith('[')) {
    const v6 = h.slice(1, -1);
    if (v6 === '::1' || v6 === '::') return true;
    return /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
  }
  if (h === '0.0.0.0') return true;
  return PRIVATE_V4.some((re) => re.test(h));
}

const HEALTH_FIELDS = ['uptimeSec', 'sockets', 'sessions', 'rooms', 'matches', 'humans', 'bots'];
/** 与站点 looksLikeProtocolFingerprint 同一判据：报告里没有完整指纹就等于没验过。 */
function isProtocolFingerprint(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.ok !== true) return false;
  if (body.runtime === 'cloudflare' || typeof body.version === 'string') return true;
  if (!Number.isInteger(body.version)) return false;
  return HEALTH_FIELDS.some((f) => Number.isFinite(body[f]));
}

/** 归一化成站点侧 probeKey 的口径，保证报告能被查到。 */
function probeKey(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  let url;
  try { url = new URL(s); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.search = ''; url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  const href = url.href.replace(/\/+$/, '');
  return href || url.href;
}

/* ---- 抓取 ----------------------------------------------------------------------------- */
const AGENT_STRICT = new https.Agent({ rejectUnauthorized: true, keepAlive: false });
const AGENT_LOOSE = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

function get(urlStr, { loose = false, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(urlStr); } catch { return resolve({ error: '地址无法解析' }); }
    if (isUnsafeHostname(url.hostname)) return resolve({ error: '拒绝内网/环回/保留地址' });
    const mod = url.protocol === 'https:' ? https : http;
    const started = Date.now();
    const req = mod.get(url, {
      agent: url.protocol === 'https:' ? (loose ? AGENT_LOOSE : AGENT_STRICT) : undefined,
      headers: { accept: 'application/json', 'user-agent': 'stronghold-list-tls-probe/1' },
      timeout,
      servername: url.hostname,           // 自签证书的 SAN 里通常带着域名，SNI 要给全
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (text.length < 200000) text += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '',
                                    text, ms: Date.now() - started, redirected: res.headers.location || null }));
    });
    req.on('timeout', () => { req.destroy(new Error('超时')); });
    req.on('error', (err) => resolve({ error: err && (err.code || err.message) || '请求失败',
                                       certError: /UNTRUSTED|SELF_SIGNED|CERT|HANDSHAKE|SSL|VERIFY|UNABLE_TO/i.test(String((err && (err.code || err.message)) || '')),
                                       ms: Date.now() - started }));
  });
}

/** 严格打一次；只有失败原因确实是证书，才降级成旁路再打 —— 这一步是本脚本的全部意义。 */
async function getEither(urlStr) {
  const strict = await get(urlStr, { loose: false });
  if (!strict.error) return { ...strict, tls: 'ok' };
  if (!strict.certError) return { ...strict, tls: strict.error };
  const loose = await get(urlStr, { loose: true });
  return { ...loose, tls: loose.error ? `bypass-failed(${loose.error})` : 'untrusted-leaf', bypassed: true };
}

async function probeEntry(originUrl) {
  let base;
  try { base = new URL(originUrl); } catch { return { ok: false, error: '地址无法解析' }; }
  const root = `${base.protocol}//${base.host}/`;
  const tried = [];
  for (const p of PATHS) {
    let target;
    try { target = new URL(p, root); } catch { continue; }
    if (target.host !== base.host) continue;              // 只打这台自己的 host
    const r = await getEither(target.href);
    if (r.status === 200 && /json/i.test(r.type || '')) {
      let body = null;
      try { body = JSON.parse(r.text); } catch { body = null; }
      if (isProtocolFingerprint(body)) {
        const entry = await getEither(originUrl);          // 顺手测玩家真正会点的那条入口
        return { ok: true, probePath: p, fingerprint: body, tls: r.tls, bypassed: !!r.bypassed,
                 entryOk: !entry.error && entry.status < 500, entryStatus: entry.status || null,
                 ms: r.ms, tried };
      }
      tried.push({ path: p, status: 200, note: 'JSON 但不是协议指纹' });
    } else if (r.error) tried.push({ path: p, error: r.error });
    else tried.push({ path: p, status: r.status, type: (r.type || '').slice(0, 24) });
  }
  return { ok: false, error: tried.length ? tried.map((t) => `${t.path} ${t.status || t.error || t.note || ''}`.trim()).join('；')
                                          : '没有可打的候选路径', tried };
}

/* ---- 并发闸 --------------------------------------------------------------------------- */
async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const lanes = Array.from({ length: Math.max(1, limit) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(lanes);
  return out;
}

const readJson = async (name) => {
  if (live) {
    try {
      const res = await fetch(`${R2}/${name}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }
  const p = path.join(dir, name);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

async function main() {
  const [list, verified, recheck, previous] = await Promise.all([
    readJson('servers.json'), readJson('verified.json'), readJson('recheck.json'), readJson('probes.json'),
  ]);
  if (!list || !Array.isArray(list.servers)) { console.error('读不到 servers.json'); process.exit(2); }

  const reports = (previous && previous.reports && typeof previous.reports === 'object') ? previous.reports : {};
  const now = Date.now();
  const fresh = (key) => {
    const r = reports[key];
    const at = Date.parse((r && r.at) || '');
    return !!r && r.ok === true && Number.isFinite(at) && now - at < 6 * 3600 * 1000;
  };

  // 目标：① 站点现在判为 invalid 的清单条目（边缘看不见的那些）；② 暂存区登记的待复核地址。
  const targets = [];
  const push = (url, from) => {
    const key = probeKey(url);
    if (!key) return;
    if (only ? key !== probeKey(only) : fresh(key)) return;
    if (targets.some((t) => t.key === key)) return;
    targets.push({ key, url: key, from });
  };
  const invalidIds = new Set(((verified && verified.invalid) || []).map((i) => i && i.id));
  if (only) push(only, 'manual');                 // 手工复查一条：不在清单/待复核里也要能打
  // 待复核的排在前面：那些地址还没进签名清单，verify 轮永远看不到它们，只有这里会管
  for (const item of ((recheck && recheck.items) || [])) push(item.url, 'recheck');
  for (const s of list.servers) if (invalidIds.has(s.id) || only) push(s.url, 'list-invalid');
  const chosen = targets.slice(0, MAX);
  log(`目标 ${chosen.length} 条（清单失效 ${list.servers.filter((s) => invalidIds.has(s.id)).length} + 待复核 ${(recheck && recheck.items || []).length}，跳过已有新报告）`);

  const results = await mapLimit(chosen, 6, async (t) => {
    const r = await probeEntry(t.url);
    if (r.ok) {
      reports[t.key] = {
        at: new Date().toISOString(), ok: true, source: 'github-tls-probe',
        probePath: r.probePath, tls: r.tls, entryOk: r.entryOk, entryStatus: r.entryStatus,
        // 站点只认这几项，别的字段它自己会剥掉
        version: r.fingerprint.version, runtime: r.fingerprint.runtime,
        app: r.fingerprint.app, build: r.fingerprint.build,
        uptimeSec: r.fingerprint.uptimeSec, sockets: r.fingerprint.sockets,
        sessions: r.fingerprint.sessions, rooms: r.fingerprint.rooms,
        matches: r.fingerprint.matches, humans: r.fingerprint.humans, bots: r.fingerprint.bots,
      };
      log(`  ✓ ${t.key} ← ${r.probePath}（${r.fingerprint.app || 'version ' + r.fingerprint.version}${r.bypassed ? '，证书旁路' : ''}）`);
    } else {
      reports[t.key] = { at: new Date().toISOString(), ok: false, source: 'github-tls-probe', reason: String(r.error).slice(0, 90), tls: r.tls || null };
      log(`  ✗ ${t.key} —— ${String(r.error).slice(0, 90)}`);
    }
    return r.ok;
  });

  const hit = results.filter(Boolean).length;
  // 本轮确认过的地址从待复核清单里摘掉（没确认的留着下轮再试），别让它无限堆着；
  // 两周还没验上的也一并丢掉 —— 那基本就是彻底没了的服。
  const recheckItems = Array.isArray(recheck && recheck.items) ? recheck.items : [];
  const kept = recheckItems.filter((it) => {
    const key = probeKey(it && it.url);
    if (!key || (reports[key] && reports[key].ok === true)) return false;
    const at = Date.parse((it && it.at) || '');
    return !(Number.isFinite(at) && now - at > 14 * 864e5);
  });
  if (!live && recheckItems.length) {
    fs.writeFileSync(path.join(dir, 'recheck.json'),
      JSON.stringify({ updated: new Date().toISOString(), items: kept }, null, 2) + '\n', 'utf8');
  }
  // 报告只留 7 天：站点侧本来就 12 小时过期，堆着没意义
  for (const k of Object.keys(reports)) {
    const at = Date.parse(reports[k].at || '');
    if (!Number.isFinite(at) || now - at > 7 * 864e5) delete reports[k];
  }
  const doc = JSON.stringify({ updated: new Date().toISOString(), source: 'tools/tls-probe.mjs',
    note: '证书旁路探针的读数，只有带完整协议指纹的条目会被站点采信（12 小时内）', reports }, null, 2) + '\n';
  if (live) {
    fs.writeFileSync(path.resolve(HERE, '..', '_probe-report.json'), doc, 'utf8');
    log(`--live 模式只写本地 _probe-report.json（${Object.keys(reports).length} 条报告，本轮确认 ${hit}）；上传由 CI 里的 rclone 负责`);
  } else {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, doc, 'utf8');
    log(`已写 ${outFile}：${Object.keys(reports).length} 条报告，本轮确认 ${hit}/${chosen.length}`);
  }
}

main().catch((err) => { console.error('tls-probe 失败：', err && err.stack || err); process.exit(1); });
