// POST|GET /api/tick —— 让外部闹钟（盒子上的计划任务）能拉起一轮云端采集
//
// 为什么不直接用 stronghold-scout Worker 的 /tick：那条地址在 *.workers.dev 上，
// 国内出口连不上（盒子实测三轮全是「无法连接到远程服务器」，而同轮的清单探测却正常）。
// dl.jiangjiangze.icu 在国内可达，所以这个入口放在站点侧。
//
// 口令分两层，盒子只拿最弱的那把：
//   TICK_KEY   —— 只允许"启动一轮采集"，从 x-tick-key 头传（不进 URL，不留请求日志）
//   GH_TICK_TOKEN —— 真正能创建 GitHub run 的口令，只待在 Pages secret 里
const DISPATCH = 'https://api.github.com/repos/jingjiangze/stronghold-scout'
  + '/actions/workflows/scout-schedule.yml/dispatches';
const ALLOWED = ['crawl', 'run', 'probe', 'bili'];
const HB_KEY = 'site/tick.json';

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra || {}),
  });
}

async function handle(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = request.headers.get('x-tick-key') || url.searchParams.get('key') || '';
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
