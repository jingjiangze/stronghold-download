// lobby-api.test.mjs — the aggregated read API for other clients: GET /api/lobby + the GET /api index.
//
// Kept in its own file because it is the one route that mixes BOTH backends: the live room board
// (through its Durable Object) and the community relay (scripted upstreams). Its contract:
//   - one call returns the whole lobby, merged / deduped / sorted, every row tagged with `src`;
//   - a single dead backend degrades to `errors` + `sources[key].ok:false` and still answers 200;
//   - only everything failing at once is a 502 (never cached — the negative-cache lesson);
//   - no parameters are accepted, so one endpoint has exactly one edge-cache key.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'UTC';

const { default: worker } = await import('./src/index.js');

const UPSTREAMS = new Set([
  'https://game.rainya.me/api/rooms',
  'https://stronghold.lunar.ag/api/rooms',
]);

/** Scripted community upstreams; returns the outbound call log. */
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

const jsonResponse = (body, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A fake Board DO. `body` = the /api/rooms payload; `fail` makes it throw (DO unavailable). */
function fakeEnv({ rooms = [], visitors = 3, fail = false, now = 1_751_000_000_000 } = {}) {
  return {
    RELAY_TIMEOUT_MS: 5000,
    BOARD: {
      idFromName: (name) => `id:${name}`,
      get: () => ({
        fetch: async (req) => {
          if (fail) throw new Error('DO unavailable');
          assert.equal(new URL(req.url).pathname, '/api/rooms');
          return jsonResponse({ ok: true, now, ttlSec: 600, visitors, rooms });
        },
      }),
    },
  };
}

const boardRoom = (over = {}) => ({
  code: 'AAAA', serverId: 's1', serverName: '本站服', occupied: 2, capacity: 4,
  status: 'waiting', ageSec: 120, url: 'https://weishu.jiangjiangze.icu/?room=AAAA', ...over,
});

const callLobby = (query = '', env = fakeEnv()) =>
  worker.fetch(new Request(`https://board.example.test/api/lobby${query}`), env);

const COMMUNITY_OK = (url) => {
  if (url === 'https://game.rainya.me/api/rooms') {
    return jsonResponse({ rooms: [
      { code: 'KKKK', server: 'raiya', status: 'waiting', ageSec: 20, url: 'https://game.rainya.me/?room=KKKK' },
      { code: 'AAAA', server: 'raiya', status: 'waiting', ageSec: 5, url: 'https://weishu.jiangjiangze.icu/?room=AAAA' },
    ] });
  }
  return jsonResponse({ items: [
    { roomId: 'LMNP', hostName: '阿米娅', occupied: 4, capacity: 4, inMatch: true },
    { roomId: 'RVRU', hostName: 'b', occupied: 3, capacity: 4, inMatch: false },
  ] });
};

test('GET /api/lobby: 一次拿全量 —— 合并去重排序，每行带 src，本站优先', async () => {
  stubFetch(async (url) => COMMUNITY_OK(url));
  const res = await callLobby('', fakeEnv({ rooms: [boardRoom()] }));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.ok(Number.isFinite(body.now));
  assert.equal(body.ttlSec, 600);
  assert.equal(body.visitors, 3, 'board 的访客数原样带出（同 /api/rooms 口径）');
  assert.equal(body.errors, undefined, 'no failure → no errors key');

  // 合并 / 去重：rainya 那条 AAAA 与本站同主机同房号 → 本站优先，rainya 那条被丢掉。
  assert.deepEqual(body.rooms.map((r) => [r.code, r.src]), [
    ['KKKK', 'rainya'],   // open, ageSec 20
    ['AAAA', 'board'],    // open, ageSec 120 —— 同一间房，本站那条胜出
    ['RVRU', 'lunar'],    // live（inMatch）→ 可观战
    ['LMNP', 'lunar'],    // full
  ]);
  // 本站行也带 src（客户端不需要知道自己拿的是哪一层）
  assert.equal(body.rooms[1].serverName, '本站服');
  // 排序规则与页面一致：可加入（最新在前）→ 对局中 → 满员
  assert.deepEqual(body.rooms.map((r) => r.src + ':' + r.code),
    ['rainya:KKKK', 'board:AAAA', 'lunar:RVRU', 'lunar:LMNP']);

  // sources 计数 = 各源本次取到的行数（合并去重前）
  assert.deepEqual(body.sources, {
    board: { ok: true, count: 1 },
    rainya: { ok: true, count: 2 },
    lunar: { ok: true, count: 2 },
  });

  // 缓存策略：比中转短得多（它带着实时房间牌），且带 SWR。
  assert.equal(res.headers.get('cache-control'), 'public, max-age=5, s-maxage=15, stale-while-revalidate=60');
  assert.equal(res.headers.get('access-control-allow-origin'), '*', 'other clients read it cross-origin');
  assert.equal(res.headers.get('access-control-allow-methods').includes('GET'), true);
});

test('GET /api/lobby: 房间牌挂了仍给社区行（200 + errors.board），反之亦然', async () => {
  stubFetch(async (url) => COMMUNITY_OK(url));
  const noBoard = await callLobby('', fakeEnv({ fail: true }));
  assert.equal(noBoard.status, 200, 'one dead backend is not a failure of the whole call');
  const a = await noBoard.json();
  assert.deepEqual(a.errors, { board: 'UPSTREAM' });
  assert.equal(a.sources.board.ok, false);
  assert.equal(a.sources.board.count, 0);
  // 没有房间牌可去重时，rainya 那条同号房间就留下来了（去重只在有得比的时候发生）
  assert.deepEqual(a.rooms.map((r) => r.src), ['rainya', 'rainya', 'lunar', 'lunar']);
  assert.equal(a.visitors, undefined, 'no board read → no visitor count (never invented)');

  stubFetch(async () => jsonResponse({ error: 'boom' }, 500));
  const noRelay = await callLobby('', fakeEnv({ rooms: [boardRoom()] }));
  assert.equal(noRelay.status, 200);
  const b = await noRelay.json();
  assert.deepEqual(b.errors, { rainya: 'UPSTREAM', lunar: 'UPSTREAM' });
  assert.deepEqual(b.rooms.map((r) => [r.code, r.src]), [['AAAA', 'board']]);
  assert.equal(b.sources.board.ok, true);
});

test('GET /api/lobby: 只有两个后端都挂才是 502 no-store（绝不进 CDN）', async () => {
  stubFetch(async () => jsonResponse({ error: 'boom' }, 500));
  const res = await callLobby('', fakeEnv({ fail: true }));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'UPSTREAM');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('GET /api/lobby: 上游形状不对的源进 errors，不会以「来源不明」的身份混进牌面', async () => {
  // 归属靠中转逐行打 src，绝不猜：rainya 上游这次回的不是它该有的形状（没有 rooms 数组）→
  // 只把它标成 UPSTREAM，别的源与房间牌照常。
  stubFetch(async (url) => (url === 'https://game.rainya.me/api/rooms'
    ? jsonResponse({ items: [{ roomId: 'ZZZZ' }] })   // 错形状：rainya 应该回 { rooms: [...] }
    : jsonResponse({ items: [{ roomId: 'LMNP', hostName: 'x', occupied: 1, capacity: 4 }] })));
  const res = await callLobby('', fakeEnv({ rooms: [boardRoom()] }));
  const body = await res.json();
  assert.deepEqual(body.errors, { rainya: 'UPSTREAM' });
  assert.deepEqual(body.sources, {
    board: { ok: true, count: 1 },
    rainya: { ok: false, count: 0 },
    lunar: { ok: true, count: 1 },
  });
  assert.deepEqual(body.rooms.map((r) => [r.code, r.src]), [['AAAA', 'board'], ['LMNP', 'lunar']]);
});

test('GET /api/lobby: 不吃任何查询参数（同一端点只有一个边缘缓存键）', async () => {
  const log = stubFetch(async (url) => COMMUNITY_OK(url));
  for (const q of ['?x=1', '?src=rainya', '?cb=12345']) {
    const res = await callLobby(q);
    assert.equal(res.status, 400, `expected 400 for "${q}"`);
    assert.equal((await res.json()).error, 'BAD_QUERY');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  assert.equal(log.length, 0, 'a rejected request never dials upstream');

  const post = await worker.fetch(new Request('https://board.example.test/api/lobby', { method: 'POST' }), fakeEnv());
  assert.equal(post.status, 405);
  const options = await worker.fetch(new Request('https://board.example.test/api/lobby', { method: 'OPTIONS' }), fakeEnv());
  assert.equal(options.status, 204);
});

test('GET /api: 自描述索引 —— 端点表 + 接入信息，长缓存', async () => {
  const res = await worker.fetch(new Request('https://board.example.test/api'), fakeEnv());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.name, 'sp-lobby-board');
  assert.match(body.page, /^https:\/\/sp-lobby\.jiangjiangze\.icu\/$/);
  assert.match(body.docs, /stronghold-lobby#/);
  assert.deepEqual(body.sources, ['rainya', 'lunar']);
  const paths = body.endpoints.map((e) => `${e.method} ${e.path}`);
  for (const want of ['GET /api/lobby', 'GET /api/rooms', 'POST /api/rooms', 'GET /api/community?src=rainya,lunar',
                      'POST /api/match', 'GET /api/health', 'GET /']) {
    assert.ok(paths.includes(want), `index must list ${want}`);
  }
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const slash = await worker.fetch(new Request('https://board.example.test/api/'), fakeEnv());
  assert.equal(slash.status, 200, '/api/ is the same index');
});
