// src/index.js — sp-lobby-board thin Cloudflare adapter: Module Worker + ONE Durable Object.
//
// EGRESS: board routes have none; the ONLY outbound requests are the community relay below, whose
// upstreams are FROZEN CONSTANTS (the client sends a source KEY, never a URL) — no SSRF surface.
// Every relay request still re-validates scheme + host (see targetHostDenyReason) per the standing
// constraint: http/https only, no loopback/private/reserved targets.
//
// ROUTES
//   OPTIONS *              CORS preflight (204)
//   GET  /                 the public lobby page (src/page.js) — live room board, join/spectate
//   GET  /api              self-describing endpoint index — the entry point other clients start from
//   GET  /api/lobby        **ONE-CALL LOBBY**: board + community merged/deduped/sorted, every row
//                          tagged with `src` — for other clients (bots, sites, other APK builds)
//                          that do not want to implement the relay + merge themselves
//   GET  /api/rooms        rainya-shaped board: { ok, now, ttlSec:600, rooms:[...] }
//   POST /api/rooms        JSON { code, serverId, serverName, note?, url?, difficulty? } -> 201 { ok, added, token }
//   PATCH /api/rooms       JSON { code, serverId, note }  header X-Token      -> 200 { ok, updated }
//                          (only the note changes; createdAt/TTL/url are NOT refreshed)
//   DELETE /api/rooms?code=&serverId=      header X-Token: <token>          -> 200 { ok, removed }
//   GET  /api/community?src=rainya|lunar|rinko   relayed { ok, src, fetchedAt, rooms:[...] }
//        v6: `src` also accepts a comma list (1..3 whitelist keys, order preserved, deduped):
//        `?src=rainya,lunar` answers once for all of them — rows get a per-row `src`, a source
//        that fails lands in `errors:{<key>:'UPSTREAM'}` instead of failing the whole call (all of
//        them failing is still a 502). The lobby page uses the combined form: one request per cycle
//        instead of three (96 → 72 requests/hour per visible tab).
//        v7.2: 梨子湖（rinko）已从**页面**的聚合里去掉（它常年零房间，纯成本）；中转仍收 `rinko`
//        这个键，因为已安装的 APK 面板是按单源 `?src=rinko` 拉取的 —— 去掉键会让那些面板永久显示
//        「梨子湖暂不可达」。页面只发 `?src=rainya,lunar`（规范拼写 → 唯一缓存键）。
//   GET  /api/match?id=<handle>            queue/match status for one searcher
//   POST /api/match {difficulty, venue:{kind, serverId?}}    join the cross-server match queue
//   POST /api/match/room {id, code, serverId, url?}          header X-Token — the HOST posts the room
//   DELETE /api/match?id=<handle>          header X-Token — leave the queue / drop out of a match
//   GET  /api/health       { ok:true, now } — stateless liveness probe for deploy self-check
// Board responses carry `cache-control: no-store`; the community relay's 200 uses
// `public, max-age=10, s-maxage=120, stale-while-revalidate=600` (partial answers 10) so the edge
// can serve repeat polls without invoking this Worker, while every error path stays `no-store`
// (never let a 4xx/5xx poison the CDN — the negative-cache lesson). `/api/lobby` is the one endpoint
// that mixes live board rows with relayed ones, so it caches for a much shorter 15s.
// Error codes -> HTTP status: BAD_JSON/BAD_CODE/BAD_SERVER/BAD_URL/BAD_SRC/BAD_DIFFICULTY/BAD_VENUE/
// BAD_ID/BAD_QUERY/BLOCKED_TEXT 400, FORBIDDEN 403, NOT_FOUND 404, METHOD_NOT_ALLOWED 405,
// RATE_LIMITED/DEBOUNCED/LIMIT_REACHED 429, INTERNAL 500.

