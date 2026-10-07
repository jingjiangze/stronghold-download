// 提交兼容性与暂存区的离线用例：node tests/submit_compat.mjs
// 覆盖三件事 —— 地址归一化、失败分类（看不见 ≠ 不是）、以及"看不见就送暂存区而不是拒收"。
// 不打真实网络：globalThis.fetch 换成路由桩，R2/KV 用内存 Map。

import assert from 'node:assert/strict';

let pass = 0;
const results = [];
function ok(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass += 1; results.push('  ok  ' + name); },
    (err) => { results.push('FAIL  ' + name + ' :: ' + (err && err.message)); });
}

/* ---- module loading ------------------------------------------------------------------ */

const V = await import(new URL('../functions/api/_verify.js', import.meta.url).href);
const SUBMIT = await import(new URL('../functions/api/servers/submit.js', import.meta.url).href);
const REVIEW = await import(new URL('../functions/api/servers/review.js', import.meta.url).href);

/* ---- ed25519 keys for the signing path ------------------------------------------------ */

const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
// Ed25519 的 DER 前缀：pkcs8 是 16 字节包装（48→32 位裸私钥），spki 是 12 字节（44→32 位裸公钥）
const PKCS8_HEAD = 16, SPKI_HEAD = 12;
const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const pkcs8 = hex(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).slice(PKCS8_HEAD * 2);
const spki = hex(await crypto.subtle.exportKey('spki', pair.publicKey)).slice(SPKI_HEAD * 2);

/* ---- mocks ---------------------------------------------------------------------------- */

const GOOD = { ok: true, version: 1, app: '0.1.6-pre-skin', uptimeSec: 3794, sockets: 0, sessions: 1,
               rooms: 0, matches: 0, humans: 0, bots: 0 };

function res(body, status, type) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': type || (typeof body === 'string' ? 'text/html' : 'application/json') },
  });
}

/** fetch 路由桩：rules = [{ match(url), run(url) }]，match 命中就返回 Response 或抛错。 */
function stubFetch(rules) {
  const seen = [];
  globalThis.fetch = async (input) => {
    const url = String(typeof input === 'string' ? input : input.url);
    seen.push(url);
    for (const rule of rules) {
      if (!rule.match || rule.match(url)) return rule.run ? rule.run(url) : res(rule.body, rule.status, rule.type);
    }
    return res({ message: 'no rule' }, 404);
  };
  return seen;
}

function makeEnv(overrides, seed) {
  const store = new Map(Object.entries(seed || {}));
  const kv = new Map();
  const env = Object.assign({
    PUBLISH_KEY: 'pub-key',
    SP_SIGN_KEY: pkcs8,
    SP_PUB_KEY: spki,
    R2BUCKET: {
      get: async (k) => (store.has(k) ? { text: async () => store.get(k) } : null),
      put: async (k, v) => { store.set(k, typeof v === 'string' ? v : String(v)); return { key: k }; },
    },
    SERVER_REVIEW: {
      get: async (k) => (kv.has(k) ? kv.get(k) : null),
      put: async (k, v) => { kv.set(k, String(v)); },
      delete: async (k) => { kv.delete(k); },
    },
  }, overrides || {});
  env.__store = store;
  env.__kv = kv;
  return env;
}

function post(payload, ip, adminKey) {
  const headers = { 'content-type': 'application/json' };
  if (ip) headers['cf-connecting-ip'] = ip;
  if (adminKey) headers['x-admin-key'] = adminKey;
  return new Request('https://dl.test/api/servers/submit', {
    method: 'POST', body: JSON.stringify(payload), headers,
  });
}

const jsonOf = async (response) => JSON.parse(await response.text());

let hostSeq = 0;
const nextHost = () => `srv-${(hostSeq += 1)}.example`;

/* ---- A. normalizeTarget --------------------------------------------------------------- */

