// Pages Function: POST /api/servers/latency
// 玩家浏览器实测延迟的**批量**回执 —— 清单排序用的"共同延迟"就以它为第一来源（中位数），
// 因为它是很多个真实出口共同给出的数，比盒子那一个观察点公平，也比"各人测各人的"稳定。
//
// 为什么另开一个端点而不是复用 /api/servers/ping：
//   1. ping 是"每台一条、判断性质"的证据（房间数、版本号、entry_ok），而这里一次要交一整轮
//      测速结果 —— 一台一次写会把 R2 的写额度打爆（29 台 × 每访客每 10 分钟一次 = 每天几十万次），
//      批量一次写才是 O(访客数)；
//   2. 分开存 `site/latency.json`，两边不会互相覆盖（ping 的读-改-写已经很频繁了）。
//
// 防刷：按 sha256(ip|id|当天) 记名，**同一来源同一天对同一台只留一个样本**（改报会覆盖自己那条），
// 每台最多 64 个样本、只保留 48 小时内的 —— 所以中位数反映的是"今天有多少个不同网络觉得它快"，
// 而不是某个人刷了多少次。只存哈希，不存明文 IP。
//
// 这条链**不影响任何台显不显示**：显示/隐藏只由健康端点探测与站长停用决定（见 verify.js）。

const LIST_KEY = 'site/servers.json';
const LAT_KEY = 'site/latency.json';
const MAX_IDS = 200;
const MAX_SAMPLES_PER_ID = 64;
const WINDOW_MS = 48 * 3600e3;
const MAX_BATCH = 64;      // 一次最多交 64 条（清单本身封顶 64）

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function ipTag(ip, id, day) {
  const bytes = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(ip + '|' + id + '|' + day));
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function clean(oldDoc, nowMs) {
  const out = { updated: (oldDoc && oldDoc.updated) || null, lat: {} };
  const src = (oldDoc && typeof oldDoc.lat === 'object' && oldDoc.lat) || {};
  for (const id of Object.keys(src)) {
    const arr = Array.isArray(src[id] && src[id].samples) ? src[id].samples : [];
    const keep = [];
    const seen = new Set();
    for (const s of arr) {
      if (!s || typeof s !== 'object' || !s.tag || seen.has(s.tag)) continue;
      const at = Date.parse(s.at || '');
      if (!Number.isFinite(at) || nowMs - at > WINDOW_MS) continue;
      const ms = Number(s.ms);
      if (!(ms >= 0) || ms > 60000) continue;
      seen.add(s.tag);
      keep.push({ tag: s.tag, ms: Math.round(ms), cn: s.cn === true, at: s.at });
    }
    keep.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    if (keep.length > MAX_SAMPLES_PER_ID) keep.length = MAX_SAMPLES_PER_ID;
    if (keep.length) out.lat[id] = { samples: keep, n: keep.length, at: keep[0].at };
  }
  const ids = Object.keys(out.lat);
  if (ids.length > MAX_IDS) {
    ids.sort((a, b) => String(out.lat[b].at || '').localeCompare(String(out.lat[a].at || '')));
    ids.slice(MAX_IDS).forEach((k) => delete out.lat[k]);
  }
  return out;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.R2BUCKET) return json({ ok: false, error: 'R2 binding missing' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const raw = Array.isArray(body.samples) ? body.samples : [];
  if (!raw.length) return json({ ok: false, error: 'samples[] 不能为空' }, 400);
  const samples = raw.slice(0, MAX_BATCH);

  const listRes = await env.R2BUCKET.get(LIST_KEY);
  if (!listRes) return json({ ok: false, error: 'list missing' }, 500);
  let ids;
  try {
    const doc = JSON.parse(await listRes.text());
    ids = new Set((Array.isArray(doc.servers) ? doc.servers : []).map((s) => s && s.id));
  } catch { return json({ ok: false, error: 'list corrupt' }, 500); }

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const country = (request.cf && request.cf.country) || 'XX';
  const now = new Date();
  const day = now.toISOString().slice(0, 10);

  let doc = { updated: null, lat: {} };
  const prev = await env.R2BUCKET.get(LAT_KEY);
  if (prev) { try { doc = clean(JSON.parse(await prev.text()), now.getTime()); } catch { /* 覆盖重来 */ } }

  let wrote = 0;
  for (const s of samples) {
    const id = typeof s?.id === 'string' ? s.id.slice(0, 48) : '';
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id) || !ids.has(id)) continue;   // 只认清单里真实存在的 id
    const ms = Number(s.ms);
    if (!(ms >= 0) || ms > 60000) continue;
    const tag = await ipTag(ip, id, day);
    const rec = doc.lat[id] || { samples: [] };
    const arr = Array.isArray(rec.samples) ? rec.samples : [];
    const mine = arr.find((x) => x && x.tag === tag);
    if (mine) { mine.ms = Math.round(ms); mine.cn = country === 'CN'; mine.at = now.toISOString(); }
    else arr.push({ tag, ms: Math.round(ms), cn: country === 'CN', at: now.toISOString() });
    doc.lat[id] = { samples: arr };
    wrote += 1;
  }
  if (!wrote) return json({ ok: false, error: '没有一条被接受' }, 400);

  doc = clean(doc, now.getTime());
  doc.updated = now.toISOString();
  await env.R2BUCKET.put(LAT_KEY, JSON.stringify(doc, null, 1) + '\n', {
    httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
  });
  return json({ ok: true, accepted: wrote, ids: Object.keys(doc.lat).length });
}

export async function onRequestGet() {
  return json({ ok: false, error: 'POST only' }, 405);
}