import { createBoard, targetHostDenyReason, CODE_RE, TTL_SEC } from './board.js';
import { createMatch } from './match.js';
import { mergeLobbyRooms, sortLobbyRooms, LOBBY_SOURCES, MERGE_ORDER } from './merge.js';
import { PAGE_HTML } from './page.js';

/** The single DO instance name — one board for every caller (singleton semantics). */
const BOARD_OBJECT_NAME = 'board';
/** The match queue lives in its OWN Durable Object (idFromName('match')) — queue and board never
 *  share storage, so neither can evict or corrupt the other's entries. */
const MATCH_OBJECT_NAME = 'match';
/** Max accepted JSON body size for POST/PATCH (bytes of the raw request text). */
const BODY_MAX = 8 * 1024;

/**
 * APK 外壳配置（GET /dl/config.json）。schema 1 = 客户端 SUPPORTED_SCHEMA。
 *
 * directoryUrls 只留一个：房间板自己。老 APK 里 spdir 那个值已经指向 o2p-platform
 * （不再收房间），换掉之后房主发布才能重新落到真的房间板上。
 */
const SHELL_CONFIG = Object.freeze({
  schema: 1,
  configVersion: 5,
  directoryUrls: ['https://sp-lobby.jiangjiangze.icu'],
  fallbackOrigins: [
    'https://map.u712507.nyat.app:38916',
    'https://stronghold.jiangjiangze.icu',
    'https://stronghold2.jiangjiangze.icu',
    'https://weishu2.jiangjiangze.icu',
  ],
  stunUrls: ['stun:stun.qq.com:3478', 'stun:stun.miwifi.com:3478', 'stun:stun.l.google.com:19302'],
  announce: '',
});

/**
 * Community relay upstreams — FROZEN constants. The community sources send no CORS headers
 * (rainya portal OPTIONS 403; lunar/rinko OPTIONS 405), so a browser/WebView page cannot read them
 * cross-origin; this relay is the door. The client only ever sends the KEY (`src`).
 *
 * v7.2: `rinko`（梨子湖 / 卫.rinko.ai）已从大厅页的聚合里去掉 —— 它常年返回零房间（2026-10-08 线上
 * 实测 `items: []`），却让每次中转多付一次上游往返。键保留在这里只为**已安装的 APK 面板**（它按
 * 单源 `?src=rinko` 拉取，见主仓 tools/apk/extras/public/js/lobby.js）；面板换成 `?src=rainya,lunar`
 * 之后这个键就可以整段删掉。LOBBY_SOURCES（= 页面与 /api/lobby 实际聚合的两个源）才是当前对外承诺。
 */
const COMMUNITY_SOURCES = Object.freeze({
  rainya: Object.freeze({ url: 'https://game.rainya.me/api/rooms' }),
  lunar: Object.freeze({
    url: 'https://stronghold.lunar.ag/api/rooms',
    host: 'stronghold.lunar.ag',
    serverId: 'lunar',
    serverName: 'Lunar',
  }),
  rinko: Object.freeze({
    url: 'https://xn--rlr.rinko.ai/api/rooms',
    host: 'xn--rlr.rinko.ai',
    serverId: 'rinko',
    serverName: '梨子湖',
  }),
});
/** Relay fetch timeout (tests override via env.RELAY_TIMEOUT_MS). */
const RELAY_TIMEOUT_MS = 4000;
/** Accepted upstream body size ceiling; larger responses are treated as upstream failure. */
const RELAY_MAX_TEXT = 256 * 1024;

/**
 * Map a lunar/rinko live-lobby row into the rainya-shaped row the client already understands.
 * `hostName` is the HOST PLAYER's name, not a server name — it becomes the note, and the fixed
 * station name goes into `server`/`serverName`. `leftSec` is synthetic (live rows have no TTL) so
 * the client's `left > 0` gate keeps working; `live: true` tells the UI to show 「在线」 instead.
 */
