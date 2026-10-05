// GET /api/rooms —— 公开房间列表的服务端中转（同源、带 CORS、R2 快照 + stale-while-revalidate）
//
// 为什么需要它：各家门户的 /api/rooms 一律不给 Access-Control-Allow-Origin
//   · game.rainya.me：OPTIONS 直接 403，契约也从 {ok,now,ttlSec,rooms} 换成 {demo,rooms:[…12+字段]}
//   · stronghold.lunar.ag / xn--rlr.rinko.ai：OPTIONS 405，形状是 {items,nextCursor}
// 浏览器跨源 fetch 全部被拦，只有同源或带 CORS 的中转能读。这里由边缘去取，再归一成一份。
//
// 顺带吃掉一个坑：清单里 raiya 的 url 带 `/play`（玩家要求原样保留），
// 拿它直接拼 `/api/rooms` 会打到 /play/api/rooms → nginx 502。中转按 origin 重拼。
//
// 为什么要有 R2 快照：Pages Functions 的响应不走边缘缓存（实测两次都 cf-cache-status: DYNAMIC），
// 全量扫 17 台冷启动 5.8 s。大厅每 15 s 轮询，若每访客都触发一轮，既慢又等于替所有访客去轰玩家的服务器
// （17 台 × 4320 轮/天 ≈ 13 万次/天）。所以：快档只扫上次应答过的源（今天 3 台），
// 每 30 分钟或清单变更时才全量重扫一次，响应永远先回快照。

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'accept',
  'vary': 'Accept-Encoding',
};

const LIST_KEY = 'site/servers.json';
const CACHE_KEY = 'site/rooms.json';
const FRESH_MS = 20 * 1000;          // 快照算"新鲜"的窗口：窗口内直接回缓存，过期则回缓存 + 后台刷新
const FULL_SCAN_MS = 30 * 60 * 1000; // 全量重扫间隔（发现新提供者的途径）
const HOST_DEADLINE_MS = 5000;       // 单台总时限，跨它的所有候选地址
const ATTEMPTS_MAX = 40;
const PATHS = ['/api/rooms'];

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

const cut = (u) => { try { return new URL(u); } catch { return null; } };

/** 清单条目 → 可试的 origin（去掉 /play 这类子路径；不改清单本身，只在中转里归一）。 */
function basesOf(entry) {
  const u = cut(entry.url);
  if (!u) return [];
  const out = [u.origin];
  const sub = u.pathname.replace(/\/+$/, '');
  if (sub && sub !== '/') out.push(u.origin + sub);   // 少数部署把 API 也挂在子路径下
  return out;
}

/** 三种已知形状 → 统一的房间行；各家原名透传，不造第二套语义。 */
function normalize(body, entry) {
  if (!body || typeof body !== 'object') return null;
  const rawRooms = Array.isArray(body.rooms) ? body.rooms
    : Array.isArray(body.items) ? body.items : null;
  if (!rawRooms) return null;
  const base = cut(entry.url);
  const rooms = rawRooms.map((r) => {
    const row = r && typeof r === 'object' ? r : {};
    const code = row.code ?? row.roomId ?? row.id ?? null;
    return {
      ...row,
      code,
      humans: row.humans ?? row.connectedHumans ?? null,
      server: row.server || row.siteId || entry.name,
      serverId: row.serverId || entry.id,
      url: row.url || (code && base ? `${base.origin}${base.pathname.replace(/\/+$/, '')}/?room=${encodeURIComponent(String(code))}` : null),
      source: entry.id,
    };
  });
  return { rooms, cursor: body.nextCursor ?? null, demo: body.demo ?? null, ttlSec: body.ttlSec ?? null };
}

async function probe(fetchImpl, entry, budget) {
  const rec = { id: entry.id, name: entry.name, url: entry.url, tried: [], rooms: 0, status: 'no-rooms-endpoint', ms: null };
  const t0 = Date.now();
  const signal = AbortSignal.timeout(HOST_DEADLINE_MS);
  for (const base of basesOf(entry).slice(0, 2)) {
    for (const p of PATHS) {
      if (budget.left <= 0 || signal.aborted) { rec.lastError = rec.lastError || (signal.aborted ? '超过单台总时限' : '达到探测上限'); break; }
      budget.left--;
      const endpoint = base + p;
      rec.tried.push(endpoint);
      let res, body;
      try {
        res = await fetchImpl(endpoint, {
          headers: { accept: 'application/json', 'user-agent': 'stronghold-dl-rooms-relay' },
          signal, cache: 'no-store',
        });
      } catch (e) { rec.lastError = `${endpoint} → ${e.name || 'fetch失败'}`; continue; }
      if (!res.ok) { rec.lastError = `${endpoint} → HTTP ${res.status}`; continue; }
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('json')) { rec.lastError = `${endpoint} → 非 JSON（${ct.split(';')[0] || '未知'}）`; continue; }
      try { body = await res.json(); } catch { rec.lastError = `${endpoint} → JSON 解析失败`; continue; }
      const norm = normalize(body, entry);
      if (!norm) { rec.lastError = `${endpoint} → 里没有 rooms[]/items[]`; continue; }
      Object.assign(rec, { status: 'ok', rooms: norm.rooms.length, ms: Date.now() - t0 });
      if (norm.cursor != null) rec.cursor = norm.cursor;
      if (norm.demo != null) rec.demo = norm.demo;
      return { rec, rooms: norm.rooms };
    }
  }
  rec.ms = Date.now() - t0;
  return { rec, rooms: [] };
}