const NORM = [
  ['dx.frp-gap.com:29943', 'https://dx.frp-gap.com:29943'],
  ['https://dx.frp-gap.com:29943/', 'https://dx.frp-gap.com:29943'],
  ['HTTPS://DX.FRP-GAP.COM:29943//play', 'https://dx.frp-gap.com:29943/play'],
  ['  http://106.55.43.13:3000  ', 'http://106.55.43.13:3000'],
  ['host.example.com.', 'https://host.example.com'],
  ['game.rainya.me/play?room=AB12', 'https://game.rainya.me/play'],
  ['https://h.example/#frag', 'https://h.example'],
  ['https://user:pw@h.example', 'ERR'],
  ['ftp://h.example', 'ERR'],
  ['localhost:3000', 'ERR'],
  ['127.0.0.1:3000', 'ERR'],
  ['192.168.1.5', 'ERR'],
  ['', 'ERR'],
];
for (const [input, want] of NORM) {
  await ok('normalizeTarget ' + JSON.stringify(input), () => {
    const got = V.normalizeTarget(input);
    if (want === 'ERR') assert.ok(got.error, '应当报错，却得到 ' + JSON.stringify(got));
    else assert.equal(got.url, want);
  });
}

/* ---- B. classifyProbeFailure ---------------------------------------------------------- */

const CLS = [
  ['/healthz 返回 526', 'inconclusive'],
  ['/healthz 返回 403', 'inconclusive'],
  ['探测超时', 'inconclusive'],
  ['连接失败（TypeError）', 'inconclusive'],
  ['/healthz 响应不是 JSON', 'inconclusive'],
  ['不是卫戍协议服务器（ok 字段不是 true）', 'negative'],
  ['不是卫戍协议服务器（缺少字段 rooms）', 'negative'],
];
for (const [err, want] of CLS) {
  await ok('classify ' + err, () => assert.equal(V.classifyProbeFailure(err), want));
}

/* ---- C. sanitizeBrowserVerify --------------------------------------------------------- */

await ok('browserVerify: 非对象一律丢', () => {
  for (const junk of [null, undefined, 'x', 42, [], {}]) assert.equal(V.sanitizeBrowserVerify(junk), null);
});

await ok('browserVerify: 完整指纹 = protocol', () => {
  const out = V.sanitizeBrowserVerify({
    results: [{ path: '/healthz', kind: 'protocol', code: 200 }],
    fingerprint: GOOD, probePath: '/healthz', reachable: true, entryReachable: true,
  });
  assert.equal(out.level, 'protocol');
  assert.equal(out.fingerprint.app, '0.1.6-pre-skin');
  assert.equal(out.fingerprint.version, 1);
});

await ok('browserVerify: {"ok":true} 空壳不算指纹', () => {
  const out = V.sanitizeBrowserVerify({ fingerprint: { ok: true }, reachable: true });
  assert.ok(!out.fingerprint, '不该收下空壳');
  assert.equal(out.level, 'reachable');
});

await ok('browserVerify: 伪造字段被剥掉', () => {
  const out = V.sanitizeBrowserVerify({
    results: [{ path: '/healthz', kind: 'protocol' }, { path: 'evil', kind: 'nope' },
      ...Array.from({ length: 20 }, (_, i) => ({ path: '/p' + i, kind: 'http', code: 200 }))],
    fingerprint: Object.assign({}, GOOD, { direct_cn: true, admin: true, mega: 'x'.repeat(500), rooms: -5 }),
    probePath: '/healthz', reachable: true, published: true, isAdmin: true,
  });
  assert.equal(out.results.length, 8, '条数该被压到 8');
  assert.ok(!out.published && !out.isAdmin && !out.direct_cn, '客户端塞的放行字段必须丢');
  assert.ok(!out.fingerprint.mega && !out.fingerprint.admin && !out.fingerprint.direct_cn);
  assert.ok(out.fingerprint.rooms === undefined, '负数 rooms 不该留');
});

