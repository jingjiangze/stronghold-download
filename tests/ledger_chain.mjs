// 台账入口的离线用例：node tests/ledger_chain.mjs
// 现网第一次跑就撞过一次：R2 对象上没有 .body()，只有 .text()/.json()/.body —— 写错就是整条 1101，
// 而"探针台账读不到"在站点侧是静默的（run-actions 会退回空台账），所以这几条要钉住。
// 语义沿用 Worker 版：同一把 x-scout-key、只接本站域名、写前必须能 JSON.parse、上限 900 KB。

import assert from 'node:assert/strict';

const LEDGER = await import(new URL('../functions/ledger.js', import.meta.url).href);

let pass = 0;
const lines = [];
async function ok(name, fn) {
  try { await fn(); pass += 1; lines.push('  ok  ' + name); }
  catch (e) { lines.push('FAIL  ' + name + ' :: ' + (e && e.message)); }
}

const SCOUT = 'k'.repeat(38);
const STATE_KEY = 'scout/state.json';

function makeEnv(seed) {
  const store = new Map(Object.entries(seed || {}));
  const writes = [];
  const env = {
    SCOUT_TOKEN: SCOUT,
    R2BUCKET: {
      get: async (k) => (store.has(k) ? { text: async () => String(store.get(k)) } : null),
      put: async (k, v) => { store.set(k, String(v)); writes.push(k); return { key: k }; },
    },
  };
  env.__writes = writes;
  env.__store = store;
  return env;
}

function req(method, body, key, host) {
  const headers = {};
  if (key !== null) headers['x-scout-key'] = key === undefined ? SCOUT : key;
  return new Request('https://' + (host || 'dl.jiangjiangze.icu') + '/ledger', {
    method, headers, body: body === undefined ? undefined : String(body),
  });
}

await ok('GET 没口令 → 403，且不碰桶', async () => {
  const env = makeEnv({ [STATE_KEY]: '{"a":1}' });
  const res = await LEDGER.onRequestGet({ request: req('GET', undefined, 'wrong'), env });
  assert.equal(res.status, 403);
  assert.equal(env.__writes.length, 0);
});

await ok('GET 外站域名 → 403', async () => {
  const res = await LEDGER.onRequestGet({ request: req('GET', undefined, null, 'evil.example'), env: makeEnv() });
  assert.equal(res.status, 403);
});

await ok('GET 有口令 → 回台账原文（不是 .body() 那种 1101）', async () => {
  const env = makeEnv({ [STATE_KEY]: '{"lastRun":"2026-10-06T20:27:11.305Z","seen":{"a":1}}' });
  const res = await LEDGER.onRequestGet({ request: req('GET'), env });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const j = await res.json();
  assert.equal(j.lastRun, '2026-10-06T20:27:11.305Z');
  assert.deepEqual(j.seen, { a: 1 });
});

await ok('GET 桶里还没有台账 → 回 {} 而不是 500', async () => {
  const res = await LEDGER.onRequestGet({ request: req('GET'), env: makeEnv() });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {});
});

await ok('POST 半截 JSON → 400 并且不覆盖原台账', async () => {
  const env = makeEnv({ [STATE_KEY]: '{"keep":"me"}' });
  const res = await LEDGER.onRequestPost({ request: req('POST', '{"a": '), env });
  assert.equal(res.status, 400);
  assert.equal(env.__writes.length, 0, '坏台账不能落盘');
  assert.equal(env.__store.get(STATE_KEY), '{"keep":"me"}');
});

await ok('POST 超上限 → 413', async () => {
  const env = makeEnv();
  const big = JSON.stringify({ blob: 'x'.repeat(900001) });
  const res = await LEDGER.onRequestPost({ request: req('POST', big), env });
  assert.equal(res.status, 413);
  assert.equal(env.__writes.length, 0);
});

await ok('POST 合法 → 落盘并回报字节数', async () => {
  const env = makeEnv();
  const body = '{"lastRun":"2026-10-09T14:00:00Z","seen":{}}';
  const res = await LEDGER.onRequestPost({ request: req('POST', body), env });
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.bytes, body.length);
  assert.equal(env.__store.get(STATE_KEY), body);
});

console.log(lines.join('\n'));
console.log(`${pass} 通过 / ${lines.length} 项`);
if (pass !== lines.length) process.exitCode = 1;