/** 去取一轮并写快照。wantIds=null 表示全量扫。 */
async function refresh(fetchImpl, servers, wantIds) {
  const byId = new Map(servers.map((s) => [s.id, s]));
  const targets = (wantIds ? servers.filter((s) => wantIds.has(s.id)) : servers);
  const budget = { left: ATTEMPTS_MAX };
  const settled = await Promise.all(targets.map((s) => probe(fetchImpl, s, budget)));
  return { settled, targets, byId };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { ...CORS, 'access-control-max-age': '600' } });
}

export async function onRequestGet(context) {
  const { env, request, waitUntil } = context;
  const url = new URL(request.url);
  const want = url.searchParams.get('id');
  const force = url.searchParams.get('fresh') === '1';

  const liveRes = await env.R2BUCKET.get(LIST_KEY);
  if (!liveRes) return json({ ok: false, error: '清单读不到' }, 503);
  let list;
  try { list = JSON.parse(await liveRes.text()); } catch { return json({ ok: false, error: '清单解析失败' }, 500); }
  let servers = (Array.isArray(list.servers) ? list.servers : []).filter((s) => s.enabled !== false);
  if (want) servers = servers.filter((s) => s.id === want);
  if (!servers.length) return json({ ok: false, error: want ? `清单里没有 id=${want}` : '清单是空的' }, 404);

  const run = async (snapshot, persist = true) => {
    const prev = snapshot && Array.isArray(snapshot.sources) ? snapshot : null;
    const nowMs = Date.now();
    // ?fresh=1 = 运维手动要一轮真全量（也是治好被单台查询覆掉的快照的入口）
    const fullDue = force || !prev || want
      || prev.listUpdated !== list.updated
      || nowMs - Date.parse(prev.scanUpdated || 0) > FULL_SCAN_MS;
    const knownIds = prev ? new Set(prev.sources.filter((s) => s.status === 'ok').map((s) => s.id)) : null;
    const wantIds = fullDue || !knownIds || knownIds.size === 0 ? null : knownIds;

    const { settled } = await refresh(fetch, servers, wantIds ? new Set(wantIds) : null);
    const fresh = new Map(settled.map((x) => [x.rec.id, x]));

    // 本轮没扫的源沿用上次的结论（标 ageSec），免得快档把玩家的服务器打一遍
    const carry = (prev && !fullDue) ? prev.sources.filter((s) => !fresh.has(s.id) && s.status === 'ok') : [];
    const sources = [...settled.map((x) => x.rec),
      ...carry.map((s) => ({ ...s, carried: true, ageSec: Math.round((nowMs - Date.parse(s.at || prev.updated || '')) / 1000) || null }))];
    const rooms = [...settled.flatMap((x) => x.rooms),
      ...carry.flatMap((s) => (prev.rooms || []).filter((r) => r.source === s.id))];

    const doc = {
      updated: new Date().toISOString(),
      listUpdated: list.updated,
      scanUpdated: fullDue ? new Date().toISOString() : (prev && prev.scanUpdated) || new Date().toISOString(),
      scannedThisRound: settled.length,
      fullScan: !!fullDue,
      ok: true, now: nowMs, ttlSec: Math.round(FRESH_MS / 1000),
      rooms, sources,
      note: '由各站自己的 /api/rooms 服务端中转、归一（旧 {ok,now,ttlSec,rooms} / 新 {demo,rooms:[…]} / 游标 {items,nextCursor} 三种形状都吃）。'
        + ' 只取第一页；status 常见 waiting|full|playing|closed；部分站点加入是房主审批制。',
    };
    if (persist) {
      await env.R2BUCKET.put(CACHE_KEY, JSON.stringify(doc, null, 2) + '\n', {
        httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=20' },
      });
    }
    return doc;
  };

  let snap = null;
  try { const c = await env.R2BUCKET.get(CACHE_KEY); if (c) snap = JSON.parse(await c.text()); } catch { /* 坏了就重扫 */ }

  if (want) {
    const doc = await run(snap, false);   // 单台查询不写快照：否则会拿一台的结果覆掉聚合
    const one = doc.sources.filter((s) => s.id === want);
    return json({ ...doc, sources: one, rooms: doc.rooms.filter((r) => r.source === want), only: want });
  }

  const age = snap ? Date.now() - Date.parse(snap.updated || 0) : Infinity;
  if (!force && snap && age < FRESH_MS) {
    return json(snap, 200, { 'cache-control': 'public, max-age=0, must-revalidate', 'x-rooms-cache': `hit ${Math.round(age)}ms` });
  }
  // 过期：先回旧快照（没人多等），后台补一轮；没有快照可回时才同步等第一轮
  if (!force && snap) {
    waitUntil(run(snap).catch(() => {}));
    return json(snap, 200, { 'cache-control': 'public, max-age=0, must-revalidate', 'x-rooms-cache': `stale ${Math.round(age)}ms` });
  }
  const doc = await run(snap);
  return json(doc, 200, { 'cache-control': 'public, max-age=0, must-revalidate', 'x-rooms-cache': 'miss' });
}
