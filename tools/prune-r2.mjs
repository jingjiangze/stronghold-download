// tools/prune-r2.mjs — 定时清理 R2 上「已经没人引用」的安装包（.apk）与热更新包（content-slim-*.zip）。
//
// 为什么需要：每次构建 APK ~600-750 MB、slim ~13 MB，R2 免费额度 10 GB，几版就能顶到天花板
// （10-04 到过 10.7 GB）。旧的 prune-r2.yml 只认 `stronghold-vX.Y.Z.apk` 一种命名，而桶里实际有
// 四种 APK 命名 + 一种 slim 命名，实测**一个都不匹配**，每小时"成功"地什么都没删。
//
// 保留规则（三条并集，任一命中即保留）：
//   ① 指针指向的：apk/latest.json、apk/latest-re.json 的 apkUrl（客户端更新检查读它们）；
//   ② 清单引用的：site/manifest*.json 正文里出现的 content-slim-*.zip（热更链按 manifest 取包）；
//      以及下载页当前会链接的 CDN 键（站点 /api/latest 的 tag → 按 _asset.js r2Candidates 同算法）；
//   ③ 每条命名线**最新 1 个**（安全底线：安静期也不至于把某条线唯一的构建删掉）。
// 其余按**年龄**清理：修改时间早于 --age-hours（默认 12 小时）的删除；更新的先留着
// （发布流水线可能正在写，且给刚发布的包一个缓冲窗口）。
//
// 永不触碰：apk/latest*.json、apk/ 之外的任何前缀（assets*/、site/、upstream/ 是构建要用的
// 上游源码包、apk-test/ 是测试通道）。
//
// 安全闸（任一不满足就什么都不删，宁可留着）：
//   · 列举失败 / 列举为空 → 退出；
//   · 两个指针文件都读不到 → 退出（判定依据不足）；
//   · 本次待删数量超过 --max-delete（默认 80）→ 退出并打印清单，交人工确认。
//
// 用法：
//   node tools/prune-r2.mjs                     # 干跑，只打印会删什么
//   node tools/prune-r2.mjs --apply             # 真删
//   node tools/prune-r2.mjs --age-hours=24 --keep=2
//
// 凭证：环境变量 R2_ACCESS_KEY / R2_SECRET_KEY / R2_ENDPOINT，否则读 ~/.cf_r2_creds。

import { createHash, createHmac } from 'node:crypto';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BUCKET = process.env.R2_BUCKET || 'stronghold-assets';
const APK_PREFIX = 'apk/';
const SITE_API = 'https://dl.jiangjiangze.icu/api/latest';
const MANIFESTS = ['site/manifest.json', 'site/manifest-re.json', 'site/manifest-test.json', 'site/manifest-test-re.json'];

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const num = (flags, dflt) => {
  for (const flag of flags) {
    const hit = argv.find((a) => a.startsWith(flag + '='));
    if (hit) {
      const v = Number(hit.split('=')[1]);
      if (Number.isFinite(v) && v >= 0) return v;
    }
  }
  return dflt;
};
const KEEP_PER_FAMILY = num(['--keep'], 1);
const AGE_HOURS = num(['--age-hours', '--grace-hours'], 12); // --grace-hours 是旧名，保留兼容
const MAX_DELETE = num(['--max-delete'], 80);

// ---- 凭证 ---------------------------------------------------------------------------
function loadCreds() {
  if (process.env.R2_ACCESS_KEY && process.env.R2_SECRET_KEY && process.env.R2_ENDPOINT) {
    return { ak: process.env.R2_ACCESS_KEY, sk: process.env.R2_SECRET_KEY, ep: process.env.R2_ENDPOINT };
  }
  const path = join(homedir(), '.cf_r2_creds');
  const kv = Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
  if (!kv.r2_access_key || !kv.r2_secret || !kv.r2_endpoint) throw new Error('凭证不全：' + path);
  return { ak: kv.r2_access_key, sk: kv.r2_secret, ep: kv.r2_endpoint };
}

const creds = loadCreds();
const HOST = new URL(creds.ep).host;
const REGION = 'auto';
const hmac = (k, m) => createHmac('sha256', typeof k === 'string' ? Buffer.from(k) : k).update(m).digest();
const qencode = (s) => String(s).split('').map((c) => (/[A-Za-z0-9\-._~]/.test(c) ? c
  : [...Buffer.from(c, 'utf8')].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''))).join('');