await ok('browserVerify: 绝对路径/非法 kind 被丢', () => {
  const out = V.sanitizeBrowserVerify({ results: [{ path: 'https://x/', kind: 'protocol' },
    { path: '/a', kind: 'whatever' }] });
  assert.ok(!out || !out.results, JSON.stringify(out));
});

/* ---- D. submit 的分流 ----------------------------------------------------------------- */

await ok('submit: 裸域名 + /healthz 正常 → 当场上线，名称回落成域名', async () => {
  const host = nextHost();
  stubFetch([{ match: (u) => u.includes('/healthz'), body: GOOD },
             { match: (u) => !u.includes('/api/') && !u.includes('/health'), body: res('<html>ok</html>') }]);
  const env = makeEnv();
  const out = await jsonOf(await SUBMIT.onRequestPost({ request: post({ servers: [{ url: host }] }, '1.1.1.1'), env }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.published, true, '该直接上线：' + JSON.stringify(out));
  const doc = JSON.parse(env.__store.get('site/servers.json'));
  assert.equal(doc.servers[0].url, 'https://' + host);
  assert.equal(doc.servers[0].name, host, '留空名称该回落成域名');
  assert.ok(doc.sig, '上线的清单必须已签名');
});

await ok('submit: 探针留空 → 挨个试，命中 /api/status 就记住它', async () => {
  const host = nextHost();
  const seen = stubFetch([
    { match: (u) => u.endsWith('/healthz') || u.endsWith('/health') || u.endsWith('/api/health'), body: 'not found', status: 404 },
    { match: (u) => u.endsWith('/api/status'), body: GOOD },
    { match: () => true, body: res('<html>ok</html>') },
  ]);
  const env = makeEnv();
  const out = await jsonOf(await SUBMIT.onRequestPost({ request: post({ servers: [{ url: 'https://' + host }] }, '1.1.1.2'), env }));
  assert.equal(out.published, true, JSON.stringify(out));
  const doc = JSON.parse(env.__store.get('site/servers.json'));
  assert.equal(doc.servers[0].probe, '/api/status');
  assert.ok(seen.some((u) => u.endsWith('/healthz')), '应当先敲过 /healthz');
});

await ok('submit: 边缘看不见（连接失败）→ 进暂存区并标注需要复核', async () => {
  const host = nextHost();
  stubFetch([{ match: () => true, run: () => { throw new TypeError('TLS 证书不可信'); } }]);
  const env = makeEnv();
  const out = await jsonOf(await SUBMIT.onRequestPost({ request: post({ servers: [{ url: 'https://' + host }] }, '1.1.1.3'), env }));
  assert.equal(out.ok, true, '不该再当场拒收');
  assert.equal(out.queued, true);
  assert.equal(out.review, true, '必须标成需要复核');
  assert.ok(/复核/.test(out.hint), out.hint);
  const rec = JSON.parse(env.__kv.get('pending/' + out.id));
  assert.equal(rec.needsReview, true);
  assert.equal(rec.verify.verdict, 'inconclusive');
  assert.ok(!rec.direct_cn, '匿名提交不能自己给自己担保');
});

await ok('submit: CF 526 也算看不见（不是拒收）', async () => {
  const host = nextHost();
  stubFetch([{ match: () => true, body: 'error 526', status: 526 }]);
  const env = makeEnv();
  const out = await jsonOf(await SUBMIT.onRequestPost({ request: post({ servers: [{ url: 'https://' + host }] }, '1.1.1.4'), env }));
  assert.equal(out.review, true, JSON.stringify(out));
});

await ok('submit: 看见它不是卫戍协议 + 无浏览器证据 → 仍然当场拒收', async () => {
  const host = nextHost();
  stubFetch([{ match: () => true, body: { ok: false, service: 'nextcloud' } }]);
  const env = makeEnv();
  const r = await SUBMIT.onRequestPost({ request: post({ servers: [{ url: 'https://' + host }] }, '1.1.1.5'), env });
  assert.equal(r.status, 400);
  assert.equal(env.__kv.size, 0, '被否决的不该进暂存区');
});

await ok('submit: 边缘否定 + 访客浏览器读到完整指纹 → 进暂存区让维护者判', async () => {
  const host = nextHost();
  stubFetch([{ match: () => true, body: { ok: false, nope: 1 } }]);
  const env = makeEnv();
  const out = await jsonOf(await SUBMIT.onRequestPost({
    request: post({ servers: [{ url: 'https://' + host }],
      browserVerify: { results: [{ path: '/healthz', kind: 'protocol', code: 200 }], fingerprint: GOOD,
        probePath: '/healthz', reachable: true, entryReachable: true } }, '1.1.1.6'), env }));
  assert.equal(out.queued, true, JSON.stringify(out));
  assert.equal(out.review, true);
  const rec = JSON.parse(env.__kv.get('pending/' + out.id));
  assert.equal(rec.browserVerify.level, 'protocol');
  assert.equal(rec.verify.verdict, 'negative', '两边矛盾要原样留给维护者');
});

await ok('submit: 同一个 host 重复进暂存区 → 409', async () => {
  const host = nextHost();
  stubFetch([{ match: () => true, run: () => { throw new TypeError('boom'); } }]);
  const env = makeEnv();
  const a = await jsonOf(await SUBMIT.onRequestPost({ request: post({ servers: [{ url: 'https://' + host }] }, '1.1.1.7'), env }));
  const b = await jsonOf(await SUBMIT.onRequestPost({ request: post({ servers: [{ url: 'https://' + host + '/play' }] }, '1.1.1.7'), env }));
  assert.ok(a.queued && /待审核队列/.test(b.error), JSON.stringify(b));
});

await ok('submit: 同一 IP 每小时最多 5 条进暂存区', async () => {
  stubFetch([{ match: () => true, run: () => { throw new TypeError('boom'); } }]);
  const env = makeEnv();
  let blocked = null;
  for (let i = 1; i <= 6; i += 1) {
    const host = nextHost();
    const out = await jsonOf(await SUBMIT.onRequestPost({ request: post({ servers: [{ url: 'https://' + host }] }, '1.1.1.8'), env }));
    if (out.error) blocked = { i, out };
  }
  assert.ok(blocked && blocked.i === 6, '第 6 条才该被挡：' + JSON.stringify(blocked));
  assert.ok(/上限/.test(blocked.out.error), blocked.out.error);
});

await ok('submit: 访客担保通道仍然生效（x-admin-key + 看不见 → 打 direct_cn）', async () => {
  const host = nextHost();
  stubFetch([{ match: () => true, run: () => { throw new TypeError('TLS'); } }]);
  const env = makeEnv();
  const out = await jsonOf(await SUBMIT.onRequestPost({
    request: post({ servers: [{ url: 'https://' + host, name: '盒子服' }] }, '1.1.1.9', 'pub-key'), env }));
  assert.equal(out.queued, true);
  const rec = JSON.parse(env.__kv.get('pending/' + out.id));
  assert.equal(rec.direct_cn, true, '带口令的投递链该按担保处理');
  assert.equal(rec.attestedBy, 'maintainer');
});

/* ---- D2. 证书旁路探针（第三种探测方法） ------------------------------------------------ */

const REPORT = (url, ageMin) => JSON.stringify({ updated: new Date().toISOString(), reports: {
  [url]: { at: new Date(Date.now() - (ageMin || 3) * 60000).toISOString(), ok: true, source: 'github-tls-probe',
    probePath: '/healthz', tls: 'untrusted-leaf', entryOk: true, entryStatus: 200,
    version: 1, app: '0.1.4', build: 'b590ac5fdad5', uptimeSec: 96, sockets: 1, sessions: 1,
    rooms: 0, matches: 0, humans: 0, bots: 0 } } });

await ok('submit: 边缘看不见 + 探针有完整指纹 → 当场上线并记 attested_by:tls-probe', async () => {
  const host = nextHost();
  stubFetch([{ match: () => true, run: () => { throw new TypeError('SSL 证书不可信'); } }]);
  const env = makeEnv({}, { 'site/probes.json': REPORT('https://' + host) });
  const out = await jsonOf(await SUBMIT.onRequestPost({ request: post({ servers: [{ url: 'https://' + host }] }, '1.1.1.10'), env }));
  assert.equal(out.published, true, JSON.stringify(out));
  assert.ok(/证书旁路探针/.test(out.hint), out.hint);
  const entry = JSON.parse(env.__store.get('site/servers.json')).servers[0];
  assert.equal(entry.direct_cn, true, '边缘握不上手的必须按"越过边缘探测"记账');
  assert.equal(entry.attested_by, 'tls-probe');
  assert.equal(entry.probe, '/healthz');
});

await ok('submit: 探针报告过期 → 仍然只进暂存区', async () => {
  const host = nextHost();
  stubFetch([{ match: () => true, run: () => { throw new TypeError('SSL 证书不可信'); } }]);
  const env = makeEnv({}, { 'site/probes.json': REPORT('https://' + host, 13 * 60) });
  const out = await jsonOf(await SUBMIT.onRequestPost({ request: post({ servers: [{ url: 'https://' + host }] }, '1.1.1.11'), env }));
  assert.equal(out.queued, true, JSON.stringify(out));
  assert.equal(out.review, true);
});

await ok('submit: 边缘否定与探针冲突时不信探针（只补"看不见"）', async () => {
  const host = nextHost();
  stubFetch([{ match: () => true, body: { ok: false, not: 'protocol' } }]);
  const env = makeEnv({}, { 'site/probes.json': REPORT('https://' + host) });
  const out = await jsonOf(await SUBMIT.onRequestPost({ request: post({ servers: [{ url: 'https://' + host }] }, '1.1.1.12'), env }));
  assert.equal(out.published, undefined, JSON.stringify(out));
  assert.equal(out.queued, true, '有浏览器证据以外的矛盾该留给人判');
});

await ok('submit: 进暂存区时登记到 site/recheck.json（探针的待办）', async () => {
  const host = nextHost();
  stubFetch([{ match: () => true, run: () => { throw new TypeError('TLS'); } }]);
  const env = makeEnv();
  const out = await jsonOf(await SUBMIT.onRequestPost({ request: post({ servers: [{ url: 'https://' + host }] }, '1.1.1.13'), env }));
  assert.equal(out.queued, true);
  const recheck = JSON.parse(env.__store.get('site/recheck.json'));
  assert.equal(recheck.items[0].url, 'https://' + host);
  assert.equal(recheck.items[0].tries, 1);
  // 同一条再报一次：不新增，只加计数
  await SUBMIT.onRequestPost({ request: post({ servers: [{ url: 'https://' + host + '/' }] }, '1.1.1.13'), env })
    .then(async (r) => { await r.text(); });
});

/* ---- E. review 的暂存区处置 ------------------------------------------------------------ */

async function seedQueue(env, record) {
  await env.SERVER_REVIEW.put('pending/' + record.id, JSON.stringify(record));
  const idx = JSON.parse((await env.SERVER_REVIEW.get('pending_index')) || '[]');
  idx.push(record.id);
  await env.SERVER_REVIEW.put('pending_index', JSON.stringify(idx));
}

function reviewPost(body, adminKey) {
  return new Request('https://dl.test/api/servers/review', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
  });
}

