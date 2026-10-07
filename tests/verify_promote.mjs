// 证书旁路探针 + 「待核」自动转正的离线用例：node tests/verify_promote.mjs
// 覆盖 GET /api/servers/verify 的四件事：
//   ① 带预发布后缀的版本号（0.1.6-pre-skin）不再被当成"探不到版本号"；
//   ② 边缘看不见、但 site/probes.json 有完整指纹的条目留在前台，并留下 tls-probe 证据；
//   ③ 「（待核）」按两条判据去掉（去重点击人数 > 5，或连续通过满一天），并真的重签发布；
//   ④ 没够判据的不动，撞并发时不改名。

import assert from 'node:assert/strict';

let pass = 0;
const results = [];
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass += 1; results.push('  ok  ' + name); },
  (err) => results.push('FAIL  ' + name + ' :: ' + (err && err.message)));

const VERIFY = await import(new URL('../functions/api/servers/verify.js', import.meta.url).href);

const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const pkcs8 = hex(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).slice(32);
const spki = hex(await crypto.subtle.exportKey('spki', pair.publicKey)).slice(24);

const GOOD = (app) => ({ ok: true, version: 1, app: app || '0.1.4', uptimeSec: 100, sockets: 1,
  sessions: 1, rooms: 3, matches: 1, humans: 5, bots: 0 });