function sign(method, uri, query, payload) {
  const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const ds = amz.slice(0, 8);
  const ph = createHash('sha256').update(payload).digest('hex');
  const all = { host: HOST, 'x-amz-content-sha256': ph, 'x-amz-date': amz };
  const names = Object.keys(all).sort();
  const ch = names.map((k) => k + ':' + all[k] + '\n').join('');
  const cr = [method, uri, query, ch, names.join(';'), ph].join('\n');
  const scope = ds + '/' + REGION + '/s3/aws4_request';
  let k = hmac('AWS4' + creds.sk, ds);
  for (const part of [REGION, 's3', 'aws4_request']) k = hmac(k, part);
  const sts = ['AWS4-HMAC-SHA256', amz, scope, createHash('sha256').update(cr).digest('hex')].join('\n');
  return { ...all, Authorization: 'AWS4-HMAC-SHA256 Credential=' + creds.ak + '/' + scope
    + ', SignedHeaders=' + names.join(';') + ', Signature=' + hmac(k, sts).toString('hex') };
}

function request(method, uri, query, payload = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    const path = query ? uri + '?' + query : uri;
    const req = https.request({ host: HOST, path, method, headers: sign(method, uri, query, payload) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end(payload);
  });
}

const qs = (pairs) => pairs.filter(([, v]) => v !== undefined).sort((a, b) => (a[0] < b[0] ? -1 : 1))
  .map(([k, v]) => k + '=' + qencode(v)).join('&');

// ---- R2 操作 ------------------------------------------------------------------------
async function listAll(prefix) {
  const out = [];
  let token;
  do {
    const q = qs([['list-type', '2'], ['max-keys', '1000'], ['prefix', prefix], ['continuation-token', token]]);
    const res = await request('GET', '/' + BUCKET, q);
    if (res.status !== 200) throw new Error('list ' + res.status + ' ' + res.body.toString().slice(0, 200));
    const body = res.body.toString();
    for (const m of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([^<]*)<\/Key>/.exec(m[1])[1];
      out.push({
        key,
        size: Number(/<Size>(\d+)<\/Size>/.exec(m[1])[1]),
        lm: /<LastModified>([^<]*)<\/LastModified>/.exec(m[1])[1],
      });
    }
    token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(body)?.[1];
  } while (token);
  return out;
}

async function readText(key) {
  const res = await request('GET', '/' + BUCKET + '/' + key.split('/').map(qencode).join('/'), '');
  return res.status === 200 ? res.body.toString() : null;
}

async function readJson(key) {
  const t = await readText(key);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

async function remove(key) {
  const res = await request('DELETE', '/' + BUCKET + '/' + key.split('/').map(qencode).join('/'), '');
  if (res.status !== 204 && res.status !== 200) throw new Error('delete ' + key + ' → ' + res.status);
}

/** 下载页当前会链接的 CDN 键：与 functions/api/_asset.js 的 r2Candidates 同算法。
 *  用全局 fetch（而不是 https.get）：本机 Clash 伪 IP 会让 Node 直连 Cloudflare 直接
 *  ECONNRESET，而 fetch 走 NODE_USE_ENV_PROXY=1 + HTTPS_PROXY 就能通（CI 里直连即可）。
 *  拿不到就返回空数组，调用方按"少一条依据、多留一个"处理。 */
async function pageTarget() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // 显式 AbortController + clearTimeout（不用 AbortSignal.timeout）：后者在 Windows 上
    // 进程退出时留着未清的定时器句柄，会触发 libuv 断言并让退出码变 1。
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(SITE_API, { headers: { accept: 'application/json' }, signal: ctrl.signal });
      if (!res.ok) continue;
      const tag = String((await res.json()).tag_name || '');
      if (!tag) continue;
      const bare = tag.replace(/^shell-/, '');
      return [`stronghold-${bare}.apk`, `${tag}.apk`];
    } catch { /* 重试 */ } finally { clearTimeout(timer); }
  }
  return [];
}

/** 命名线：决定「同一条线的最近 N 个」怎么分组。slim 与 APK 分开算。 */
function familyOf(key) {
  const name = key.slice(APK_PREFIX.length);
  if (name.startsWith('content-slim-')) return 'slim';
  if (name.startsWith('re-stronghold-')) return 're';
  if (name.startsWith('shell-v')) return 'shell';
  if (name.startsWith('stronghold-')) return 'bare';
  return 'other';
}

const isTarget = (key) => key.endsWith('.apk') || (key.startsWith(APK_PREFIX + 'content-slim-') && key.endsWith('.zip'));

