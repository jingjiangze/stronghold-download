// lobby-relay.test.mjs — the community relay (/api/community?src=…) in src/index.js.
//
// Kept apart from lobby-board.test.mjs on purpose: that suite installs a counting fetch stub that
// must observe ZERO calls (board routes have no egress). This relay is the one route that DOES
// fetch, so its tests script the upstream responses and assert the frozen-constant discipline:
// the only URLs ever dialed are the three upstream constants, always GET, always redirect:'manual'.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'UTC';

const { default: worker } = await import('./src/index.js');
const { targetHostDenyReason } = await import('./src/board.js');

const UPSTREAMS = new Set([
  'https://game.rainya.me/api/rooms',
  'https://stronghold.lunar.ag/api/rooms',
  'https://xn--rlr.rinko.ai/api/rooms',
]);

const ENV = { RELAY_TIMEOUT_MS: 5000 };

/** Install a scripted fetch stub; returns the call log. */
function stubFetch(handler) {
  const log = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    log.push({ url: u, init: init || {} });
    if (!UPSTREAMS.has(u)) throw new Error(`unexpected outbound URL: ${u}`);
    return handler(u, init || {});
  };
  return log;
}

function jsonResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const callRelay = (query, env = ENV) =>
  worker.fetch(new Request(`https://board.example.test/api/community${query}`), env);

test('src=rainya passes the upstream rooms through with the relay envelope', async () => {
  const log = stubFetch(async () => jsonResponse({
    demo: false,
    rooms: [{ code: 'XAER', siteId: 'shiyan', server: '国内', status: 'waiting', leftSec: 120 }],
  }));
  const res = await callRelay('?src=rainya');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.src, 'rainya');
  assert.ok(Number.isFinite(body.fetchedAt));
  assert.deepEqual(body.rooms, [{ code: 'XAER', siteId: 'shiyan', server: '国内', status: 'waiting', leftSec: 120 }]);
  assert.equal(log.length, 1);
  assert.equal(log[0].url, 'https://game.rainya.me/api/rooms');
  assert.equal(log[0].init.method || 'GET', 'GET');
  assert.equal(log[0].init.redirect, 'manual');
  assert.ok(log[0].init.signal, 'a timeout signal must be attached');
});

test('src=lunar maps roomId→code, hostName→note, and synthesizes the station fields', async () => {
  const log = stubFetch(async () => jsonResponse({
    items: [{
      roomId: 'RVRU', hostName: '阿米娅', connectedHumans: 3,
      occupied: 3, capacity: 4, spectatorCount: 1, difficulty: 'HARD', inMatch: false,
    }],
    nextCursor: null,
  }));
  const res = await callRelay('?src=lunar');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.src, 'lunar');
  assert.equal(body.rooms.length, 1);
  const r = body.rooms[0];
  assert.equal(r.code, 'RVRU');
  assert.equal(r.serverId, 'lunar');
  assert.equal(r.server, 'Lunar');
  assert.equal(r.serverName, 'Lunar');
  assert.equal(r.url, 'https://stronghold.lunar.ag/?room=RVRU');
  assert.equal(r.live, true);
  assert.ok(r.leftSec > 0, 'synthetic leftSec keeps the client left>0 gate green');
  assert.equal(r.status, 'waiting');
  assert.equal(r.note, '房主：阿米娅');
  assert.equal(r.occupied, 3);
  assert.equal(r.capacity, 4);
  assert.equal(r.humans, 3);
  assert.equal(log[0].url, 'https://stronghold.lunar.ag/api/rooms');
});

test('src=rinko: inMatch→playing, full seats→full, rows outside CODE_RE are dropped', async () => {
  stubFetch(async () => jsonResponse({
    items: [
      { roomId: 'RVRU', hostName: 'h', occupied: 4, capacity: 4, inMatch: true },
      { roomId: '!!', hostName: 'bad' },
      { roomId: 'ABCDE', hostName: 'five' },   // 5 chars: not joinable by the native bridge
      { roomId: 'TKQZ', hostName: 'k', occupied: 1, capacity: 4, inMatch: false },
    ],
  }));
  const res = await callRelay('?src=rinko');
  const body = await res.json();
  assert.equal(body.rooms.length, 2, 'malformed / non-CODE_RE roomIds are filtered out');
  assert.equal(body.rooms[0].code, 'RVRU');
  assert.equal(body.rooms[0].status, 'playing');
  assert.equal(body.rooms[1].code, 'TKQZ');
  assert.equal(body.rooms[1].status, 'waiting');
  assert.equal(body.rooms[1].serverId, 'rinko');
  assert.equal(body.rooms[1].server, '梨子湖');
});

