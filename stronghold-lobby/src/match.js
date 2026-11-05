// src/match.js — sp-lobby cross-server alliance-match queue PURE CORE (同盟匹配).
//
// ZERO EGRESS / ZERO CF DEPENDENCY (same rules as board.js): no imports, no fetch, no dialing.
// The Durable Object adapter in index.js runs this exact code; `node --test` exercises it with an
// in-memory state seam (match-queue.test.mjs).
//
// MODEL — queue → 4-group → venue room:
//   enqueue  a waiting entry { id, token, difficulty, venue:{kind, serverId?}, app?, ip, joinedAt }
//   group    the 4 oldest waiters of ONE difficulty form a match; the host is the earliest member
//            whose venue.kind === 'public' (公开服优先), else the oldest member
//   room     the host posts the in-game room code it created on the venue; guests read it via status
//   TTLs     a waiting entry expires after QUEUE_TTL_MS; a match dissolves after MATCH_TTL_MS when
//            no room arrived; once the room is up the record lives ROOM_TTL_MS for the guests
//
// The queue is deliberately version-agnostic (the product decision: 非 app 也配对) — `app` rides
// along for display only and never gates grouping.
//
// STATE ADAPTER (supplied by the caller; async or sync, always awaited):
//   get(key) / put(key, value) / delete(key) / list() -> Map or [key, value][] (same as board.js)
// Keys owned here:  q:<id> (waiting)   m:<matchId> (formed)   i:<memberId> -> matchId   ops:<ip>

// The room URL a host posts is handed to OTHER players' clients, so it must pass the same public-host
// deny table the board applies to submitted URLs (loopback/private/reserved are never shareable).
// board.js is dependency-free too — this stays a pure, test-friendly import.
import { targetHostDenyReason } from './board.js';

export const DIFFS = ['FUNNY', 'NORMAL', 'HARD', 'ABYSS'];
export const VENUE_KINDS = ['public', 'local', 'custom'];

/** How many searchers make a group (the game's coop room is 4 seats). */
export const GROUP_SIZE = 4;
/** A waiting entry expires after this long without a group. */
export const QUEUE_TTL_MS = 90_000;
/** A formed match without a room dissolves after this long. */
export const MATCH_TTL_MS = 180_000;
/** After the room is posted the record stays readable for this long (guests' join window). */
export const ROOM_TTL_MS = 600_000;
/** Hard cap on simultaneously waiting entries (protects the DO from abuse). */
export const MAX_QUEUE = 60;
/** v7：一次匹配解散（房主没建房）后，客人最多被放回队列几次 —— 防「房主反复不建房」的活锁。 */
export const MAX_REQUEUES = 3;
/** Accepted POST/DELETE operations per IP per window (status GETs are never rate-limited). */
export const IP_OPS_MAX = 30;
export const IP_OPS_WINDOW_MS = 60_000;
export const SERVER_ID_MAX = 64;
export const APP_MAX = 16;
export const TOKEN_BYTES = 16;
export const ID_BYTES = 8;

const Q = 'q:';
const M = 'm:';
const I = 'i:';
const OPS = 'ops:';

function fail(error, message) {
  return message ? { ok: false, error, message } : { ok: false, error };
}

function normalizeIp(value) {
  const s = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  return s ? s.slice(0, 64) : 'unknown';
}

function stripControl(s) {
  return String(s).replace(/[\u0000-\u001f\u007f]/g, '');
}

/** Optional identity field: control chars stripped, trimmed, 1..max chars, else ''. */
function sanitizeField(value, max) {
  if (value === undefined || value === null) return '';
  const s = stripControl(value).trim();
  if (!s || Array.from(s).length > max) return '';
  return s;
}

function makeHex(random, bytes) {
  let arr;
  if (typeof random === 'function') {
    arr = Array.from(random(bytes) || []);
  } else {
    const webcrypto = globalThis.crypto;
    if (!webcrypto || typeof webcrypto.getRandomValues !== 'function') {
      throw new Error('match: webcrypto unavailable — cannot mint ids');
    }
    const buf = new Uint8Array(bytes);
    webcrypto.getRandomValues(buf);
    arr = Array.from(buf);
  }
  if (arr.length !== bytes || arr.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw new Error('match: random seam must return the requested byte count');
  }
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isQueueEntry(v) {
  return Boolean(
    v && typeof v === 'object'
    && typeof v.id === 'string' && v.id
    && typeof v.token === 'string' && v.token
    && DIFFS.includes(v.difficulty)
    && typeof v.joinedAt === 'number' && Number.isFinite(v.joinedAt)
    && (v.expiresAt === undefined || (typeof v.expiresAt === 'number' && Number.isFinite(v.expiresAt)))
    && (v.requeues === undefined || (Number.isInteger(v.requeues) && v.requeues >= 0)),
  );
}

/** 队列条目的过期时刻（v7）：进队与「被放回队列」都会重算；joinedAt 只用于排序与「已等多久」。 */
function queueDeadline(entry) {
  return typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt)
    ? entry.expiresAt
    : entry.joinedAt + QUEUE_TTL_MS;
}

