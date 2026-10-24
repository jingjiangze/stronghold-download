// 站点侧投递口的离线用例：node tests/ingest_chain.mjs
// 这个端点能代表维护者发布清单，所以只验四件事：口令与来源守门、submit→approve 的转调顺序、
// 「已在清单/已在队列」折成成功而不是失败、以及 approve 没签成时补签那一步真的写了 R2。
// 不打真实网络：globalThis.fetch 换成路由桩，R2 用内存 Map。

import assert from 'node:assert/strict';
import { makeDb } from './_db-stub.mjs';

let pass = 0;
const lines = [];
async function ok(name, fn) {
  try { await fn(); pass += 1; lines.push('  ok  ' + name); }
  catch (e) { lines.push('FAIL  ' + name + ' :: ' + (e && e.message)); }
}

const INGEST = await import(new URL('../functions/ingest.js', import.meta.url).href);

const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const pkcs8 = hex(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).slice(32);
const spki = hex(await crypto.subtle.exportKey('spki', pair.publicKey)).slice(24);
const SCOUT = 'a'.repeat(38);
const ENTRY = { id: 'mutest1', name: '测试服', url: 'https://example.test:8443/', probe: '/healthz' };

function makeEnv(seed) {
  const store = new Map(Object.entries(seed || {}));
  const writes = [];
  const env = {
    SCOUT_TOKEN: SCOUT,
    PUBLISH_KEY: 'pub-key',
    SP_SIGN_KEY: pkcs8,
    SP_PUB_KEY: spki,
    DB: makeDb(store, { onPut: (k) => writes.push(k) }),
  };
  env.__writes = writes;
  env.__store = store;
  return env;
}

function post(body, headers, host) {
  return new Request('https://' + (host || 'dl.jiangjiangze.icu') + '/ingest', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json', 'x-scout-key': SCOUT }, headers || {}),
    body: JSON.stringify(body),
  });
}

function stub(rules) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, admin: !!(init && init.headers && init.headers['x-admin-key']),
                 body: init && init.body ? JSON.parse(init.body) : null });
    for (const r of rules) if (u.includes(r.at)) {
      return new Response(JSON.stringify(r.body), { status: r.status || 200,
        headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ message: 'no rule' }), { status: 404 });
  };
  return calls;
}

const ctx = (req, env) => INGEST.onRequestPost({ request: req, env: env || makeEnv() });

await ok('口令不对 → 403，且不产生任何内部调用', async () => {
  const calls = stub([{ at: '/api/servers/submit', body: { ok: true, id: 'x' } }]);
  const res = await ctx(post({ servers: [ENTRY] }, { 'x-scout-key': 'wrong' }));
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

await ok('没口令 → 403', async () => {
  const bare = new Request('https://dl.jiangjiangze.icu/ingest', { method: 'POST', body: '{}' });
  assert.equal((await ctx(bare)).status, 403);
});

await ok('外站域名 → 403（不许当任意地址的转发器）', async () => {
  assert.equal((await ctx(post({ servers: [ENTRY] }, null, 'evil.example'))).status, 403);
});

await ok('servers[] 为空 → 400', async () => {
  assert.equal((await ctx(post({ servers: [] }))).status, 400);
});

await ok('submit→approve 两步都走维护者通道，id 从 submit 传到 approve', async () => {
  const calls = stub([
    { at: '/api/servers/submit', body: { ok: true, id: 'mutest1' } },
    { at: '/api/servers/review', body: { ok: true, action: 'approve', signed: true, count: 3,
                                          canonicalSha256: 'abc' } },
  ]);
  const j = await (await ctx(post({ servers: [ENTRY] }))).json();
  assert.deepEqual([j.results[0].ok, j.results[0].mode, j.results[0].signed, j.results[0].detail.count],
                   [true, 'published', true, 3]);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/api\/servers\/submit$/);
  assert.match(calls[1].url, /\/api\/servers\/review$/);
  assert.equal(calls[1].body.id, 'mutest1');
  assert.deepEqual(calls[0].body.servers, [ENTRY]);
  assert.ok(calls.every((c) => c.admin), '两步都必须带管理口令，否则边缘 403 那类会被自己的闸门挡回');
});

await ok('已在清单/队列 → 折成 already-listed 成功，不再 approve', async () => {
  const calls = stub([{ at: '/api/servers/submit', body: { ok: false, error: '该服务器已在待审核队列中' } }]);
  const j = await (await ctx(post({ servers: [ENTRY] }))).json();
  assert.equal(j.ok, true);
  assert.equal(j.results[0].mode, 'already-listed');
  assert.equal(calls.length, 1);
});

await ok('approve 失败 → 该条 ok:false 并带上状态码', async () => {
  stub([
    { at: '/api/servers/submit', body: { ok: true, id: 'mutest1' } },
    { at: '/api/servers/review', body: { ok: false, kept: true, error: '健康端点读不到版本号' }, status: 400 },
  ]);
  const j = await (await ctx(post({ servers: [ENTRY] }))).json();
  assert.equal(j.ok, false);
  assert.match(j.results[0].error, /^approve\(400\)/);
});

await ok('approve 没签成 → 补签并真的落盘', async () => {
  stub([
    { at: '/api/servers/submit', body: { ok: true, id: 'mutest1' } },
    { at: '/api/servers/review', body: { ok: true, action: 'approve', signed: false, needsSignature: true,
                                          count: 1 } },
  ]);
  const live = { updated: '2026-10-09T00:00:00.000Z', keyId: 'sp-2026-10', v: 1,
                 servers: [{ id: 'mutest1', name: '测试服', url: 'https://example.test:8443/' }] };
  const env = makeEnv({ 'site/servers.json': JSON.stringify(live) });
  const j = await (await ctx(post({ servers: [ENTRY] }, null, null), env)).json();
  assert.equal(j.results[0].signed, true);
  assert.ok(env.__writes.includes('site/servers.json'), '补签必须真的写 R2');
  const written = JSON.parse(env.__store.get('site/servers.json'));
  assert.ok(written.sig, '落盘那份要带 sig');
  // signServersDoc 内部就用配对公钥自校验过，验不过不会落盘，所以这里不再重复验一遍
});

await ok('单条异常不拖垮整批（一次投两条时各自有结果）', async () => {
  stub([
    { at: '/api/servers/submit', body: { ok: true, id: 'mutest1' } },
    { at: '/api/servers/review', body: { ok: true, signed: true, count: 4 } },
  ]);
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/submit')) {
      if (JSON.parse(init.body).servers[0].id === 'boom') throw new Error('网络断了');
      return new Response(JSON.stringify({ ok: true, id: 'mutest1' }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, signed: true, count: 4 }), { headers: { 'content-type': 'application/json' } });
  };
  const j = await (await ctx(post({ servers: [ENTRY, { id: 'boom', name: '坏的一条', url: 'https://b.test/' }] }))).json();
  assert.equal(j.results.length, 2);
  assert.equal(j.results[0].ok, true);
  assert.equal(j.results[1].ok, false);
  assert.match(j.results[1].error, /网络断了/);
  assert.equal(j.published, 1);
});

console.log(lines.join('\n'));
console.log(`${pass} 通过 / ${lines.length} 项`);
if (pass !== lines.length) process.exitCode = 1;