// ---- 主流程 -------------------------------------------------------------------------
// 包成函数是为了能 `return` 收尾而不是 process.exit()：Windows 上 undici 的连接句柄还没排空
// 就强杀进程会触发 libuv 断言（stderr 一行 Assertion failed）并把退出码搞乱。让它自然结束最干净。
async function main() {
  const all = await listAll(APK_PREFIX);
  const targets = all.filter((o) => isTarget(o.key));
  const apkCount = targets.filter((o) => o.key.endsWith('.apk')).length;
  const slimCount = targets.length - apkCount;
  if (!targets.length) {
    console.log('列举到 0 个清理目标 —— 判定依据不足，不做任何删除。');
    return;
  }

  const keep = new Map(); // key → 理由数组（累积，不覆盖：同一对象常被多条规则同时命中）
  const addKeep = (key, why) => {
    if (!key || !targets.some((a) => a.key === key)) return;
    const list = keep.get(key) || [];
    if (!list.includes(why)) list.push(why);
    keep.set(key, list);
  };

  // ① 指针
  const pointers = [];
  for (const pf of ['apk/latest.json', 'apk/latest-re.json']) {
    const doc = await readJson(pf).catch(() => null);
    const url = doc && typeof doc.apkUrl === 'string' ? doc.apkUrl : '';
    const base = url ? url.split('/').pop().split(/[?#]/)[0] : '';
    if (base) { pointers.push(base); addKeep(APK_PREFIX + base, pf + ' 指向'); }
  }
  if (!pointers.length) {
    console.log('两个指针文件都读不到（latest.json / latest-re.json）—— 判定依据不足，不做任何删除。');
    return;
  }

  // ② 下载页当前链接 + 清单引用的 slim
  const pageKeys = await pageTarget();
  for (const k of pageKeys) addKeep(APK_PREFIX + k, '下载页当前链接');
  const keepPerFamily = pageKeys.length ? KEEP_PER_FAMILY : KEEP_PER_FAMILY + 1;
  if (!pageKeys.length) {
    console.log(`（提示：未能从站点 /api/latest 取到 tag —— 少一条保留依据，本次每条线多留 1 个，即 ${keepPerFamily} 个）`);
  }

  const slimRefs = new Set();
  for (const mf of MANIFESTS) {
    const text = await readText(mf).catch(() => null);
    if (!text) continue;
    for (const m of text.match(/content-slim-[A-Za-z0-9._-]+\.zip/g) || []) slimRefs.add(m);
  }
  for (const name of slimRefs) addKeep(APK_PREFIX + name, '清单引用');
  console.log(`（清单引用到 ${slimRefs.size} 个 slim：${[...slimRefs].join(', ') || '无'}）`);

  // ③ 每条线最新 N 个（安全底线）
  const byFamily = new Map();
  for (const a of targets) {
    const f = familyOf(a.key);
    if (!byFamily.has(f)) byFamily.set(f, []);
    byFamily.get(f).push(a);
  }
  for (const [f, list] of byFamily) {
    list.sort((a, b) => String(b.lm).localeCompare(String(a.lm)));
    list.slice(0, keepPerFamily).forEach((a) => addKeep(a.key, `${f} 线最新 ${keepPerFamily} 个之一`));
  }

  // 年龄窗口：比 AGE_HOURS 新的先留着
  const cutoff = Date.now() - AGE_HOURS * 3600e3;
  for (const a of targets) {
    if (Date.parse(a.lm) >= cutoff) addKeep(a.key, `${AGE_HOURS}h 内写过`);
  }

  const doomed = targets.filter((a) => !keep.has(a.key));
  const doomedMB = doomed.reduce((s, a) => s + a.size, 0) / 1e6;
  const sumMB = (list) => (list.reduce((s, a) => s + a.size, 0) / 1e6).toFixed(0);

  console.log(`目标 ${targets.length} 个（apk ${apkCount} + slim ${slimCount}）/ ${sumMB(targets)} MB；`
    + `保留 ${keep.size}，待删 ${doomed.length}（${doomedMB.toFixed(0)} MB）；年龄线 ${AGE_HOURS}h`);
  console.log('保留：');
  for (const a of targets.filter((x) => keep.has(x.key)).sort((x, y) => x.key.localeCompare(y.key))) {
    console.log(`  KEEP  ${(a.size / 1e6).toFixed(0).padStart(4)}MB  ${a.lm.slice(0, 10)}  ${a.key}  ← ${(keep.get(a.key) || []).join(' + ')}`);
  }
  if (!doomed.length) { console.log('没有需要清理的对象。'); return; }
  console.log(`待删（${doomed.length} 个）：`);
  for (const a of doomed.sort((x, y) => x.key.localeCompare(y.key))) {
    console.log(`  DEL   ${(a.size / 1e6).toFixed(0).padStart(4)}MB  ${a.lm.slice(0, 10)}  ${a.key}`);
  }

  if (doomed.length > MAX_DELETE) {
    console.log(`待删数量 ${doomed.length} 超过上限 ${MAX_DELETE} —— 中止（防误判批量删库），请人工确认后加 --max-delete 重跑。`);
    return;
  }
  if (!APPLY) { console.log('（干跑：未删除任何对象。加 --apply 真删。）'); return; }

  let freed = 0;
  for (const a of doomed) {
    await remove(a.key);
    freed += a.size;
    console.log('已删 ' + a.key);
  }
  console.log(`完成：删除 ${doomed.length} 个对象，释放 ${(freed / 1e6).toFixed(0)} MB。`);
}

await main();
