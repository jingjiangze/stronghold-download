// 离线搬后台 + 退休闸门的离线用例：node tests/verify_retire.mjs
//
// 为什么要这两层（2026-10-12 用户口径）：分区只把探不到的条目挪进 invalid，前端按 valid 过滤，
// 但**游戏客户端读的是签名清单 site/servers.json**，那一栏对玩家仍然算"在线"。所以：
//   判死 → 立刻从公共清单搬进 site/offline.json（后台留档，每轮仍随探测，活过来自动搬回）；
//   在后台还要连续缺席（7 天，或 24 小时的确定性拒绝）→ 才永久退休，写 site/retired.json。
// 这里钉住的是别出事的那几条：不单边写两份文件、整片看不见时不搬、站长停用的不动、清单不会被搬空。
// 不打真实网络：globalThis.fetch 换成路由桩，R2 用内存 Map。

import assert from 'node:assert/strict';

const VERIFY = await import(new URL('../functions/api/servers/verify.js', import.meta.url).href);

let pass = 0;
const results = [];
async function ok(name, fn) {
  try { await fn(); pass += 1; results.push('  ok  ' + name); }
  catch (e) { results.push('FAIL  ' + name + ' :: ' + (e && e.message)); }
}

const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const pkcs8 = hex(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).slice(32);
const spki = hex(await crypto.subtle.exportKey('spki', pair.publicKey)).slice(24);

const GOOD = () => ({ ok: true, version: 1, app: '0.1.4', uptimeSec: 100, sockets: 1, sessions: 1,
  rooms: 3, matches: 1, humans: 5, bots: 0 });

function makeEnv(servers, extras) {
  const store = new Map();
  store.set('site/servers.json', JSON.stringify({ updated: 'L1', v: 1, keyId: 'sp-2026-10', servers }, null, 2));
  for (const k of Object.keys(extras || {})) {
    store.set(k, typeof extras[k] === 'string' ? extras[k] : JSON.stringify(extras[k]));
  }
  return {
    SP_SIGN_KEY: pkcs8, SP_PUB_KEY: spki,
    R2BUCKET: {
      get: async (k) => (store.has(k) ? { text: async () => store.get(k) } : null),
      put: async (k, v) => { store.set(k, String(v)); },
    },
    __store: store,
  };
}

const run = (env) => VERIFY.onRequestGet({ env, request: new Request('https://dl.test/api/servers/verify?force=1') })
  .then(async (r) => ({ status: r.status, body: JSON.parse(await r.text()) }));
const list = (env) => JSON.parse(env.__store.get('site/servers.json'));
const partition = (env) => JSON.parse(env.__store.get('site/verified.json'));
const backoffice = (env) => {
  const raw = env.__store.get('site/offline.json');
  return raw ? JSON.parse(raw) : null;
};

const dayMs = 24 * 3600 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const absent = (ms, extra) => ({ firstAbsentAt: ago(ms), lastOkAt: ago(ms + 60000), ...(extra || {}) });
/** 上一轮的分区结论：presence 是账本，offlineIds 是"这些条目此刻正压在后台"。 */
const prevDoc = (presence) => ({ updated: ago(60000), listUpdated: 'L1', valid: [], invalid: [],
  occupancy: {}, backoff: {}, evidence: {}, presence });
const offlineRecord = (id, host, extra) => ({ [id]: { entry: { id, name: id, url: `https://${host || id}.example`,
  probe: '/healthz', enabled: true }, reason: '上一轮判死', offlineSince: ago(2 * dayMs), ...(extra || {}) } });

const entry = (id, host) => ({ id, name: id, url: `https://${host || id}.example`, probe: '/healthz', enabled: true });