const baseRecord = (host, extra) => Object.assign({
  id: 'q-' + host, name: '风落尘埃定服', url: 'https://' + host, probe: '/healthz', enabled: true,
  submittedAt: new Date().toISOString(), submittedBy: '9.9.9.9',
  verify: { ok: false, verdict: 'inconclusive', error: '连接失败（TypeError）' },
  browserVerify: null, needsReview: true, reviewReason: '边缘探测看不见这台服务器',
}, extra || {});

await ok('review: 没带 force 的 approve 失败时条目留在暂存区', async () => {
  const host = nextHost();
  stubFetch([{ match: () => true, run: () => { throw new TypeError('TLS'); } }]);
  const env = makeEnv();
  await seedQueue(env, baseRecord(host));
  const out = await jsonOf(await REVIEW.onRequestPost({ request: reviewPost({ id: 'q-' + host, action: 'approve' }, 'pub-key'), env }));
  assert.equal(out.ok, false);
  assert.equal(out.kept, true, '不该把报料销毁');
  assert.ok(await env.SERVER_REVIEW.get('pending/q-' + host), '记录必须还在');
});

await ok('review: 复核时边缘又能看见了 → 正常上线，不需要担保', async () => {
  const host = nextHost();
  const seen = stubFetch([
    { match: (u) => u.endsWith('/healthz') || u.endsWith('/health'), body: 'nope', status: 404 },
    { match: (u) => u.endsWith('/api/status') || u.endsWith('/api/health'), body: GOOD },
    { match: () => true, body: res('<html>ok</html>') },
  ]);
  const env = makeEnv();
  await seedQueue(env, baseRecord(host));
  const out = await jsonOf(await REVIEW.onRequestPost({ request: reviewPost({ id: 'q-' + host, action: 'approve' }, 'pub-key'), env }));
  assert.equal(out.ok, true, JSON.stringify(out));
  const doc = JSON.parse(env.__store.get('site/servers.json'));
  const entry = doc.servers[doc.servers.length - 1];
  assert.equal(entry.probe, '/api/status', '复核时也该挨个试路径，并记住命中的那条');
  assert.ok(!entry.direct_cn, '边缘亲眼验过的不该打担保标记');
  assert.ok(seen.some((u) => u.endsWith('/healthz')));
  assert.equal(await env.SERVER_REVIEW.get('pending/q-' + host), null, '上线后该出队');
});

