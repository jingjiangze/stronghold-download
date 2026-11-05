// src/merge.js — the lobby's canonical merge rule (source order / dedupe key / sort), in one place
// for the server-side read API (`GET /api/lobby`, src/index.js).
//
// WHY THIS EXISTS: other clients (bots, sites, other APK builds) should be able to show the lobby
// without re-implementing the relay + merge, so the Worker answers with one already-merged list.
//
// ⚠️ THE PUBLIC PAGE IMPLEMENTS THE SAME RULE INLINE (src/page.js: mergeRooms / sortRooms / stateOf)
// — it is one self-contained document with no imports, so it cannot share this module. The two must
// stay in step: change both, and keep `page.test.mjs` (page side) and `lobby-api.test.mjs` (server
// side) green. The rule itself: 本站优先 → rainya → lunar；去重键 = 主机（其次 serverId / 服务器名）+
// 房号（不同站的同号房间是两间房）；排序 = 可加入/已关闭 → 对局中 → 满员，组内最新在前、
// 无时间戳的常驻行（实时大厅源）排本组末尾。

/** The source order of a merged lobby. `board` = this Worker's own room board (players submit it). */
export const MERGE_ORDER = Object.freeze(['board', 'rainya', 'lunar']);

/** The community sources the page and /api/lobby actually aggregate — relayed by /api/community.
 *  (The relay itself still accepts `rinko` for already-installed APK panels; see src/index.js.) */
export const LOBBY_SOURCES = Object.freeze(MERGE_ORDER.filter((key) => key !== 'board'));

/** Dedupe key = hostname (from the row's url) → else serverId → else server name, plus the code.
 *  Ports are ignored (same rule as the page) so `host:10166` and `host` are one station. */
export function dedupeKey(row) {
  let host = '';
  if (row && typeof row.url === 'string') {
    try { host = new URL(row.url).hostname.toLowerCase(); } catch { host = ''; }
  }
  const id = String((row && (row.serverId || row.server)) || '').trim();
  return (host || id || '?') + '#' + String((row && row.code) || '');
}

/** open/closed → joinable-or-announcement group; live → 观战; full → last. */
export function stateOfRow(row) {
  if (row && (row.inMatch === true || String(row.status) === 'playing')) return 'live';
  if (row && String(row.status) === 'closed') return 'closed';
  const occ = Number(row && row.occupied) || 0;
  const cap = Number(row && row.capacity) || 0;
  if (cap > 0 && occ >= cap) return 'full';
  return 'open';
}

function rankOf(row) {
  const state = stateOfRow(row);
  return state === 'open' || state === 'closed' ? 0 : state === 'live' ? 1 : 2;
}

/** Rows carry `ageSec` when the source can tell (board + the rainya portal); live lobby rows cannot
 *  (they are snapshots) and are kept at -1 → they sort to the end of their group. */
function ageSecOf(row) {
  const age = Number(row && row.ageSec);
  return Number.isFinite(age) && age >= 0 ? age : -1;
}

/** Newest first inside a group, timestamp-less rows last. */
export function sortLobbyRooms(rows) {
  return rows.slice().sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    const aa = ageSecOf(a);
    const bb = ageSecOf(b);
    if (aa < 0 && bb >= 0) return 1;
    if (bb < 0 && aa >= 0) return -1;
    if (aa >= 0 && bb >= 0) return aa - bb;
    return 0;
  });
}

/** Merge per-source lists ({ board:[…], rainya:[…], lunar:[…] }) into one list, first source wins a
 *  duplicate. Every row comes back with `src` set to the source it was taken from — never guessed. */
export function mergeLobbyRooms(lists) {
  const seen = new Set();
  const out = [];
  for (const key of MERGE_ORDER) {
    const list = (lists && lists[key]) || [];
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const dk = dedupeKey(row);
      if (seen.has(dk)) continue;
      seen.add(dk);
      out.push({ ...row, src: key });
    }
  }
  return out;
}
