// 退休闸门的离线用例：node tests/verify_retire.mjs
// 分区只把探不到的条目挪进 invalid，页面会藏，但**游戏客户端读的是签名清单本身** —— 于是死服
// 永远堆在清单里（2026-10-11 用户报「很多旧服务器还在」：33 条里 14 条四条出口都拿不到指纹）。
// 这里钉住六条边界：首轮不批量删、七天档、确定性拒绝 24 小时档、每轮上限、保底不清空、撞并发不宣布。
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
      put: async (k, v) => { store.set(k, typeof v === 'string' ? v : String(v)); },
    },
    __store: store,
  };
}

const run = (env) => VERIFY.onRequestGet({ env, request: new Request('https://dl.test/api/servers/verify?force=1') })
  .then(async (r) => ({ status: r.status, body: JSON.parse(await r.text()) }));
const list = (env) => JSON.parse(env.__store.get('site/servers.json'));
const partition = (env) => JSON.parse(env.__store.get('site/verified.json'));

const dayMs = 24 * 3600 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const absent = (ms, extra) => ({ firstAbsentAt: ago(ms), lastOkAt: ago(ms + 60000), ...(extra || {}) });
const prevDoc = (presence) => ({ updated: ago(60000), listUpdated: 'L1', valid: [], invalid: [],
  occupancy: {}, backoff: {}, evidence: {}, presence });

/** 指定 host 一律连不上，理由写成"确定性拒绝"的形状（拒连 / 查无此域名） */
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

const entry = (id, host) => ({ id, name: id, url: `https://${host || id}.example`, probe: '/healthz', enabled: true });

/* ---- ① 全新账本 ------------------------------------------------------------------- */

stubRefused(['z']);
{
  const env = makeEnv(Array.from({ length: 6 }, (_, i) => entry('z' + i)));
  const out = await run(env);
  await ok('上线首轮（没有 presence 记录）一条都不摘，但开始计缺席', () => {
    assert.deepEqual(out.body.retired, [], JSON.stringify(out.body.retired));
    assert.equal(list(env).servers.length, 6);
    assert.equal(out.body.absent_watch, 6);
    const p = partition(env).presence;
    assert.ok(p.z0 && Date.parse(p.z0.firstAbsentAt) > 0, '缺席起点要落进 verified.json');
  });
}

/* ---- ② 缺席满 7 天 ----------------------------------------------------------------- */

stubRefused(['old']);
{
  const env = makeEnv([entry('old1'), entry('live1')],
    { 'site/verified.json': prevDoc({ old1: absent(8 * dayMs), live1: { lastOkAt: ago(1000) } }) });
  const out = await run(env);
  await ok('连续 7 天四条出口都读不到指纹 → 从签名清单摘掉并留审计', () => {
    assert.deepEqual(out.body.retired.map((r) => r.id), ['old1'], JSON.stringify(out.body.retired));
    assert.match(out.body.retired[0].why, /连续 8 天/);
    const left = list(env).servers;
    assert.equal(left.length, 1);
    assert.equal(left[0].id, 'live1');
    assert.ok(left[0].url && list(env).sig, '摘完必须重新签名，否则客户端整份拒读');
    const log = JSON.parse(env.__store.get('site/retired.json'));
    assert.equal(log.entries[0].id, 'old1');
    assert.ok(log.entries[0].lastOkAt && log.entries[0].retiredAt, '审计要带最后一次活与退休时刻');
    assert.match(log.revive, /重新提交/, '要写清楚怎么复活');
  });
}

/* ---- ③ 只是"看不见"不该攒 24 小时那一档 ------------------------------------------------- */

globalThis.fetch = async () => { throw new TypeError('This operation was aborted'); };
{
  const seed = absent(3 * dayMs);
  const env = makeEnv([entry('slow')], { 'site/verified.json': prevDoc({ slow: seed }) });
  const out = await run(env);
  await ok('超时/看不见不触发"确定性拒绝"，缺席起点也不被改写', () => {
    assert.deepEqual(out.body.retired, []);
    assert.equal(list(env).servers.length, 1);
    const p = partition(env).presence.slow;
    assert.ok(!p.refusedSince, '拒绝计时不能被超时触发');
    assert.equal(p.firstAbsentAt, seed.firstAbsentAt, '起点一旦被记下就不再动');
  });
}

