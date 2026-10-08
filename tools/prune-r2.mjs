// tools/prune-r2.mjs — 定时清理 R2 上「已经没人引用」的安装包（.apk）。
//
// 为什么需要：每次构建 ~600-750 MB，R2 免费额度 10 GB，几版就能顶到天花板（10-04 已到 10.7 GB）。
// 旧的 prune-r2.yml 只认 `stronghold-vX.Y.Z.apk` 这一种命名，而线上实际有四种
// （shell-v*、stronghold-v*、stronghold-v*-vcNNNN、re-stronghold-v*），实测**一个都不匹配**，
// 所以它每小时「成功」地什么都没删。这里改成**按指针判定**，不猜命名。
//
// 保留规则（三条并集，任一命中即保留）：
//   ① 指针指向的那一个：apk/latest.json、apk/latest-re.json 的 apkUrl（客户端更新检查读它们，
//      删了就等于把还在旧版本上的玩家挂断）；
//   ② 下载页当前会链接的那一个：https://dl.jiangjiangze.icu/api/latest 的 tag → 由 tag 推出
//      CDN 键（与 functions/api/_asset.js 的 r2Candidates 同一算法）；
//   ③ 每条命名线按修改时间最新的 N 个（默认 2，回滚余量）+ 最近 grace-hours 小时内写过的
//      （默认 24h，避免和正在进行的发布抢跑）。
//
// 永不触碰：apk/content-slim-*.zip（热更新载荷，客户端按 manifest 读）、apk/latest*.json、
// 以及 apk/ 之外的任何前缀（assets/、site/、fonts/ 等）。
//
// 安全闸（任一不满足就什么都不删，宁可留着）：
//   · 列举失败 / 列举为空 → 退出；
//   · 两个指针文件都读不到 → 退出（判定依据不足）；
//   · 本次待删数量超过 --max-delete（默认 8）→ 退出并打印清单，交人工确认。
//
// 用法：
//   node tools/prune-r2.mjs                  # 干跑，只打印会删什么
//   node tools/prune-r2.mjs --apply          # 真删
//   node tools/prune-r2.mjs --keep=3 --grace-hours=48
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

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const num = (flag, dflt) => {
  const hit = argv.find((a) => a.startsWith(flag + '='));
  const v = hit ? Number(hit.split('=')[1]) : dflt;
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};
const KEEP_PER_FAMILY = num('--keep', 2);
const GRACE_HOURS = num('--grace-hours', 6);
const MAX_DELETE = num('--max-delete', 8);

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

async function readJson(key) {
  const res = await request('GET', '/' + BUCKET + '/' + key.split('/').map(qencode).join('/'), '');
  if (res.status !== 200) return null;
  try { return JSON.parse(res.body.toString()); } catch { return null; }
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
    // 进程退出时留着未清的定时器句柄，会触发 libuv 断言并让退出码变 1（CI 是 Linux 不受影响，
    // 但本地干跑会误报失败）。
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

/** 命名线：决定「同一条线的最近 N 个」怎么分组。 */
function familyOf(key) {
  const name = key.slice(APK_PREFIX.length);
  if (name.startsWith('re-stronghold-')) return 're';
  if (name.startsWith('shell-v')) return 'shell';
  if (name.startsWith('stronghold-')) return 'bare';
  return 'other';
}

// ---- 主流程 -------------------------------------------------------------------------
// 包成函数是为了能 `return` 收尾而不是 process.exit()：Windows 上 undici 的连接句柄还没排空
// 就强杀进程会触发 libuv 断言（stderr 一行 Assertion failed）并把退出码搞乱。让它自然结束最干净。
async function main() {
  const all = await listAll(APK_PREFIX);
  const apks = all.filter((o) => o.key.endsWith('.apk'));
  if (!apks.length) {
    console.log('列举到 0 个 apk 对象 —— 判定依据不足，不做任何删除。');
    return;
  }

  const keep = new Map(); // key → 理由
  const addKeep = (key, why) => { if (key && apks.some((a) => a.key === key)) keep.set(key, why); };

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

  const pageKeys = await pageTarget();
  for (const k of pageKeys) addKeep(APK_PREFIX + k, '下载页当前链接');
  // 取不到就多留一个当余量：下载页链接的通常就是"最新那个"，但页面可能滞后于最新构建
  // （实测 10-08：页面还在链 vc2004，而桶里最新已是 vc2006）。少一条依据时宁可多留。
  const keepPerFamily = pageKeys.length ? KEEP_PER_FAMILY : KEEP_PER_FAMILY + 1;
  if (!pageKeys.length) {
    console.log(`（提示：未能从站点 /api/latest 取到 tag —— 少一条保留依据，本次每条线多留 1 个，即 ${keepPerFamily} 个）`);
  }

  // 每条线按修改时间最新的 N 个
  const byFamily = new Map();
  for (const a of apks) {
    const f = familyOf(a.key);
    if (!byFamily.has(f)) byFamily.set(f, []);
    byFamily.get(f).push(a);
  }
  for (const [f, list] of byFamily) {
    list.sort((a, b) => String(b.lm).localeCompare(String(a.lm)));
    list.slice(0, keepPerFamily).forEach((a) => addKeep(a.key, `${f} 线最新 ${keepPerFamily} 个之一`));
  }

  // grace：最近写过的一律先留着（发布流水线可能正在写）
  const cutoff = Date.now() - GRACE_HOURS * 3600e3;
  for (const a of apks) {
    if (Date.parse(a.lm) >= cutoff) addKeep(a.key, `${GRACE_HOURS}h 内写过`);
  }

  const doomed = apks.filter((a) => !keep.has(a.key));
  const doomedMB = doomed.reduce((s, a) => s + a.size, 0) / 1e6;

  console.log(`apk 对象 ${apks.length} 个 / ${(apks.reduce((s, a) => s + a.size, 0) / 1e6).toFixed(0)} MB；保留 ${keep.size}，待删 ${doomed.length}（${doomedMB.toFixed(0)} MB）`);
  console.log('保留：');
  for (const a of apks.filter((x) => keep.has(x.key)).sort((x, y) => x.key.localeCompare(y.key))) {
    console.log(`  KEEP  ${(a.size / 1e6).toFixed(0).padStart(4)}MB  ${a.lm.slice(0, 10)}  ${a.key}  ← ${keep.get(a.key)}`);
  }
  if (!doomed.length) { console.log('没有需要清理的对象。'); return; }
  console.log('待删：');
  for (const a of doomed) console.log(`  DEL   ${(a.size / 1e6).toFixed(0).padStart(4)}MB  ${a.lm.slice(0, 10)}  ${a.key}`);

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