/** fetch 路由桩：blind = 这些 host 一律连不上（模拟自签证书 / 防火墙） */
function stubFetch(blind) {
  globalThis.fetch = async (input) => {
    const url = String(typeof input === 'string' ? input : input.url);
    const host = new URL(url).hostname;
    if (blind.some((b) => host.startsWith(b))) throw new TypeError('SSL 证书不可信');
    return new Response(JSON.stringify(GOOD()), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function makeEnv(servers, extras) {
  const store = new Map();
  store.set('site/servers.json', JSON.stringify({ updated: 'L1', v: 1, keyId: 'sp-2026-10', servers }, null, 2));
  for (const k of Object.keys(extras || {})) store.set(k, typeof extras[k] === 'string' ? extras[k] : JSON.stringify(extras[k]));
  const env = {
    SP_SIGN_KEY: pkcs8, SP_PUB_KEY: spki,
    R2BUCKET: {
      get: async (k) => (store.has(k) ? { text: async () => store.get(k) } : null),
      put: async (k, v) => { store.set(k, typeof v === 'string' ? v : String(v)); },
    },
    __store: store,
  };
  return env;
}

const seen = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => ['tag' + i, Date.now()]));
const run = (env) => VERIFY.onRequestGet({ env, request: new Request('https://dl.test/api/servers/verify?force=1') })
  .then(async (r) => ({ status: r.status, body: JSON.parse(await r.text()) }));
const list = (env) => JSON.parse(env.__store.get('site/servers.json'));
const partition = (env) => JSON.parse(env.__store.get('site/verified.json'));

/* ---- ① 预发布版本号 ------------------------------------------------------------------ */

{
  stubFetch([]);
  const env = makeEnv([{ id: 'skin', name: '皮肤服', url: 'https://skin.example', probe: '/healthz', enabled: true }]);
  const out = await run(env);
  await ok('预发布后缀的 app 版本号不再被判"探不到版本号"', () => {
    assert.equal(out.body.invalid.filter((i) => /探不到版本号/.test(i.reason)).length, 0, JSON.stringify(out.body.invalid));
    assert.ok(out.body.valid >= 1);
  });
}

{
  stubFetch([]);
  const GOOD2 = GOOD(); GOOD2.app = '0.1.6-pre-skin';
  globalThis.fetch = async () => new Response(JSON.stringify(GOOD2), { status: 200, headers: { 'content-type': 'application/json' } });
  const env = makeEnv([{ id: 'skin2', name: '皮肤服2', url: 'https://skin2.example', probe: '/healthz', enabled: true }]);
  await run(env);
  await ok('occupancy 带上皮肤分支的 app 原文', () => {
    assert.equal(partition(env).occupancy.skin2.app, '0.1.6-pre-skin');
    assert.deepEqual(partition(env).valid, ['skin2']);
  });
}

/* ---- ② 证书旁路探针救回看不见的前台条目 ----------------------------------------------- */

{
  stubFetch(['dx']);
  const report = { updated: new Date().toISOString(), reports: {
    'https://dx.example:29943': { at: new Date().toISOString(), ok: true, source: 'github-tls-probe',
      probePath: '/healthz', tls: 'untrusted-leaf', entryOk: true,
      version: 1, app: '0.1.4', build: 'b590ac5', uptimeSec: 96, sockets: 1, sessions: 1,
      rooms: 0, matches: 0, humans: 0, bots: 0 } } };
  const env = makeEnv([{ id: 'dx', name: '风落尘埃定服', url: 'https://dx.example:29943', probe: '/healthz', enabled: true }],
    { 'site/probes.json': report });
  await run(env);
  await ok('边缘看不见 + 探针有完整指纹 → 留前台并记 tls-probe 证据', () => {
    const v = partition(env);
    assert.deepEqual(v.valid, ['dx']);
    assert.equal(v.evidence.dx.via, 'tls-probe');
    assert.equal(v.evidence.dx.probePath, '/healthz');
    assert.equal(v.occupancy.dx.app, '0.1.4');
    assert.equal(v.occupancy.dx.rooms, 0);
  });

  // 没有报告时同一条应该掉进 invalid（对照组，证明上一例真的是报告起的作用）
  const env2 = makeEnv([{ id: 'dx', name: '风落尘埃定服', url: 'https://dx.example:29943', probe: '/healthz', enabled: true }]);
  await run(env2);
  await ok('对照：没有探针报告时它确实进 invalid', () => {
    assert.deepEqual(partition(env2).valid, []);
    assert.equal(partition(env2).invalid[0].id, 'dx');
  });

  // 过期报告不该救活
  const stale = JSON.parse(JSON.stringify(report));
  stale.reports['https://dx.example:29943'].at = new Date(Date.now() - 13 * 3600e3).toISOString();
  const env3 = makeEnv([{ id: 'dx', name: 'x', url: 'https://dx.example:29943', probe: '/healthz', enabled: true }],
    { 'site/probes.json': stale });
  await run(env3);
  await ok('12 小时外的探针报告不信', () => assert.deepEqual(partition(env3).valid, []));
}

/* ---- ②b direct_cn 条目也必须吃得到探针读数（现网踩过的坑） ----------------------------- */

{
  stubFetch(['dxdc']);
  const report = { updated: new Date().toISOString(), reports: {
    'https://dxdc.example:29943': { at: new Date().toISOString(), ok: true, source: 'github-tls-probe',
      probePath: '/healthz', tls: 'untrusted-leaf', entryOk: true, version: 1, app: '0.1.4',
      uptimeSec: 96, sockets: 1, sessions: 1, rooms: 2, matches: 1, humans: 7, bots: 0 } } };
  const env = makeEnv([{ id: 'dxdc', name: 'dx 服', url: 'https://dxdc.example:29943', probe: '/healthz',
                         enabled: true, direct_cn: true, attested_by: 'tls-probe' }],
    { 'site/probes.json': report });
  await run(env);
  await ok('带 direct_cn 的条目：探针分支排在 direct_cn 兜底之前，否则空白 occupancy 会被"探不到版本号"打回', () => {
    const v = partition(env);
    assert.deepEqual(v.valid, ['dxdc'], JSON.stringify(v.invalid));
    assert.equal(v.occupancy.dxdc.app, '0.1.4');
    assert.equal(v.occupancy.dxdc.humans, 7);
    assert.equal(v.evidence.dxdc.via, 'tls-probe');
  });
}

/* ---- ③ 「待核」转正 ------------------------------------------------------------------- */

const pending = (id, name) => ({ id, name: name || `${id}.example（待核）`, url: `https://${id}.example`, probe: '/healthz', enabled: true });

{
  stubFetch([]);
  const env = makeEnv([pending('busy'), pending('steady'), pending('newbie')], {
    'site/opens.json': { opens: { busy: { total: 9, today: 2, day: new Date().toISOString().slice(0, 10), at: null, seen: seen(6) },
                                   steady: { total: 2, today: 1, day: new Date().toISOString().slice(0, 10), at: null, seen: seen(1) },
                                   newbie: { total: 2, today: 1, day: new Date().toISOString().slice(0, 10), at: null, seen: seen(2) } } },
    'site/stable.json': { stable: {
      steady: { since: new Date(Date.now() - 26 * 3600e3).toISOString() },
      newbie: { since: new Date(Date.now() - 3600e3).toISOString() } } },
  });
  const out = await run(env);
  const doc = list(env);
  await ok('去重点击人数 > 5 → 去掉（待核）并重签发布', () => {
    assert.equal(doc.servers.find((s) => s.id === 'busy').name, 'busy.example');
    assert.ok(doc.sig, '改名后必须重签，否则客户端会整份拒收');
    assert.equal(out.body.promoted.find((p) => p.id === 'busy').why, '6 位玩家点过「打开」');
  });
  await ok('连续通过满一天 → 去掉（待核）', () => {
    assert.equal(doc.servers.find((s) => s.id === 'steady').name, 'steady.example');
    assert.equal(out.body.promoted.find((p) => p.id === 'steady').why, '连续校验通过满一天');
  });
  await ok('两条判据都没够 → 一个字都不改', () => {
    assert.equal(doc.servers.find((s) => s.id === 'newbie').name, 'newbie.example（待核）');
    assert.ok(!out.body.promoted.some((p) => p.id === 'newbie'));
  });
  await ok('改名写进发布审计（via:auto-promote）', () => {
    const log = JSON.parse(env.__store.get('site/publish-log.json'));
    const hit = log.entries.filter((e) => e.via === 'auto-promote');
    assert.equal(hit.length, 1);
    assert.ok(/busy,steady/.test(hit[0].entryId));
  });
  await ok('连续通过的起点开始记账，掉回 invalid 的清零', () => {
    const st = JSON.parse(env.__store.get('site/stable.json')).stable;
    assert.ok(Date.parse(st.busy.since) && Date.parse(st.newbie.since));
    assert.equal(st.missing, undefined);
  });
}

{
  // 并发：清单在探测期间被别人改过（乐观并发挡住）→ 不许改名，也不许对外宣布转正
  stubFetch([]);
  const env = makeEnv([pending('busy')], {
    'site/opens.json': { opens: { busy: { total: 9, today: 2, day: new Date().toISOString().slice(0, 10), at: null, seen: seen(9) } } },
  });
  const put = env.R2BUCKET.put;
  env.R2BUCKET.put = async (k, v) => {
    if (k === 'site/stable.json') {
      // 模拟"上一轮之后有人改了清单"：把 servers.json 的 updated 换掉
      const doc = JSON.parse(env.__store.get('site/servers.json'));
      doc.updated = 'SOMEBODY-ELSE';
      env.__store.set('site/servers.json', JSON.stringify(doc));
    }
    return put(k, v);
  };
  const out = await run(env);
  await ok('撞并发时不改名也不宣布转正', () => {
    assert.equal(list(env).servers[0].name, 'busy.example（待核）');
    assert.equal(out.body.promoted.length, 0);
  });
}

console.log(results.join('\n'));
const failed = results.filter((l) => l.startsWith('FAIL')).length;
console.log('\n' + pass + ' 通过 / ' + (pass + failed) + ' 总计');
process.exit(failed ? 1 : 0);