function mapLiveRoom(source, row) {
  if (!row || typeof row !== 'object') return null;
  const code = String(row.roomId || '').toUpperCase();
  if (!CODE_RE.test(code)) return null;
  const occupied = Number.isInteger(row.occupied) ? row.occupied : null;
  const capacity = Number.isInteger(row.capacity) ? row.capacity : null;
  const full = occupied !== null && capacity !== null && capacity > 0 && occupied >= capacity;
  const out = {
    code,
    server: source.serverName,
    serverName: source.serverName,
    serverId: source.serverId,
    url: `https://${source.host}/?room=${code}`,
    leftSec: TTL_SEC,
    live: true,
    status: row.inMatch === true ? 'playing' : (full ? 'full' : 'waiting'),
  };
  if (typeof row.hostName === 'string' && row.hostName) out.note = `房主：${row.hostName}`.slice(0, 40);
  if (occupied !== null) out.occupied = occupied;
  if (capacity !== null) out.capacity = capacity;
  if (Number.isInteger(row.connectedHumans)) out.humans = row.connectedHumans;
  if (Number.isInteger(row.spectatorCount)) out.spectators = row.spectatorCount;
  if (typeof row.difficulty === 'string' && row.difficulty) out.difficulty = row.difficulty;
  return out;
}

/** Relay ONE community source. Returns { ok:true, rooms } | { ok:false } — no HTTP shape here,
 *  so the single-source and the combined (comma-list) paths share one implementation. */
async function relayOne(key, env) {
  const source = Object.prototype.hasOwnProperty.call(COMMUNITY_SOURCES, key) ? COMMUNITY_SOURCES[key] : null;
  if (!source) return { ok: false };

  // Defensive validation even though every upstream is a frozen constant: scheme must be https and
  // the host must not be loopback/private/reserved (same deny table the board uses for submitted URLs).
  let target = null;
  try { target = new URL(source.url); } catch { target = null; }
  if (!target || target.protocol !== 'https:' || targetHostDenyReason(target.hostname)) return { ok: false };

  const timeoutMs = Number(env && env.RELAY_TIMEOUT_MS) > 0 ? Number(env.RELAY_TIMEOUT_MS) : RELAY_TIMEOUT_MS;
  let res;
  try {
    res = await fetch(target.toString(), {
      method: 'GET',
      redirect: 'manual', // a 3xx is an upstream failure: never follow to another host
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false };
  }
  if (!res.ok) return { ok: false };

  let text;
  try { text = await res.text(); } catch { return { ok: false }; }
  if (text.length > RELAY_MAX_TEXT) return { ok: false };
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false }; }

  let rooms;
  if (key === 'rainya') {
    rooms = data && Array.isArray(data.rooms) ? data.rooms : null;
  } else {
    const items = data && Array.isArray(data.items) ? data.items : null;
    rooms = items ? items.map((row) => mapLiveRoom(source, row)).filter(Boolean) : null;
  }
  if (!rooms) return { ok: false };
  return { ok: true, rooms };
}

/** Full success is edge-cacheable for 2 minutes (a zone Cache Rule / the Workers Cache may serve
 *  repeat polls without running this Worker); a partial answer keeps the old 10s so a recovered
 *  source is picked up quickly.
 *  v7.2 延迟：页面每 300s 才拉一次中转，而 s-maxage 只有 60s —— 每次轮询都是 MISS，每个访客都替
 *  上游付一次往返。现在 s-maxage=120 + stale-while-revalidate=600：边缘先回旧副本（0 往返）、
 *  后台再去上游刷新，访客基本不再等上游（实测见 README「抓取链路与缓存」）。 */
const RELAY_CACHE_FULL = 'public, max-age=10, s-maxage=120, stale-while-revalidate=600';
const RELAY_CACHE_PARTIAL = 'public, max-age=10, s-maxage=10';
/** Max sources in one combined call (there are only three; the cap keeps the URL grammar tight). */
const RELAY_SRC_MAX = 3;
/** The whitelist order — the ONLY order a combined `src` list may use (canonical form). */
const SOURCE_ORDER = Object.keys(COMMUNITY_SOURCES);

