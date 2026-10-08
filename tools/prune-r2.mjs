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
//   ③ **每种只留最新 --keep 个（默认 2）**：APK 与热更包各按**版本号**排序（不是 mtime ——
//      否则会把"同一构建的旧命名别名"当成第 2 名留下，真构建反而被删），无版本号的遗留名排最后。
//   再叠一个 --grace-hours（默认 2 小时）窗口：刚写进来的先留着，防和正在进行的发布抢跑。
//
// 永不触碰：apk/latest*.json、apk/ 之外的任何前缀（assets/、site/、upstream/ 是构建要用的
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
//   node tools/prune-r2.mjs --keep=2 --grace-hours=2
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
// 只认**生产**清单指针。测试通道的清单（manifest-test*.json）不在此列：它的 slim 在 `apk-test/`
// 前缀下（line.mjs 的 TEST_SLIM_PREFIX），而线上那份还停在旧约定、引用着 apk/ 里的老 slim ——
// 认它会把一个早已没人读的 9MB 老包永久保住。
const MANIFESTS = ['site/manifest.json', 'site/manifest-re.json'];

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
const KEEP_PER_KIND = num(['--keep'], 2);
// 宽限窗口默认 0：**在途发布已由"最新 N 个 + 指针/清单引用"两条规则覆盖**（发布链是先传对象、
// 后写指针，所以新对象一定是最新的、一定被留），再叠一个窗口只会让桶里短期多于 N 个、挡住目标。
// 需要时可用 --grace-hours=N 打开。
const GRACE_HOURS = num(['--grace-hours', '--age-hours'], 0); // --age-hours 是旧名，保留兼容
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

function requestOnce(method, uri, query, payload) {
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

/** 带重试：本机/CI 到 R2 的连接会被代理或网络抖动掐断（socket hang up / ECONNRESET），
 *  一次瞬时错误不该让整轮定时清理半途而废 —— 之前实测每轮都在删到一半时中断。
 *  幂等（GET/DELETE），重试安全。 */
async function request(method, uri, query, payload = Buffer.alloc(0)) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await requestOnce(method, uri, query, payload);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
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

/** 种类：APK 与热更包各留 --keep 个。 */
function kindOf(key) {
  return key.startsWith(APK_PREFIX + 'content-slim-') ? 'slim' : 'apk';
}

/**
 * 版本排序键（越大越新）。**按版本号而不是 mtime**：同一构建常以两个名字并存
 * （`stronghold-v0.2.1-vc2009.apk` 与遗留别名 `re-stronghold-v0.2.1.apk` 同批写入），
 * 只按 mtime 排会把别名当成"第 2 新"留下、把真正的上一个构建（vc2008）删掉。
 *   · `-vc<版本码>.apk`  → 1e9 + 版本码（本线的正式命名）
 *   · `-vX.Y.Z.apk`      → 1e6 + 版本号（旧线 shell-v2.9.31 这类）
 *   · 无版本号的遗留名    → 0（永远排最后，优先被清掉）
 */
function rankOf(key) {
  const vc = /-vc(\d{1,6})\.apk$/.exec(key);
  if (vc) return 1e9 + Number(vc[1]);
  const sem = /-v(\d{1,4})\.(\d{1,4})\.(\d{1,4})\.apk$/.exec(key);
  if (sem) return 1e6 + Number(sem[1]) * 1e4 + Number(sem[2]) * 1e2 + Number(sem[3]);
  const z = /-v(\d{1,4})\.(\d{1,4})\.(\d{1,4})\.zip$/.exec(key);   // slim: content-slim-shell-vX.Y.Z.zip
  if (z) return 1e6 + Number(z[1]) * 1e4 + Number(z[2]) * 1e2 + Number(z[3]);
  return 0;
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
  const keepPerKind = pageKeys.length ? KEEP_PER_KIND : KEEP_PER_KIND + 1;
  if (!pageKeys.length) {
    console.log(`（提示：未能从站点 /api/latest 取到 tag —— 少一条保留依据，本次每种多留 1 个，即 ${keepPerKind} 个）`);
  }

  const slimRefs = new Set();
  for (const mf of MANIFESTS) {
    const text = await readText(mf).catch(() => null);
    if (!text) continue;
    for (const m of text.match(/content-slim-[A-Za-z0-9._-]+\.zip/g) || []) slimRefs.add(m);
  }
  for (const name of slimRefs) addKeep(APK_PREFIX + name, '清单引用');
  console.log(`（清单引用到 ${slimRefs.size} 个 slim：${[...slimRefs].join(', ') || '无'}）`);

  // ③ 每种只留最新 N 个（按版本号排序，mtime 只作同版本内的次序）
  const byKind = new Map();
  for (const a of targets) {
    const k = kindOf(a.key);
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(a);
  }
  for (const [kind, list] of byKind) {
    list.sort((a, b) => (rankOf(b.key) - rankOf(a.key)) || String(b.lm).localeCompare(String(a.lm)));
    list.slice(0, keepPerKind).forEach((a) => addKeep(a.key, `${kind} 最新 ${keepPerKind} 个之一`));
  }

  // 宽限窗口：刚写进来的先留着（防和正在进行的发布抢跑）
  const cutoff = Date.now() - GRACE_HOURS * 3600e3;
  for (const a of targets) {
    if (Date.parse(a.lm) >= cutoff) addKeep(a.key, `${GRACE_HOURS}h 内写过`);
  }

  const doomed = targets.filter((a) => !keep.has(a.key));
  const doomedMB = doomed.reduce((s, a) => s + a.size, 0) / 1e6;
  const sumMB = (list) => (list.reduce((s, a) => s + a.size, 0) / 1e6).toFixed(0);

  console.log(`目标 ${targets.length} 个（apk ${apkCount} + slim ${slimCount}）/ ${sumMB(targets)} MB；`
    + `保留 ${keep.size}，待删 ${doomed.length}（${doomedMB.toFixed(0)} MB）；每种留 ${keepPerKind} 个 + ${GRACE_HOURS}h 宽限`);
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