function isMatchEntry(v) {
  return Boolean(
    v && typeof v === 'object'
    && typeof v.id === 'string' && v.id
    && typeof v.hostId === 'string'
    && Array.isArray(v.members) && v.members.length > 0
    && typeof v.createdAt === 'number' && Number.isFinite(v.createdAt)
    && typeof v.expiresAt === 'number' && Number.isFinite(v.expiresAt),
  );
}

/** Public view of a waiting entry (token never leaks). */
function publicQueue(entry, t, waiting, oldestJoinedAt) {
  return {
    ok: true,
    state: 'waiting',
    id: entry.id,
    difficulty: entry.difficulty,
    waiting: typeof waiting === 'number' ? waiting : undefined,
    need: GROUP_SIZE,
    queuedSec: Math.max(0, Math.floor((t - entry.joinedAt) / 1000)),
    // v7 可观测性：本难度队列里最久的等待（秒）—— 饿死一眼可见；requeued = 被放回队列的次数
    oldestWaitSec: Number.isFinite(oldestJoinedAt) ? Math.max(0, Math.floor((t - oldestJoinedAt) / 1000)) : undefined,
    requeued: Number.isInteger(entry.requeues) && entry.requeues > 0 ? entry.requeues : undefined,
  };
}

/** Public view of a formed match for one member. `id` is the caller's OWN handle (stable across
 *  queue → match, so the client keeps one {id, token} pair for status/setRoom/cancel). */
function publicMatch(match, memberId, t) {
  const host = match.hostId === memberId;
  const out = {
    ok: true,
    state: 'matched',
    id: memberId,
    role: host ? 'host' : 'guest',
    matchId: match.id,
    difficulty: match.difficulty,
    size: match.members.length,
    need: GROUP_SIZE,
    room: match.room
      ? {
        code: match.room.code,
        serverId: match.room.serverId,
        url: match.room.url || undefined,
        venueKind: match.room.venueKind,
      }
      : null,
    // the host sees the full member list (useful for the "3/4" style UI); guests only the count
    members: host
      ? match.members.map((m) => ({ id: m.id, venue: m.venue.kind, serverId: m.venue.serverId || '', app: m.app || '' }))
      : undefined,
    ageSec: Math.max(0, Math.floor((t - match.createdAt) / 1000)),
  };
  return out;
}

/**
 * @param {object} options
 * @param {{get: Function, put: Function, delete: Function, list: Function}} options.state
 * @param {(() => number) | number} [options.now]
 * @param {(n: number) => ArrayLike<number>} [options.random]
 */