test('src=rinko: occupied>=capacity without inMatch reports full', async () => {
  stubFetch(async () => jsonResponse({ items: [{ roomId: 'FULL', occupied: 4, capacity: 4, inMatch: false }] }));
  const body = await (await callRelay('?src=rinko')).json();
  assert.equal(body.rooms[0].status, 'full');
});

test('v7.2: rinko 已从页面聚合里去掉，但中转仍收这个键（给已安装的 APK 面板）', async () => {
  // 页面只发 ?src=rainya,lunar（见 page.test.mjs）。这里锁住「不要顺手把键也删了」：
  // 老面板按单源 ?src=rinko 拉取，键一没就是 400，面板会永久显示「梨子湖暂不可达」。
  const log = stubFetch(async () => jsonResponse({ items: [] }));
  const res = await callRelay('?src=rinko');
  assert.equal(res.status, 200, 'installed panels must keep working until they pick up the 2-source list');
  assert.deepEqual(log.map((c) => c.url), ['https://xn--rlr.rinko.ai/api/rooms']);
});

test('whitelist: missing/unknown/duplicate/extra params are 400 BAD_SRC with ZERO outbound calls', async () => {
  const log = stubFetch(async () => jsonResponse({}));
  for (const query of ['', '?src=', '?src=nope', '?src=RAINYA', '?src=rainya&src=lunar', '?src=rainya&x=1', '?x=1', '?src=,',
                       '?src=rainya,nope', '?src=rainya,,nope', '?src=rainya,lunar,rinko,nope',
                       // 规范拼写约束（Sourcery 🟡）：空条目/重复/乱序/空白一律 400 ——
                       // 同一组源只允许一种 URL，避免等价拼写绕开边缘缓存、把上游请求放大 N 倍。
                       '?src=rainya,,lunar', '?src=rainya,lunar,', '?src=rainya,rainya', '?src=lunar,rainya',
                       '?src=rainya,%20lunar', '?src=rainya,rinko,lunar']) {
    const res = await callRelay(query);
    assert.equal(res.status, 400, `expected 400 for "${query}"`);
    const body = await res.json();
    assert.equal(body.error, 'BAD_SRC');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  assert.equal(log.length, 0, 'rejected requests must never dial upstream');
});

test('non-GET is 405 and OPTIONS stays a CORS 204', async () => {
  const log = stubFetch(async () => jsonResponse({}));
  const post = await worker.fetch(new Request('https://board.example.test/api/community?src=rainya', { method: 'POST' }), ENV);
  assert.equal(post.status, 405);
  const options = await worker.fetch(new Request('https://board.example.test/api/community?src=rainya', { method: 'OPTIONS' }), ENV);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), '*');
  assert.equal(log.length, 0);
});

test('upstream failures collapse to 502 UPSTREAM with no-store (never poison the edge cache)', async () => {
  for (const scripted of [
    () => jsonResponse({ error: 'boom' }, 500),
    () => jsonResponse('<html>not json</html>'),
    () => jsonResponse({ items: null }),
    () => new Response('', { status: 302, headers: { location: 'https://elsewhere.example/' } }),
  ]) {
    stubFetch(async () => scripted());
    const res = await callRelay('?src=rainya');
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'UPSTREAM');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  }
});

test('a timeout is a 502, not a hang', async () => {
  // The worker times the upstream call with AbortSignal.timeout(), whose timer is *unref'd*: with
  // the fetch stubbed there is no socket keeping the event loop alive, so on node 22 the loop
  // drained while this test was still awaiting the abort — the runner cancelled this test and the
  // two after it ("Promise resolution is still pending but the event loop has already resolved";
  // node 24 legs passed, node 22 legs failed 4/4 in CI on 2026-10-05). Hold one ref'd handle for
  // the duration of the test so the abort can actually fire.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    globalThis.fetch = async (url, init) => {
      assert.ok(UPSTREAMS.has(String(url)));
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    };
    const res = await callRelay('?src=rainya', { RELAY_TIMEOUT_MS: 25 });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'UPSTREAM');
  } finally {
    clearTimeout(keepAlive);
  }
});

