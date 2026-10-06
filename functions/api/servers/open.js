// Pages Function: POST /api/servers/open
// 记一次「玩家点了某条服务器的打开按钮」。只统计次数，不当任何闸门 —— 数字是给玩家看的
// 「这台有多少人在用」的粗信号，所以宁可轻、宁可漏，也不要让它变成刷出来的榜单。
//
// 与 /api/servers/vouch 的区别：那个是判断（要不要隐藏一行），这个只是计数。
// 因此这里不记来源、不去重到人，只做**同一来源同一台 10 秒内只算一次**（挡双击与重复触发）。
//
// 写 R2 单文件 site/opens.json（不用 KV：免费额度 1000 写/天早被别的心跳吃掉一半）。
// 数字由 /api/servers/verify 并进 site/verified.json，页面读那一份就够 —— 在又慢又抖的链路上
// 少一次往返比多一个接口值钱。

const LIST_KEY = 'site/servers.json';
const OPEN_KEY = 'site/opens.json';
const MAX_IDS = 200;
const GAP_MS = 10 * 1000;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function ipTag(ip, id) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + '|' + id + '|open'));
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function trim(oldDoc) {
  const out = { updated: (oldDoc && oldDoc.updated) || null, opens: {} };
  const src = (oldDoc && typeof oldDoc.opens === 'object' && oldDoc.opens) || {};
  const ids = Object.keys(src);
  if (ids.length > MAX_IDS) {
    ids.sort((a, b) => String((src[b] || {}).at || '').localeCompare(String((src[a] || {}).at || '')));
    ids.slice(MAX_IDS).forEach((k) => delete src[k]);
  }
  for (const id of ids) {
    const r = src[id];
    if (!r || typeof r !== 'object' || !(Number(r.total) > 0)) continue;
    out.opens[id] = {
      total: Math.min(Number(r.total) || 0, 1e9),
      today: Number(r.today) > 0 ? Math.min(Number(r.today), 1e9) : 0,
      day: typeof r.day === 'string' ? r.day.slice(0, 10) : null,
      at: r.at || null,
      seen: (r.seen && typeof r.seen === 'object') ? r.seen : {},
    };
  }
  return out;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.R2BUCKET) return json({ ok: false, error: 'R2 binding missing' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const id = typeof body.id === 'string' ? body.id.slice(0, 48) : '';
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id)) return json({ ok: false, error: 'bad id' }, 400);

  // 只认清单里真实存在的 id：不接受任意键，否则这里会变成任意计数写入口
  const listRes = await env.R2BUCKET.get(LIST_KEY);
  if (!listRes) return json({ ok: false, error: 'list missing' }, 500);
  let entry;
  try {
    const doc = JSON.parse(await listRes.text());
    entry = (Array.isArray(doc.servers) ? doc.servers : []).find((s) => s && s.id === id);
  } catch { return json({ ok: false, error: 'list corrupt' }, 500); }
  if (!entry) return json({ ok: false, error: 'unknown id' }, 404);

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const tag = await ipTag(request.headers.get('cf-connecting-ip') || 'unknown', id);

  let doc = { updated: null, opens: {} };
  const prev = await env.R2BUCKET.get(OPEN_KEY);
  if (prev) { try { doc = trim(JSON.parse(await prev.text())); } catch { /* 覆盖重来 */ } }
  const rec = doc.opens[id] || { total: 0, today: 0, day, at: null, seen: {} };
  if (!rec.seen || typeof rec.seen !== 'object') rec.seen = {};
  const last = Number(rec.seen[tag]);
  if (Number.isFinite(last) && now.getTime() - last < GAP_MS) {
    return json({ ok: true, id, counted: false, total: rec.total, today: rec.today });
  }
  if (rec.day !== day) { rec.day = day; rec.today = 0; }
  rec.total = Math.min((Number(rec.total) || 0) + 1, 1e9);
  rec.today = (Number(rec.today) || 0) + 1;
  rec.at = now.toISOString();
  rec.seen[tag] = now.getTime();
  // 去重表只留最近 64 个来源，防文件无限膨胀
  const tags = Object.keys(rec.seen);
  if (tags.length > 64) {
    tags.sort((a, b) => (Number(rec.seen[a]) || 0) - (Number(rec.seen[b]) || 0))
      .slice(0, tags.length - 64).forEach((t) => delete rec.seen[t]);
  }
  doc.opens[id] = rec;
  doc = trim(doc);
  doc.updated = now.toISOString();
  await env.R2BUCKET.put(OPEN_KEY, JSON.stringify(doc, null, 1) + '\n', {
    httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
  });
  const saved = doc.opens[id] || rec;
  return json({ ok: true, id, counted: true, total: saved.total, today: saved.today });
}

export async function onRequestGet() {
  return json({ ok: false, error: 'POST only' }, 405);
}