await ok('review: force + 边缘始终看不见 → 带 direct_cn 与维护者担保上线', async () => {
  const host = nextHost();
  stubFetch([{ match: () => true, run: () => { throw new TypeError('TLS 证书不可信'); } }]);
  const env = makeEnv();
  await seedQueue(env, baseRecord(host, { browserVerify: { level: 'reachable', reachable: true, entryReachable: true } }));
  const out = await jsonOf(await REVIEW.onRequestPost({ request: reviewPost({ id: 'q-' + host, action: 'approve', force: true }, 'pub-key'), env }));
  assert.equal(out.ok, true, JSON.stringify(out));
  const doc = JSON.parse(env.__store.get('site/servers.json'));
  const entry = doc.servers[doc.servers.length - 1];
  assert.equal(entry.direct_cn, true, '复核放行必须留下担保标记');
  assert.equal(entry.attested_by, 'maintainer');
  assert.equal(entry.name, '风落尘埃定服');
});

await ok('review: 边缘否定 + 没有浏览器证据 → force 也不给上', async () => {
  const host = nextHost();
  stubFetch([{ match: () => true, body: { ok: false, other: 'service' } }]);
  const env = makeEnv();
  await seedQueue(env, baseRecord(host, { verify: { ok: false, verdict: 'negative', error: '不是卫戍协议服务器（ok 字段不是 true）' } }));
  const out = await jsonOf(await REVIEW.onRequestPost({ request: reviewPost({ id: 'q-' + host, action: 'approve', force: true }, 'pub-key'), env }));
  assert.equal(out.ok, false, '光有口令不够，得有证据');
  assert.ok(await env.SERVER_REVIEW.get('pending/q-' + host));
});