/* ---- ④ 确定性拒绝满 24 小时 ------------------------------------------------------------ */

stubRefused(['ref']);
{
  const env = makeEnv([entry('ref1'), entry('keep1')],
    { 'site/verified.json': prevDoc({ ref1: absent(2 * dayMs, { refusedSince: ago(25 * 3600 * 1000) }),
                                      keep1: { lastOkAt: ago(1000) } }) });
  const out = await run(env);
  await ok('拒连满 24 小时 → 不等七天就摘（隧道拆了、端口关了是这种形状）', () => {
    assert.deepEqual(out.body.retired.map((r) => r.id), ['ref1'], JSON.stringify(out.body.retired));
    assert.match(out.body.retired[0].why, /连续 25 小时/);
    assert.deepEqual(list(env).servers.map((s) => s.id), ['keep1']);
  });
}

/* ---- ⑤ 每轮上限 + 保底 ------------------------------------------------------------------ */

stubRefused(['m']);
{
  const servers = Array.from({ length: 8 }, (_, i) => entry('m' + i));
  const presence = {};
  for (let i = 0; i < 8; i += 1) presence['m' + i] = absent(10 * dayMs);
  const env = makeEnv(servers, { 'site/verified.json': prevDoc(presence) });
  const out = await run(env);
  await ok('一轮最多摘 5 条（整片出口抽风时不会清空清单）', () => {
    assert.equal(out.body.retired.length, 5);
    assert.equal(list(env).servers.length, 3);
  });
}

stubRefused(['only']);
{
  const env = makeEnv([entry('only1')], { 'site/verified.json': prevDoc({ only1: absent(40 * dayMs) }) });
  const out = await run(env);
  await ok('只剩一条时哪怕满 40 天也不摘（清单不能空）', () => {
    assert.deepEqual(out.body.retired, [], JSON.stringify(out.body.retired));
    assert.equal(list(env).servers.length, 1);
    assert.ok(!env.__store.has('site/retired.json'));
  });
}

/* ---- ⑥ 站长停用归人管 / 回到 valid 就清零计时 --------------------------------------------- */

stubRefused(['off']);
{
  const env = makeEnv([{ ...entry('off1'), enabled: false }, entry('back')],
    { 'site/verified.json': prevDoc({ off1: absent(30 * dayMs), back: absent(30 * dayMs) }) });
  const out = await run(env);
  await ok('enabled:false 不自动摘；本轮探到的条目把缺席计数清零', () => {
    assert.deepEqual(out.body.retired.map((r) => r.id), [], JSON.stringify(out.body.retired));
    assert.equal(list(env).servers.length, 2);
    const p = partition(env).presence.back;
    assert.ok(p.lastOkAt && !p.firstAbsentAt, '回到 valid 就该重新开始');
  });
}

/* ---- ⑦ 撞并发 --------------------------------------------------------------------------- */

stubRefused(['c']);
{
  const env = makeEnv([entry('c1')], { 'site/verified.json': prevDoc({ c1: absent(9 * dayMs) }) });
  const put = env.R2BUCKET.put.bind(env.R2BUCKET);
  env.R2BUCKET.put = async (k, v) => {
    if (k === 'site/stable.json') {
      const doc = JSON.parse(env.__store.get('site/servers.json'));
      doc.updated = 'SOMEBODY-ELSE';
      env.__store.set('site/servers.json', JSON.stringify(doc));
    }
    return put(k, v);
  };
  const out = await run(env);
  await ok('撞并发时不摘除、不宣布，也不写审计（缺席观察照旧留着）', () => {
    assert.deepEqual(out.body.retired, [], JSON.stringify(out.body.retired));
    assert.deepEqual(list(env).servers.map((s) => s.id), ['c1']);
    assert.ok(!env.__store.has('site/retired.json'), '没发布成功就不该留下"已退休"的记录');
    assert.ok(partition(env).presence.c1.firstAbsentAt, '下一轮接着算');
  });
}

console.log(results.join('\n'));
const failed = results.filter((l) => l.startsWith('FAIL')).length;
console.log('\n' + pass + ' 通过 / ' + (pass + failed) + ' 总计');
process.exit(failed ? 1 : 0);
