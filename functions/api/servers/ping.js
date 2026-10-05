// Pages Function: POST /api/servers/ping
// 玩家浏览器把「我这台能不能连上某服务器」回报一次。存在的理由：服务端校验只有 Cloudflare
// 海外出口，而不少服挂在国内 IDC / 云防火墙后面，入站直接丢海外包 —— 于是探针超时，
// 玩家却玩得好好的（例：sp.rainya.me:10166 在湖北飞迅 AS14871，国内 163ms 200，CF 边缘超时）。
// 浏览器就是那个「国内出口」，所以把它的成绩收下来当证据。
//
// 匿名可写，但只接受清单里真实存在的 id、只有三个字段、每台每 10 分钟由客户端自己限流，
// 服务端再按 id 数量封顶；写的是 R2（Class B 写额度远够用），不进 KV。

const LIST_KEY = 'site/servers.json';
const PINGS_KEY = 'site/pings.json';
const MAX_IDS = 200;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.R2BUCKET) return json({ ok: false, error: 'R2 binding missing' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const id = typeof body?.id === 'string' ? body.id.slice(0, 48) : '';
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id)) return json({ ok: false, error: 'bad id' }, 400);
  const alive = body.ok === true;
  let ms = Number(body.ms);
  if (!Number.isFinite(ms) || ms < 0) ms = null; else ms = Math.min(Math.round(ms), 60000);

  // 只认清单里存在的 id，避免这里变成任意键值的写入接口
  const listRes = await env.R2BUCKET.get(LIST_KEY);
  if (!listRes) return json({ ok: false, error: 'list missing' }, 500);
  let ids;
  try {
    const doc = JSON.parse(await listRes.text());
    ids = new Set((Array.isArray(doc.servers) ? doc.servers : []).map((s) => s.id));
  } catch { return json({ ok: false, error: 'list corrupt' }, 500); }
  if (!ids.has(id)) return json({ ok: false, error: 'unknown id' }, 404);

  let doc = { updated: null, pings: {} };
  const prevRes = await env.R2BUCKET.get(PINGS_KEY);
  if (prevRes) { try { doc = JSON.parse(await prevRes.text()); } catch { /* 覆盖重来 */ } }
  if (!doc.pings || typeof doc.pings !== 'object') doc.pings = {};

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const country = (context.request.cf && context.request.cf.country) || 'XX';
  const prev = doc.pings[id] || {};
  // 玩家浏览器若能把 /healthz 读成 CORS（服务器发了 ACAO 头），就连房间数和版本一起回报，
  // 于是海外出口探不到的国内服也能显示负载与版本。读不到就留 null —— 绝不抹掉上一次的真数据。
  const clampNum = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0
    ? Math.min(Math.round(Number(v)), 1e6) : null);
  const short = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const keep = (fresh, old) => (fresh == null ? (old === undefined ? null : old) : fresh);
  const rec = {
    at: now.toISOString(),
    ok: alive,
    ms,
    country,
    cn: country === 'CN',
    // 当天计数：给闸门当「有多少玩家实测」的证据强度。只在跨天时归零 —— 之前连着 prev.ok 一起判，
    // 于是第一条反向回执会把整天的 okHits 抹成 0，5 次实测证据瞬间没了。
    day,
    okHits: (prev.day === day ? (Number(prev.okHits) || 0) : 0) + (alive ? 1 : 0),
    deadHits: (prev.day === day ? (Number(prev.deadHits) || 0) : 0) + (alive ? 0 : 1),
    rooms: keep(clampNum(body.rooms), prev.rooms),
    humans: keep(clampNum(body.humans), prev.humans),
    app: keep(short(body.app, 24), prev.app),
    build: keep(short(body.build, 40), prev.build),
    variant: keep(body.variant === 'workers' || body.variant === 'node' ? body.variant : null, prev.variant),
    // 玩家自己打清单那条入口地址的结果（no-cors 只分得出「连上/连不上」，看不出 5xx）：
    // 明确连不上时这条回执不能再给死服免死。没测就写 null —— 每次回执都刷新 at，
    // 把上一次的 false 留下来会变成一条永久否决。
    entry_ok: typeof body.entry_ok === 'boolean' ? body.entry_ok : null,
  };
  doc.pings[id] = rec;
  const keys = Object.keys(doc.pings);
  if (keys.length > MAX_IDS) {
    keys.sort((a, b) => String(doc.pings[a].at).localeCompare(String(doc.pings[b].at)))
      .slice(0, keys.length - MAX_IDS)
      .forEach((k) => delete doc.pings[k]);
  }
  doc.updated = rec.at;
  await env.R2BUCKET.put(PINGS_KEY, JSON.stringify(doc, null, 1) + '\n', {
    httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
  });
  return json({ ok: true, id, recorded: { ok: rec.ok, cn: rec.cn, okHits: rec.okHits } });
}

export async function onRequestGet() {
  return json({ ok: false, error: 'POST only' }, 405);
}