/**
 * Relay the community sources named by `srcParam` (one key, or a comma list of 1..3 whitelist keys).
 *   ?src=lunar          → the historic single-source envelope（形状不变）
 *   ?src=rainya,lunar   → { ok, src:'rainya,lunar', fetchedAt, rooms:[{...,src:'rainya'|'lunar'}],
 *                           errors?: { <key>: 'UPSTREAM' } } — 一个源挂了不拖垮整次调用；三个全挂才 502。
 * 列表必须是**规范拼写**：白名单顺序、无重复、无空条目、无空白 —— 同一组源只有一种 URL，
 * 缓存键唯一（否则等价拼写可以绕开边缘缓存、把上游请求放大 N 倍）。
 * Returns { status, body, cache } — the caller attaches CORS.
 */
async function relayCommunity(srcParam, env) {
  const raw = String(srcParam == null ? '' : srcParam);
  const keys = raw === '' ? [] : raw.split(',');
  if (keys.length === 0 || keys.length > RELAY_SRC_MAX) {
    return { status: 400, body: { ok: false, error: 'BAD_SRC' }, cache: 'no-store' };
  }
  if (keys.some((key) => key === '')) {
    return { status: 400, body: { ok: false, error: 'BAD_SRC' }, cache: 'no-store' };   // "a,,b" / 尾随逗号
  }
  if (new Set(keys).size !== keys.length) {
    return { status: 400, body: { ok: false, error: 'BAD_SRC' }, cache: 'no-store' };   // 重复键
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(COMMUNITY_SOURCES, key)) {
      return { status: 400, body: { ok: false, error: 'BAD_SRC' }, cache: 'no-store' };
    }
  }
  // 规范顺序（同时挡掉空白变体：'rainya, lunar' 的第二个键不在白名单里，先被上面拒绝）
  if (SOURCE_ORDER.filter((key) => keys.includes(key)).join(',') !== keys.join(',')) {
    return { status: 400, body: { ok: false, error: 'BAD_SRC' }, cache: 'no-store' };
  }
  const unique = keys;

  const results = await Promise.all(unique.map((key) => relayOne(key, env)));
  const failed = unique.filter((key, i) => !results[i].ok);
  if (failed.length === unique.length) {
    return { status: 502, body: { ok: false, error: 'UPSTREAM' }, cache: 'no-store' };
  }

  const body = { ok: true, src: unique.join(','), fetchedAt: Date.now(), rooms: [] };
  unique.forEach((key, i) => {
    if (!results[i].ok) return;
    if (unique.length === 1) {
      // single-source envelope stays byte-identical to the historic one (rainya 原样透传)
      for (const row of results[i].rooms) body.rooms.push(row);
      return;
    }
    // v6: in a combined answer every row must stay attributable → per-row `src`
    for (const row of results[i].rooms) body.rooms.push({ ...row, src: key });
  });
  if (failed.length) body.errors = Object.fromEntries(failed.map((key) => [key, 'UPSTREAM']));
  return { status: 200, body, cache: failed.length ? RELAY_CACHE_PARTIAL : RELAY_CACHE_FULL };
}

/** The aggregated read API caches far shorter than the relay: it carries the LIVE room board. */
const LOBBY_CACHE = 'public, max-age=5, s-maxage=15, stale-while-revalidate=60';

/** Read the board through its DO (the same headers the GET /api/rooms path forwards, so a client
 *  polling /api/lobby still counts as a lobby visitor). Never throws: { ok:false } on any failure. */