function stubRefused(hosts, kind) {
  globalThis.fetch = async (input) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    const host = new URL(url).hostname;
    if (hosts.some((h) => host.startsWith(h))) {
      const code = kind === 'dns' ? 'ENOTFOUND' : 'ECONNREFUSED';
      throw Object.assign(new TypeError(`connect ${code} ${host}`), { code });
    }
    return new Response(JSON.stringify(GOOD()), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

/* ---- ① 判死就搬后台，但不退休 ---------------------------------------------------------- */

stubRefused(['off']);
{
  const env = makeEnv([entry('off1'), entry('live1')]);
  const out = await run(env);
  await ok('本轮判死的条目搬进后台，公共清单里消失，但没被永久删除', () => {
    assert.deepEqual(out.body.moved_out.map((m) => m.id), ['off1'], JSON.stringify(out.body.moved_out));
    assert.equal(out.body.retired.length, 0, '首轮就退休是错的');
    assert.deepEqual(list(env).servers.map((s) => s.id), ['live1']);
    assert.ok(list(env).sig, '搬完必须重新签名，否则客户端整份拒读');
    const bo = backoffice(env);
    assert.equal(bo.count, 1);
    assert.equal(bo.entries.off1.entry.url, 'https://off1.example');
    assert.match(bo.entries.off1.reason, /ECONNREFUSED|连接失败/);
    assert.equal(out.body.offline_count, 1);
  });
}

/* ---- ② 后台条目活过来自动回前台 -------------------------------------------------------- */

stubRefused([]);   // 全部可达
{
  const env = makeEnv([entry('live1')], {
    'site/offline.json': { updated: ago(1000), count: 1, entries: offlineRecord('back9', 'back9') },
  });
  const out = await run(env);
  await ok('后台里的条目重新判活 → 搬回公共清单并从后台删除', () => {
    assert.deepEqual(out.body.moved_in.map((m) => m.id), ['back9'], JSON.stringify(out.body.moved_in));
    assert.deepEqual(list(env).servers.map((s) => s.id).sort(), ['back9', 'live1']);
    assert.equal(backoffice(env).count, 0, '搬回去之后后台不该再压着它');
    assert.ok(list(env).sig);
  });
}

/* ---- ③ 退休 = 从后台永久删除（两种判据） ------------------------------------------------ */

stubRefused(['gone']);
{
  const env = makeEnv([entry('keep1')], {
    'site/offline.json': { updated: ago(1000), count: 1, entries: offlineRecord('gone1', 'gone1') },
    'site/verified.json': prevDoc({ gone1: absent(8 * dayMs), keep1: { lastOkAt: ago(1000) } }),
  });
  const out = await run(env);
  await ok('后台条目连续 7 天读不到指纹 → 永久退休并留审计', () => {
    assert.deepEqual(out.body.retired.map((r) => r.id), ['gone1'], JSON.stringify(out.body.retired));
    assert.match(out.body.retired[0].why, /连续 8 天/);
    const log = JSON.parse(env.__store.get('site/retired.json'));
    assert.equal(log.entries[0].id, 'gone1');
    assert.ok(log.entries[0].offlineSince, '审计要带上它什么时候进的后台');
    assert.equal(backoffice(env).count, 0);
    assert.deepEqual(list(env).servers.map((s) => s.id), ['keep1'], '退休不该动公共清单里的活条目');
  });
}

stubRefused(['ref']);
{
  const env = makeEnv([entry('keep2')], {
    'site/offline.json': { updated: ago(1000), count: 1, entries: offlineRecord('ref1', 'ref1') },
    'site/verified.json': prevDoc({ ref1: absent(2 * dayMs, { refusedSince: ago(25 * 3600 * 1000) }),
                                    keep2: { lastOkAt: ago(1000) } }),
  });
  const out = await run(env);
  await ok('拒连满 24 小时 → 不等七天就退休（隧道拆了、端口关了是这种形状）', () => {
    assert.deepEqual(out.body.retired.map((r) => r.id), ['ref1']);
    assert.match(out.body.retired[0].why, /连续 25 小时/);
  });
}

/* ---- ④ 不许搬的几种情况 ------------------------------------------------------------------ */

globalThis.fetch = async (input) => {
  const host = new URL(String(typeof input === 'string' ? input : input.url)).hostname;
  if (host.startsWith('slow')) throw new TypeError('This operation was aborted');
  return new Response(JSON.stringify(GOOD()), { status: 200, headers: { 'content-type': 'application/json' } });
};
{
  const env = makeEnv([entry('slow'), { ...entry('off2'), enabled: false }, entry('ok1')]);
  const out = await run(env);
  await ok('超时（看不见）照搬后台，但站长停用的条目留在清单里', () => {
    assert.deepEqual(out.body.moved_out.map((m) => m.id), ['slow'], JSON.stringify(out.body.moved_out));
    assert.ok(list(env).servers.some((s) => s.id === 'off2'), 'enabled:false 归人管，不搬');
    assert.ok(list(env).servers.some((s) => s.id === 'ok1'), '活着的照常留着');
    assert.equal(out.body.retired.length, 0);
  });
}

{
  // 整轮一条都没判活 = 多半是我们自己的出口故障，不搬
  globalThis.fetch = async () => { throw new TypeError('This operation was aborted'); };
  const env = makeEnv([entry('a1'), entry('a2'), entry('a3')]);
  const out = await run(env);
  await ok('这一轮谁都判不了活时不搬（出口故障不能变成清空清单）', () => {
    assert.deepEqual(out.body.moved_out, []);
    assert.equal(list(env).servers.length, 3);
    assert.equal(backoffice(env), null, '没搬就不该写后台文件');
  });
}

{
  // 搬完公共清单会空 → 保底不搬
  stubRefused(['lonely']);
  const env = makeEnv([entry('lonely')], {
    'site/offline.json': { updated: ago(1000), count: 0, entries: {} },
  });
  const out = await run(env);
  await ok('只剩一条且它判死时不搬（公共清单不能空）', () => {
    assert.deepEqual(out.body.moved_out, []);
    assert.deepEqual(list(env).servers.map((s) => s.id), ['lonely']);
  });
}

/* ---- ⑤ 发布没成功时两份文件不能单边变 ------------------------------------------------------ */

stubRefused(['cdead']);
{
  const env = makeEnv([entry('cdead'), entry('calive')], {
    'site/offline.json': { updated: ago(1000), count: 0, entries: {} },
  });
  const put = env.R2BUCKET.put.bind(env.R2BUCKET);
  env.R2BUCKET.put = async (k, v) => {
    if (k === 'site/stable.json') {
      const doc = JSON.parse(env.__store.get('site/servers.json'));
      doc.updated = 'SOMEBODY-ELSE';           // 模拟"这一轮期间有人改了清单"
      env.__store.set('site/servers.json', JSON.stringify(doc));
    }
    return put(k, v);
  };
  const out = await run(env);
  await ok('撞并发时既不搬公共清单也不写后台账本（条目不能从两份文件之间掉掉）', () => {
    assert.deepEqual(out.body.moved_out, []);
    assert.deepEqual(list(env).servers.map((s) => s.id).sort(), ['calive', 'cdead']);
    const bo = backoffice(env);
    assert.equal(bo.count, 0, '后台账本必须保持原样，不能只写它一半');
    assert.deepEqual(bo.entries, {});
    assert.ok(partition(env).presence.cdead.firstAbsentAt, '缺席观察照旧记下，下一轮接着算');
  });
}

/* ---- ⑥ 后台上限 -------------------------------------------------------------------------- */

stubRefused(['x']);
{
  const entries = {};
  for (let i = 0; i < 62; i += 1) {
    entries['x' + i] = { entry: entry('x' + i), reason: '旧的', offlineSince: ago((i + 1) * 3600 * 1000) };
  }
  const servers = [entry('alive9')];
  for (let i = 0; i < 5; i += 1) servers.push(entry('x' + i));   // 这几台被重新投回公共清单
  const env = makeEnv(servers, { 'site/offline.json': { updated: ago(1000), count: 62, entries } });
  await run(env);
  await ok('后台超过 60 台时丢最老的，别让文件无限长', () => {
    const bo = backoffice(env);
    assert.ok(bo.count <= 60, 'count=' + bo.count);
    // 记的是"i 越大越旧"（offlineSince = ago((i+1) 小时)），而 x0..x4 这一轮被重新搬进后台、
    // offlineSince 刷新成最新，所以该被丢掉的是最老的 x61、x60
    assert.ok(!bo.entries.x61 && !bo.entries.x60, '最老的两条应该已经被丢掉');
    assert.ok(bo.entries.x5, '没那么旧的不能丢');
  });
}

console.log(results.join('\n'));
const failed = results.filter((l) => l.startsWith('FAIL')).length;
console.log('\n' + pass + ' 通过 / ' + (pass + failed) + ' 总计');
process.exit(failed ? 1 : 0);
