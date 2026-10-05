// POST|GET /api/tick —— 让外部闹钟（盒子上的计划任务）能拉起一轮云端采集
//
// 为什么不直接用 stronghold-scout Worker 的 /tick：那条地址在 *.workers.dev 上，
// 国内出口连不上（盒子实测三轮全是「无法连接到远程服务器」，而同轮的清单探测却正常）。
// dl.jiangjiangze.icu 在国内可达，所以这个入口放在站点侧。
//
// 口令只有一层，盒子只拿最弱的那把：
//   TICK_KEY   —— 只允许"启动一轮采集"，**只认 x-tick-key 头**（10-05 收口：以前也接受 ?key=，
//                  而 URL 会进 Cloudflare 的 URI 日志、浏览器历史与 Referer，等于把口令交给日志面；
//                  盒子 sp_cn_probe.ps1 用的就是头，收口不影响它）
//   GH_TICK_TOKEN —— 真正能创建 GitHub run 的口令，只待在 Pages secret 里
// 另外每 IP 限 6 次/分钟（含口令错的尝试），猜口令拿不到无限机会。
const DISPATCH = 'https://api.github.com/repos/jingjiangze/stronghold-scout'
  + '/actions/workflows/scout-schedule.yml/dispatches';
const ALLOWED = ['crawl', 'run', 'probe', 'bili'];
const HB_KEY = 'site/tick.json';
const HIT_KEY = 'site/tick-hits.json';
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 6;

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra || {}),
  });
}

/** R2 里那个域名是公开可读的，所以按 IP 分桶时先哈希，别把访问者地址直接写出去。 */
async function ipBucket(ip) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('tick|' + ip));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch {
    return 'shared';
  }
}

/** 每 IP 每分钟 RATE_MAX 次尝试。计数存不住就放行 —— 宁可少挡一次，也别把闹钟挡掉。 */
async function rateLimited(env, ip) {
  try {
    const now = Date.now();
    const bucket = await ipBucket(ip);
    const prev = await env.R2BUCKET.get(HIT_KEY);
    const doc = prev ? JSON.parse(await prev.text()) : {};
    const recent = (Array.isArray(doc[bucket]) ? doc[bucket] : []).filter((t) => now - Number(t) < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX) return true;
    recent.push(now);
    doc[bucket] = recent;
    for (const k of Object.keys(doc)) {
      const keep = (Array.isArray(doc[k]) ? doc[k] : []).filter((t) => now - Number(t) < RATE_WINDOW_MS * 5);
      if (keep.length) doc[k] = keep; else delete doc[k];
    }
    await env.R2BUCKET.put(HIT_KEY, JSON.stringify(doc), {
      httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
    });
    return false;
  } catch {
    return false;
  }
}

async function handle(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (env.R2BUCKET && await rateLimited(env, ip)) {
    return json({ ok: false, error: 'too many requests' }, 429, { 'retry-after': '60' });
  }
  const key = request.headers.get('x-tick-key') || '';
  if (!env.TICK_KEY || key !== env.TICK_KEY) return json({ ok: false, error: 'forbidden' }, 403);
  if (!env.GH_TICK_TOKEN) return json({ ok: false, error: '未配置 GH_TICK_TOKEN' }, 500);

  const target = url.searchParams.get('target') || 'crawl';
  if (!ALLOWED.includes(target)) return json({ ok: false, error: 'target 只能是 ' + ALLOWED.join('/') }, 400);
  const digits = (v) => String(v || '').replace(/\D/g, '').slice(0, 3);
  const inputs = { target, dry: url.searchParams.get('dry') === '1',
    pages: digits(url.searchParams.get('pages')), forks: digits(url.searchParams.get('forks')), tick_min: '' };

  let res, note = '';
  try {
    res = await fetch(DISPATCH, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { authorization: 'Bearer ' + env.GH_TICK_TOKEN, accept: 'application/vnd.github+json',
        'user-agent': 'stronghold-dl-tick', 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs }),
    });
  } catch (e) {
    note = String((e && e.name) || e);
    const rec = { ok: false, http: 0, at: new Date().toISOString(), target, note };
    await heartbeat(env, rec);
    return json(rec, 502);
  }
  if (res.status !== 204) note = (await res.text().catch(() => '')).slice(0, 200);
  const rec = { ok: res.status === 204, http: res.status, at: new Date().toISOString(), target, note };
  await heartbeat(env, rec);
  return json(rec, rec.ok ? 200 : 502);
}

async function heartbeat(env, rec) {
  // 心跳落 R2：「闹钟到底有没有在打」变成一个可直接查的数，不用登机器翻日志
  try {
    const prevRes = await env.R2BUCKET.get(HB_KEY);
    const prev = prevRes ? JSON.parse(await prevRes.text()) : {};
    const doc = Object.assign({ history: [] }, prev);
    if (rec.ok) doc.lastOk = rec.at;
    doc.updated = rec.at;
    doc.history = [rec].concat(Array.isArray(doc.history) ? doc.history : []).slice(0, 30);
    await env.R2BUCKET.put(HB_KEY, JSON.stringify(doc, null, 1) + '\n', {
      httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=30' },
    });
  } catch (e) { /* 心跳失败不影响打点本身 */ }
}

export async function onRequestPost(context) { return handle(context); }
export async function onRequestGet(context) { return handle(context); }