async function readBoardRooms(request, env) {
  try {
    const headers = new Headers();
    headers.set('x-client-ip', request.headers.get('CF-Connecting-IP') || '');
    const dev = request.headers.get('X-Device');
    if (dev) headers.set('x-device', dev);
    const stub = env.BOARD.get(env.BOARD.idFromName(BOARD_OBJECT_NAME));
    const internal = new Request('https://board.internal/api/rooms', { method: 'GET', headers });
    const res = await stub.fetch(internal);
    if (!res.ok) return { ok: false };
    const body = await res.json();
    return body && Array.isArray(body.rooms) ? { ok: true, body } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * GET /api/lobby — **the whole lobby in one request**, for clients that do not want to run the relay
 * themselves: the board (live, via its DO) plus the community sources (relayed) merged, deduped and
 * sorted by the canonical rule (src/merge.js), every row tagged with `src`.
 *   { ok, now, ttlSec, rooms:[{…,src}], sources:{ <key>:{ok,count} }, visitors?, errors? }
 * A single dead source degrades to `errors` + `sources[key].ok:false` and still answers 200; only
 * everything failing at once is a 502. No parameters are accepted (one cache key per endpoint —
 * the same reason /api/community rejects extras); filter client-side.
 */
async function lobbyPayload(request, env) {
  const [relayed, board] = await Promise.all([
    relayCommunity(LOBBY_SOURCES.join(','), env),
    readBoardRooms(request, env),
  ]);
  const relayOk = relayed.status === 200 && relayed.body && relayed.body.ok === true;
  if (!relayOk && !board.ok) {
    return { status: 502, body: { ok: false, error: 'UPSTREAM' }, cache: 'no-store' };
  }

  const lists = { board: [] };
  for (const key of LOBBY_SOURCES) lists[key] = [];
  const errors = {};
  if (relayOk) {
    for (const row of relayed.body.rooms || []) {
      const key = String((row && row.src) || '');
      if (!Object.prototype.hasOwnProperty.call(lists, key)) continue;   // 归属不明 → 丢，绝不猜
      lists[key].push(row);
    }
    if (relayed.body.errors) Object.assign(errors, relayed.body.errors);
  } else {
    for (const key of LOBBY_SOURCES) errors[key] = 'UPSTREAM';
  }
  if (board.ok) lists.board = board.body.rooms;
  else errors.board = 'UPSTREAM';

  const body = {
    ok: true,
    now: Date.now(),
    ttlSec: TTL_SEC,
    rooms: sortLobbyRooms(mergeLobbyRooms(lists)),
    sources: Object.fromEntries(MERGE_ORDER.map((key) => [key, { ok: !errors[key], count: lists[key].length }])),
  };
  if (board.ok && typeof board.body.visitors === 'number') body.visitors = board.body.visitors;
  if (Object.keys(errors).length) body.errors = errors;
  return { status: 200, body, cache: LOBBY_CACHE };
}

/** GET /api — the directory other clients start from: every public endpoint, its shape and its cache
 *  policy. Static (no DO, no egress), so it is cached for an hour at the edge. */
const API_INDEX = Object.freeze({
  ok: true,
  name: 'sp-lobby-board',
  about: '卫戍协议：盟约 · 联机大厅（非官方同人项目）房间牌 + 跨服匹配队列',
  page: 'https://sp-lobby.jiangjiangze.icu/',
  docs: 'https://github.com/jingjiangze/stronghold-lobby#其他端快速接入',
  cors: '*',
  sources: LOBBY_SOURCES,
  endpoints: [
    { method: 'GET', path: '/api/lobby', summary: '整个大厅一次拿：房间牌 + 社区源合并去重排序，每行带 src', cache: 'public, max-age=5, s-maxage=15' },
    { method: 'GET', path: '/api/rooms', summary: '本站房间牌（rainya 兼容形状）', cache: 'no-store' },
    { method: 'POST', path: '/api/rooms', summary: '提交房间 {code,serverId,serverName,note?,url?,difficulty?}', cache: 'no-store' },
    { method: 'PATCH', path: '/api/rooms', summary: '改备注（X-Token + serverId 双匹配）', cache: 'no-store' },
    { method: 'DELETE', path: '/api/rooms?code=&serverId=', summary: '销毁房间（X-Token）', cache: 'no-store' },
    { method: 'GET', path: '/api/community?src=rainya,lunar', summary: '社区源中转（白名单键，逗号列表须规范拼写）', cache: 'public, max-age=10, s-maxage=120' },
    { method: 'GET', path: '/api/match?id=', summary: '跨服匹配队列状态', cache: 'no-store' },
    { method: 'POST', path: '/api/match', summary: '入队 {difficulty, venue:{kind,serverId?}}', cache: 'no-store' },
    { method: 'POST', path: '/api/match/room', summary: '房主把建好的房间挂回队列（X-Token）', cache: 'no-store' },
    { method: 'DELETE', path: '/api/match?id=', summary: '退队 / 离开对局（X-Token）', cache: 'no-store' },
    { method: 'GET', path: '/api/health', summary: '无状态存活探针 {ok,now}', cache: 'no-store' },
    { method: 'GET', path: '/', summary: '公开大厅页（房间牌 / 加入 / 观战 / 提交房间）', cache: 'public, max-age=60' },
  ],
});


const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'Content-Type,X-Token,X-Device',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Attach the CORS headers every response must carry (incl. error responses) + a cache policy. */
function withCors(response, cacheControl = 'no-store') {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  headers.set('cache-control', cacheControl);
  return new Response(response.body, { status: response.status, headers });
}

function statusFor(error) {
  switch (error) {
    case 'BAD_JSON':
    case 'BAD_CODE':
    case 'BAD_SERVER':
    case 'BAD_URL':
    case 'BAD_DIFFICULTY':
    case 'BAD_VENUE':
    case 'BAD_ID':
    case 'BAD_QUERY':      // v7.2：/api/lobby 不吃参数（等价拼写会造出等价缓存键）
    case 'BLOCKED_TEXT':   // v7.1：服务器名/备注命中审核词表
      return 400;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'METHOD_NOT_ALLOWED':
      return 405;
    case 'RATE_LIMITED':
    case 'DEBOUNCED':
    case 'LIMIT_REACHED':
      return 429;
    default:
      return 500;
  }
}

async function readJsonBody(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false };
  }
  if (text.length > BODY_MAX) return { ok: false };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * The Durable Object class: a thin shell holding board state in DO storage (single instance).
 * `state.storage` is the Durable Object storage API (KV-style get/put/delete/list) — NOT the
 * Workers KV product — and the DO input gate serializes requests, so read-modify-write is safe.
 */
export class Board {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    const storage = state.storage;
    this.core = createBoard({
      state: {
        get: (key) => storage.get(key),
        put: (key, value) => storage.put(key, value),
        delete: (key) => storage.delete(key),
        list: () => storage.list(),
      },
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = (request.method || 'GET').toUpperCase();
    try {
      if (url.pathname === '/api/rooms' && method === 'GET') {
        // v5.2：访客搭车计数 —— 设备号（X-Device，页面 60s 轮询带上）优先，IP 兜底
        return json(await this.core.list(undefined, {
          visitorKey: request.headers.get('x-device') || '',
          ip: request.headers.get('x-client-ip') || '',
        }));
      }
      if (url.pathname === '/api/rooms' && method === 'POST') {
        const body = await readJsonBody(request);
        if (!body.ok) return json({ ok: false, error: 'BAD_JSON' }, 400);
        const ip = request.headers.get('x-client-ip') || '';
        const result = await this.core.add({ ...body.value, ip }); // header IP wins over any body field
        return json(result, result.ok ? 201 : statusFor(result.error));
      }
      if (url.pathname === '/api/rooms' && method === 'PATCH') {
        const body = await readJsonBody(request);
        if (!body.ok) return json({ ok: false, error: 'BAD_JSON' }, 400);
        // token comes from the header ONLY (body token, if any, is discarded)
        const result = await this.core.update({
          ...body.value,
          token: request.headers.get('x-token') || '',
        });
        return json(result, result.ok ? 200 : statusFor(result.error));
      }
      if (url.pathname === '/api/rooms' && method === 'DELETE') {
        const result = await this.core.remove({
          code: url.searchParams.get('code') || '',
          serverId: url.searchParams.get('serverId') || '',
          token: request.headers.get('x-token') || '',
        });
        return json(result, result.ok ? 200 : statusFor(result.error));
      }
      return json({ ok: false, error: 'NOT_FOUND' }, 404);
    } catch (error) {
      return json({ ok: false, error: 'INTERNAL', message: String((error && error.message) || error) }, 500);
    }
  }
}

/**
 * The cross-server match queue Durable Object — a separate singleton (idFromName('match')) running
 * the pure core in src/match.js. A coarse alarm (re-armed on every accepted mutation) sweeps expired
 * queue entries and matches so an abandoned queue does not linger between requests; a failure to arm
 * is never fatal (every request sweeps lazily anyway).
 */
export class MatchQueue {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    const storage = state.storage;
    this.core = createMatch({
      state: {
        get: (key) => storage.get(key),
        put: (key, value) => storage.put(key, value),
        delete: (key) => storage.delete(key),
        list: () => storage.list(),
      },
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = (request.method || 'GET').toUpperCase();
    try {
      if (url.pathname === '/api/match' && method === 'GET') {
        return json(await this.core.status({
          id: url.searchParams.get('id') || '',
          token: request.headers.get('x-token') || '',
        }));
      }
      if (url.pathname === '/api/match' && method === 'POST') {
        const body = await readJsonBody(request);
        if (!body.ok) return json({ ok: false, error: 'BAD_JSON' }, 400);
        const ip = request.headers.get('x-client-ip') || '';
        const result = await this.core.enqueue({ ...body.value, ip });
        if (result.ok) await this.arm();
        return json(result, result.ok ? 201 : statusFor(result.error));
      }
      if (url.pathname === '/api/match/room' && method === 'POST') {
        const body = await readJsonBody(request);
        if (!body.ok) return json({ ok: false, error: 'BAD_JSON' }, 400);
        const result = await this.core.setRoom({
          ...body.value,
          token: request.headers.get('x-token') || body.value.token || '',
        });
        return json(result, result.ok ? 200 : statusFor(result.error));
      }
      if (url.pathname === '/api/match' && method === 'DELETE') {
        const result = await this.core.cancel({
          id: url.searchParams.get('id') || '',
          token: request.headers.get('x-token') || '',
        });
        return json(result, result.ok ? 200 : statusFor(result.error));
      }
      return json({ ok: false, error: 'NOT_FOUND' }, 404);
    } catch (error) {
      return json({ ok: false, error: 'INTERNAL', message: String((error && error.message) || error) }, 500);
    }
  }

  async alarm() {
    try {
      const swept = await this.core.sweep();
      if (swept.pending) await this.arm();
    } catch { /* an alarm failure must never wedge the queue — requests sweep lazily */ }
  }

  async arm() {
    try {
      await this.state.storage.setAlarm(Date.now() + 30_000);
    } catch { /* alarms unavailable (older runtime): lazy sweeps still cover every request */ }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = (request.method || 'GET').toUpperCase();
    try {
      if (method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));

      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (method !== 'GET' && method !== 'HEAD') return withCors(json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405));
        // Static page: no env, no DO hop — live data arrives via the same-origin /api/rooms poll.
        return new Response(PAGE_HTML, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'public, max-age=60',
            'x-content-type-options': 'nosniff',
          },
        });
      }

      if (url.pathname === '/api/health') {
        if (method !== 'GET') return withCors(json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405));
        return withCors(json({ ok: true, now: Date.now() })); // stateless — no DO hop
      }

      // APK 外壳配置（2026-11-04）：ShellConfig 拉的 <origin>/dl/config.json。
      // 纯静态、零 DO、零出站；schema 固定 1，客户端按 SUPPORTED_SCHEMA 校验。
      if (url.pathname === '/dl/config.json') {
        if (method !== 'GET' && method !== 'HEAD') return withCors(json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405));
        return new Response(JSON.stringify(SHELL_CONFIG, null, 2), {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            // 短缓存：改配置后 5 分钟内设备就能拿到（APK 侧还有 last-good 兜底）。
            'cache-control': 'public, max-age=300',
            'access-control-allow-origin': '*',
            'x-content-type-options': 'nosniff',
          },
        });
      }

      // 其他端的快速接入入口：先看这份索引（端点/形状/缓存策略），再 GET /api/lobby 一次拿全量。
      if (url.pathname === '/api' || url.pathname === '/api/') {
        if (method !== 'GET') return withCors(json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405));
        return withCors(json(API_INDEX), 'public, max-age=3600');
      }

      // 一次拿整个大厅：房间牌（DO）+ 社区源（中转）合并去重排序。**不吃任何参数** ——
      // 多余的查询串会造出等价缓存键（绕边缘缓存、放大上游），所以直接 400。
      if (url.pathname === '/api/lobby') {
        if (method !== 'GET') return withCors(json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405));
        if ([...url.searchParams.keys()].length) {
          return withCors(json({ ok: false, error: 'BAD_QUERY' }, 400));
        }
        const merged = await lobbyPayload(request, env);
        return withCors(json(merged.body, merged.status), merged.cache);
      }

      if (url.pathname === '/api/community') {
        if (method !== 'GET') return withCors(json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405));
        // Strict source whitelist: exactly one `src` key, no extra parameters. Rejecting extras also
        // stops cache-busting query strings from punching holes in the edge cache.
        const keys = [...url.searchParams.keys()];
        const src = keys.length === 1 && keys[0] === 'src' ? url.searchParams.get('src') : '';
        const relayed = await relayCommunity(src, env);
        return withCors(json(relayed.body, relayed.status), relayed.cache);
      }

      if (url.pathname === '/api/match' || url.pathname === '/api/match/room') {
        if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
          return withCors(json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405));
        }
        // Forward to the MATCH queue DO (its own storage); the DO returns the final payload.
        const headers = new Headers();
        headers.set('x-client-ip', request.headers.get('CF-Connecting-IP') || '');
        const token = request.headers.get('X-Token');
        if (token) headers.set('x-token', token);
        let body;
        if (method === 'POST') {
          headers.set('content-type', 'application/json');
          body = await request.text();
        }
        const stub = env.MATCH.get(env.MATCH.idFromName(MATCH_OBJECT_NAME));
        const internal = new Request(`https://match.internal${url.pathname}${url.search}`, { method, headers, body });
        return withCors(await stub.fetch(internal));
      }

      if (url.pathname !== '/api/rooms') {
        return withCors(json({ ok: false, error: 'NOT_FOUND' }, 404));
      }
      if (method !== 'GET' && method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
        return withCors(json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405));
      }

      // Forward to the singleton DO; the DO returns the final payload, we add the shared headers.
      const headers = new Headers();
      headers.set('x-client-ip', request.headers.get('CF-Connecting-IP') || '');
      const dev = request.headers.get('X-Device');
      if (dev) headers.set('x-device', dev);
      const token = request.headers.get('X-Token');
      if (token) headers.set('x-token', token);
      let body;
      if (method === 'POST' || method === 'PATCH') {
        headers.set('content-type', 'application/json');
        body = await request.text();
      }
      const stub = env.BOARD.get(env.BOARD.idFromName(BOARD_OBJECT_NAME));
      const internal = new Request(`https://board.internal${url.pathname}${url.search}`, { method, headers, body });
      return withCors(await stub.fetch(internal));
    } catch (error) {
      return withCors(json({ ok: false, error: 'INTERNAL', message: String((error && error.message) || error) }, 500));
    }
  },
};