export function createMatch({ state, now, random } = {}) {
  if (!state
    || typeof state.get !== 'function'
    || typeof state.put !== 'function'
    || typeof state.delete !== 'function'
    || typeof state.list !== 'function') {
    throw new TypeError('createMatch: state adapter must provide get/put/delete/list');
  }

  const clock = typeof now === 'function'
    ? () => Number(now())
    : Number.isFinite(now) ? () => Number(now) : () => Date.now();
  const at = (nowArg) => (Number.isFinite(nowArg) ? Number(nowArg) : clock());

  /** One pass over storage: prune expired entries/matches/op-windows.
   *  v7：时间参数缺省时取时钟 —— 导出的 sweep() 不带参时原来 t=undefined，任何比较都为 false（什么都不清理）。
   *  @returns {Promise<{queue: object[], matches: object[], pending: boolean}>} */
  async function sweep(nowArg) {
    const t = at(nowArg);
    const listed = await state.list();
    const pairs = listed instanceof Map
      ? listed.entries()
      : (listed && typeof listed[Symbol.iterator] === 'function' ? listed : []);
    const queue = [];
    const matches = [];
    const dead = [];
    /** v7：解散后要放回队列的客人（等 dead 清理完再写，避免自己删自己）。 */
    const requeues = [];
    for (const pair of pairs) {
      if (!pair) continue;
      const key = pair[0];
      const value = pair[1];
      if (typeof key !== 'string') continue;
      if (key.startsWith(Q)) {
        if (!isQueueEntry(value) || t >= queueDeadline(value)) dead.push(key);
        else queue.push(value);
      } else if (key.startsWith(M)) {
        if (!isMatchEntry(value) || value.expiresAt <= t) {
          dead.push(key);
          if (isMatchEntry(value)) {
            for (const m of value.members) dead.push(I + m.id);
            // v7 公平性：**房主没建房的解散 → 客人按原位次放回队列**（joinedAt / id / token 全保留，
            // 只把 TTL 重算 + 记一次 requeues）——已到的人不该为房主没兑现而重新排队。
            // 房主自己出局（他没兑现）。已经有房的记录只是过了加入窗口，不做任何重排。
            if (!value.room) {
              for (const m of value.members) {
                if (m.id === value.hostId) continue;
                if ((m.requeues || 0) >= MAX_REQUEUES) continue;
                requeues.push({
                  key: Q + m.id,
                  entry: {
                    id: m.id,
                    token: m.token,
                    difficulty: value.difficulty,
                    venue: m.venue,
                    app: m.app || '',
                    ip: m.ip,
                    joinedAt: m.joinedAt,
                    expiresAt: t + QUEUE_TTL_MS,
                    requeues: (m.requeues || 0) + 1,
                  },
                });
              }
            }
          }
        } else {
          matches.push(value);
        }
      } else if (key.startsWith(I)) {
        if (typeof value !== 'string' || !value) dead.push(key);
      } else if (key.startsWith(OPS)) {
        const kept = Array.isArray(value)
          ? value.filter((ts) => Number.isFinite(ts) && t - ts >= 0 && t - ts < IP_OPS_WINDOW_MS)
          : [];
        if (!kept.length) dead.push(key);
        else if (kept.length !== value.length) await state.put(key, kept);
      }
    }
    for (const key of dead) await state.delete(key);
    // v7：把解散的客人放回队列（容量上限内；满了就只能让他们走正常重排）
    let requeuedDifficulty = '';
    for (const item of requeues) {
      if (queue.length + 1 > MAX_QUEUE) break;
      await state.put(item.key, item.entry);
      queue.push(item.entry);
      requeuedDifficulty = item.entry.difficulty;
    }
    // v7：放回后**立即**尝试成组 —— 否则「3 个客人 + 1 个已在等的人」会干等到下一个玩家进队（Sourcery 🟠）
    if (requeuedDifficulty) {
      const formed = await formGroups(queue, t, requeuedDifficulty);
      for (const m of formed) matches.push(m);
    }
    // an index pointing at a swept match is dead too
    const liveIds = new Set(matches.map((m) => m.id));
    for (const pair of pairs) {
      if (!pair || typeof pair[0] !== 'string' || !pair[0].startsWith(I)) continue;
      if (typeof pair[1] === 'string' && !liveIds.has(pair[1])) await state.delete(pair[0]);
    }
    const pending = queue.length > 0 || matches.length > 0;
    return { queue, matches, pending };
  }

  /**
   * 把某个难度的等待者按 joinedAt（同龄按 id）顺序每 GROUP_SIZE 个组成一局。
   * v7：enqueue 与「解散放回」共用 —— 放回后必须**立即**尝试成组，否则「3 个客人 + 1 个已在等的人」
   * 会一直干等到下一个玩家进队（Sourcery 🟠）。
   * @param {object[]} queue 本次 sweep 的存活等待者（成组的成员会被就地摘掉）
   * @param {number} t
   * @param {string} [onlyDifficulty] 只处理这个难度（放回场景；不传则四个难度都过一遍）
   * @returns {Promise<object[]>} 新成队的 match 列表
   */
  async function formGroups(queue, t, onlyDifficulty) {
    const formed = [];
    const diffs = onlyDifficulty ? [onlyDifficulty] : DIFFS;
    for (const difficulty of diffs) {
      let bucket = queue
        .filter((e) => e.difficulty === difficulty)
        .sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
      while (bucket.length >= GROUP_SIZE) {
        const members = bucket.slice(0, GROUP_SIZE);
        bucket = bucket.slice(GROUP_SIZE);
        const host = members.find((m) => m.venue && m.venue.kind === 'public') || members[0];
        const match = {
          id: makeHex(random, ID_BYTES),
          difficulty,
          hostId: host.id,
          // v7：requeues 要跟着条目一起进 match —— 否则解散放回时计数永远从 0 起算，上限形同虚设
          members: members.map((m) => ({
            id: m.id, token: m.token, venue: m.venue, app: m.app, ip: m.ip,
            joinedAt: m.joinedAt, requeues: m.requeues,
          })),
          room: null,
          createdAt: t,
          expiresAt: t + MATCH_TTL_MS,
        };
        await state.put(M + match.id, match);
        for (const m of members) {
          await state.put(I + m.id, match.id);
          await state.delete(Q + m.id);
          const at = queue.indexOf(m);
          if (at >= 0) queue.splice(at, 1);
        }
        formed.push(match);
      }
    }
    return formed;
  }

  /** Per-IP sliding window over accepted POST/DELETE ops. */
  async function takeOpSlot(ip, t) {
    const key = OPS + ip;
    const stored = await state.get(key);
    const recent = (Array.isArray(stored) ? stored : [])
      .filter((ts) => Number.isFinite(ts) && t - ts >= 0 && t - ts < IP_OPS_WINDOW_MS);
    if (recent.length >= IP_OPS_MAX) return false;
    recent.push(t);
    await state.put(key, recent.slice(-IP_OPS_MAX));
    return true;
  }

  /**
   * Join the queue (or learn you were grouped instantly).
   * input: { difficulty, venue:{kind, serverId?}, app?, ip }
   */
  async function enqueue(input, nowArg) {
    const t = at(nowArg);
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const difficulty = String(raw.difficulty || '').trim().toUpperCase();
    if (!DIFFS.includes(difficulty)) {
      return fail('BAD_DIFFICULTY', `difficulty must be one of ${DIFFS.join('/')}`);
    }
    const venueRaw = raw.venue && typeof raw.venue === 'object' && !Array.isArray(raw.venue) ? raw.venue : {};
    const kind = String(venueRaw.kind || '').trim().toLowerCase();
    if (!VENUE_KINDS.includes(kind)) {
      return fail('BAD_VENUE', `venue.kind must be one of ${VENUE_KINDS.join('/')}`);
    }
    const serverId = sanitizeField(venueRaw.serverId, SERVER_ID_MAX);
    if (kind === 'public' && !serverId) return fail('BAD_VENUE', 'a public venue needs serverId');
    const app = sanitizeField(raw.app, APP_MAX);
    const ip = normalizeIp(raw.ip);

    if (!(await takeOpSlot(ip, t))) {
      return fail('RATE_LIMITED', `at most ${IP_OPS_MAX} match operations per ${IP_OPS_WINDOW_MS / 1000}s`);
    }

    const before = await sweep(t);
    if (before.queue.length >= MAX_QUEUE) return fail('LIMIT_REACHED', 'match queue is full right now');

    const entry = {
      id: makeHex(random, ID_BYTES),
      token: makeHex(random, TOKEN_BYTES),
      difficulty,
      venue: { kind, serverId },
      app,
      ip,
      joinedAt: t,
      expiresAt: t + QUEUE_TTL_MS, // v7：TTL 与排序分开（放回队列只重算 TTL，不动位次）
    };
    await state.put(Q + entry.id, entry);
    before.queue.push(entry);

    // group only waiters of the SAME difficulty; oldest first (fair), exactly GROUP_SIZE
    const formed = await formGroups(before.queue, t, difficulty);
    const mine = formed.find((m) => m.members.some((mm) => mm.id === entry.id));
    if (mine) return { ...publicMatch(mine, entry.id, t), token: entry.token };

    const waiting = before.queue.filter((e) => e.difficulty === difficulty).length;
    return { ...publicQueue(entry, t, waiting), token: entry.token };
  }

  /** Poll a queue/match handle. input: { id, token? } */
  async function status(input, nowArg) {
    const t = at(nowArg);
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const id = typeof raw.id === 'string' ? raw.id : '';
    const token = typeof raw.token === 'string' ? raw.token.trim() : '';
    if (!id) return fail('BAD_ID', 'id is required');
    await sweep(t);

    const queued = await state.get(Q + id);
    if (isQueueEntry(queued)) {
      if (token && token !== queued.token) return fail('FORBIDDEN', 'token does not match this queue entry');
      const listed = await state.list();
      const pairs = listed instanceof Map ? listed.entries() : (listed || []);
      let waiting = 0;
      let oldest = Infinity;
      for (const pair of pairs) {
        if (pair && typeof pair[0] === 'string' && pair[0].startsWith(Q)
          && isQueueEntry(pair[1]) && pair[1].difficulty === queued.difficulty) {
          waiting++;
          if (pair[1].joinedAt < oldest) oldest = pair[1].joinedAt;
        }
      }
      return publicQueue(queued, t, waiting, oldest);
    }

    const matchId = await state.get(I + id);
    if (typeof matchId === 'string' && matchId) {
      const match = await state.get(M + matchId);
      if (isMatchEntry(match)) {
        const member = match.members.find((m) => m.id === id);
        if (!member) return { ok: true, state: 'expired' };
        if (token && token !== member.token) return fail('FORBIDDEN', 'token does not match this match');
        return publicMatch(match, id, t);
      }
    }
    return { ok: true, state: 'expired' }; // swept or unknown: the client re-queues
  }

  /** Host posts the in-game room it created on the venue. input: { id, token, code, serverId, url? } */
  async function setRoom(input, nowArg) {
    const t = at(nowArg);
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const id = typeof raw.id === 'string' ? raw.id : '';
    const token = typeof raw.token === 'string' ? raw.token.trim() : '';
    if (!id || !token) return fail('BAD_ID', 'id and token are required');

    const code = String(raw.code || '').trim().toUpperCase();
    if (!/^[A-HJ-NP-Z]{4}$/.test(code)) return fail('BAD_CODE', 'code must match ^[A-HJ-NP-Z]{4}$');
    const serverId = sanitizeField(raw.serverId, SERVER_ID_MAX);
    if (!serverId) return fail('BAD_SERVER', 'serverId is required');
    let url = undefined;
    if (raw.url !== undefined && raw.url !== null && String(raw.url).trim() !== '') {
      try {
        const u = new URL(String(raw.url));
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail('BAD_URL', 'url must be http(s)');
        if (targetHostDenyReason(u.hostname)) return fail('BAD_URL', 'url must be a public host');
        url = u.href;
      } catch {
        return fail('BAD_URL', 'url must parse as a URL');
      }
    }

    await sweep(t);
    const matchId = await state.get(I + id);
    const match = typeof matchId === 'string' && matchId ? await state.get(M + matchId) : null;
    if (!isMatchEntry(match)) return fail('NOT_FOUND', 'no live match for this handle');
    if (match.hostId !== id) return fail('FORBIDDEN', 'only the host can post the room');
    const member = match.members.find((m) => m.id === id);
    if (!member || member.token !== token) return fail('FORBIDDEN', 'token does not match this match');

    match.room = { code, serverId, url, venueKind: member.venue.kind };
    match.expiresAt = t + ROOM_TTL_MS;
    await state.put(M + match.id, match);
    return { ok: true, room: match.room, state: 'matched' };
  }

  /** Leave the queue / dissolve a room-less match / drop out of a match with a room. input: { id, token } */
  async function cancel(input, nowArg) {
    const t = at(nowArg);
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const id = typeof raw.id === 'string' ? raw.id : '';
    const token = typeof raw.token === 'string' ? raw.token.trim() : '';
    if (!id || !token) return fail('BAD_ID', 'id and token are required');

    await sweep(t);
    const queued = await state.get(Q + id);
    if (isQueueEntry(queued)) {
      if (queued.token !== token) return fail('FORBIDDEN', 'token does not match this queue entry');
      await state.delete(Q + id);
      return { ok: true, removed: 'queue' };
    }
    const matchId = await state.get(I + id);
    const match = typeof matchId === 'string' && matchId ? await state.get(M + matchId) : null;
    if (!isMatchEntry(match)) return fail('NOT_FOUND', 'no live queue entry or match for this handle');
    const member = match.members.find((m) => m.id === id);
    if (!member || member.token !== token) return fail('FORBIDDEN', 'token does not match this match');
    // Always drop only our own handle: the group survives and the host seat passes to the oldest
    // remaining member — a host who leaves before opening the room must not strand the others.
    await state.delete(I + id);
    match.members = match.members.filter((m) => m.id !== id);
    if (!match.members.length) {
      await state.delete(M + match.id);
      return { ok: true, removed: 'match' };
    }
    if (match.hostId === id) match.hostId = match.members[0].id;
    await state.put(M + match.id, match);
    return { ok: true, removed: 'member' };
  }

  return { enqueue, status, setRoom, cancel, sweep };
}