await ok('review: 边缘否定 + 访客浏览器完整指纹 → force 可上并记担保来源', async () => {
  const host = nextHost();
  stubFetch([{ match: () => true, body: { ok: false, other: 'service' } }]);
  const env = makeEnv();
  await seedQueue(env, baseRecord(host, {
    verify: { ok: false, verdict: 'negative', error: '不是卫戍协议服务器（ok 字段不是 true）' },
    browserVerify: { level: 'protocol', fingerprint: GOOD, probePath: '/healthz', reachable: true },
  }));
  const out = await jsonOf(await REVIEW.onRequestPost({ request: reviewPost({ id: 'q-' + host, action: 'approve', force: true }, 'pub-key'), env }));
  assert.equal(out.ok, true, JSON.stringify(out));
  const doc = JSON.parse(env.__store.get('site/servers.json'));
  assert.equal(doc.servers[doc.servers.length - 1].attested_by, 'maintainer+browser-proof');
});

await ok('review: 访客指定过探针时不乱敲别的门', async () => {  const host = nextHost();
  const seen = stubFetch([{ match: (u) => u.endsWith('/api/status'), body: GOOD },
                          { match: () => true, body: { ok: false, nope: 1 } }]);
  const env = makeEnv();
  await seedQueue(env, baseRecord(host, { probe: '/api/status', probeFromVisitor: true }));
  const out = await jsonOf(await REVIEW.onRequestPost({ request: reviewPost({ id: 'q-' + host, action: 'approve' }, 'pub-key'), env }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(!seen.some((u) => u.endsWith('/healthz')), '指定过就不该再敲 /healthz（可能被反代首页判成否定）');
});

await ok('review: 探针已确认的条目点「通过」不需要 force 担保', async () => {
  const host = nextHost();
  stubFetch([{ match: () => true, run: () => { throw new TypeError('TLS 不可信'); } }]);
  const env = makeEnv({}, { 'site/probes.json': REPORT('https://' + host) });
  await seedQueue(env, baseRecord(host));
  const out = await jsonOf(await REVIEW.onRequestPost({ request: reviewPost({ id: 'q-' + host, action: 'approve' }, 'pub-key'), env }));
  assert.equal(out.ok, true, JSON.stringify(out));
  const entry = JSON.parse(env.__store.get('site/servers.json')).servers.slice(-1)[0];
  assert.equal(entry.attested_by, 'tls-probe');
  assert.equal(entry.direct_cn, true);
  assert.equal(await env.SERVER_REVIEW.get('pending/q-' + host), null);
});

await ok('submit: 队列里躺着同一条，但探针已确认 → 顶掉旧记录并直接上线', async () => {
  const host = nextHost();
  stubFetch([{ match: () => true, run: () => { throw new TypeError('TLS 不可信'); } }]);
  const env = makeEnv();
  const first = await jsonOf(await SUBMIT.onRequestPost({ request: post({ servers: [{ url: 'https://' + host }] }, '1.1.1.14'), env }));
  assert.equal(first.queued, true, JSON.stringify(first));
  // 探针跑完一轮（同一来源再次提交，这次 site/probes.json 已经有完整指纹）
  const env2 = makeEnv({}, { 'site/probes.json': REPORT('https://' + host) });
  env2.SERVER_REVIEW = env.SERVER_REVIEW;   // 共用队列：模拟同一份 KV
  env2.__store.set('site/servers.json', env.__store.get('site/servers.json'));
  const second = await jsonOf(await SUBMIT.onRequestPost({ request: post({ servers: [{ url: 'https://' + host }] }, '1.1.1.14'), env: env2 }));
  assert.equal(second.published, true, '不该再吃 409：' + JSON.stringify(second));
  assert.equal(await env.SERVER_REVIEW.get('pending/' + first.id), null, '旧的待审记录该被新证据顶掉');
  const idx = JSON.parse(await env.SERVER_REVIEW.get('pending_index'));
  assert.ok(!idx.includes(first.id), '索引里也不该留旧 id');
});

/* ---- report --------------------------------------------------------------------------- */

console.log(results.join('\n'));
const failed = results.filter((line) => line.startsWith('FAIL')).length;
console.log('\n' + pass + ' 通过 / ' + (pass + failed) + ' 总计');
process.exit(failed ? 1 : 0);