test('a successful relay response is edge-cacheable (public, max-age=10, s-maxage=120 + SWR)', async () => {
  stubFetch(async () => jsonResponse({ rooms: [] }));
  const res = await callRelay('?src=rainya');
  assert.equal(res.status, 200);
  // v7.2：页面每 300s 才拉一次中转 —— s-maxage 必须 ≥ 这一档，否则每次轮询都是 MISS，
  // 每个访客都替上游付一次往返。stale-while-revalidate 让边缘先回旧副本、后台再去刷新。
  assert.equal(res.headers.get('cache-control'), 'public, max-age=10, s-maxage=120, stale-while-revalidate=600');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('v6 combined: ?src=rainya,lunar answers once, tags every row with its own src', async () => {
  const log = stubFetch(async (url) => {
    if (url === 'https://game.rainya.me/api/rooms') {
      return jsonResponse({ rooms: [{ code: 'XAER', server: '国内', leftSec: 120 }] });
    }
    if (url === 'https://stronghold.lunar.ag/api/rooms') {
      return jsonResponse({ items: [{ roomId: 'lmnp', hostName: '阿米娅', occupied: 3, capacity: 4, inMatch: false }] });
    }
    throw new Error('unexpected ' + url);
  });
  const res = await callRelay('?src=rainya,lunar');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.src, 'rainya,lunar', 'the envelope echoes the (deduped, ordered) list');
  assert.equal(body.rooms.length, 2);
  assert.equal(body.rooms[0].code, 'XAER');
  assert.equal(body.rooms[0].src, 'rainya', 'rainya rows are tagged in the combined form');
  assert.equal(body.rooms[1].code, 'LMNP');
  assert.equal(body.rooms[1].src, 'lunar');
  assert.equal(body.rooms[1].note, '房主：阿米娅');
  assert.equal(body.errors, undefined, 'no failed source → no errors key');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=10, s-maxage=120, stale-while-revalidate=600');
  assert.deepEqual(log.map((c) => c.url).sort(), [
    'https://game.rainya.me/api/rooms',
    'https://stronghold.lunar.ag/api/rooms',
  ], 'exactly the two requested upstreams, each once');
});

test('v6 combined: only the canonical spelling is accepted (one cache key per source set)', async () => {
  const log = stubFetch(async () => jsonResponse({ items: [] }));
  const ok = await callRelay('?src=rainya,lunar');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).src, 'rainya,lunar');
  assert.equal(log.length, 2, 'one upstream call per source in the list');

  // 等价但非规范的拼写必须被拒（否则每个变体都是一条独立的缓存键 → 绕缓存 / 放大上游）
  for (const bad of ['?src=lunar,rainya', '?src=rainya,rainya,lunar', '?src=rainya,,lunar']) {
    const res = await callRelay(bad);
    assert.equal(res.status, 400, `expected 400 for ${bad}`);
  }
  assert.equal(log.length, 2, 'rejected spellings never dial upstream');
});

test('v6 combined: one failing source lands in errors and never fails the whole call', async () => {
  stubFetch(async (url) => {
    if (url === 'https://stronghold.lunar.ag/api/rooms') return jsonResponse({ error: 'nope' }, 500);
    if (url === 'https://xn--rlr.rinko.ai/api/rooms') return jsonResponse({ items: [{ roomId: 'pqrs', hostName: '梨', occupied: 4, capacity: 4 }] });
    return jsonResponse({ rooms: [{ code: 'XAER' }] });
  });
  const res = await callRelay('?src=rainya,lunar,rinko');
  assert.equal(res.status, 200, 'partial success is still a 200');
  const body = await res.json();
  assert.deepEqual(body.errors, { lunar: 'UPSTREAM' });
  assert.deepEqual(body.rooms.map((r) => [r.code, r.src]), [['XAER', 'rainya'], ['PQRS', 'rinko']]);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=10, s-maxage=10',
    'a partial answer keeps the short TTL so a recovered source is picked up quickly');
});

test('v6 combined: all sources failing is still a 502 no-store', async () => {
  stubFetch(async () => jsonResponse({ error: 'boom' }, 500));
  const res = await callRelay('?src=rainya,lunar,rinko');
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'UPSTREAM');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('v6 single-source envelope stays byte-identical (rainya passthrough is untouched)', async () => {
  const row = { code: 'XAER', siteId: 'shiyan', server: '国内', status: 'waiting', leftSec: 120 };
  stubFetch(async () => jsonResponse({ rooms: [row] }));
  const res = await callRelay('?src=rainya');
  const body = await res.json();
  assert.deepEqual(body.rooms, [row], 'no per-row src is added in the historic single form');
  assert.equal(body.src, 'rainya');
});

test('all upstream constants themselves pass the deny-table check (self-consistency)', () => {
  for (const u of UPSTREAMS) {
    const parsed = new URL(u);
    assert.equal(parsed.protocol, 'https:');
    assert.equal(targetHostDenyReason(parsed.hostname), null, `${u} must be a public host`);
  }
});
