// 服务器排行接口的离线用例：node tests/ranking.test.mjs
// 盯住几件事（都是"抓取方能不能信这份榜"的前提）：
//   ① 只收录通过服务端校验（valid）且 enabled 的条目，rank 从 1 连续、按 score 降序；
//   ② 名次与前端 js/servers.js 的 sortedServers **同一口径**（用一份独立参考实现交叉验证顺序）；
//   ③ 延迟按同批百分位、版本读不到罚到最底、评价净分 ±4 杯软饱和 —— 三条不变式；
//   ④ 输出确定一致（同输入两次跑逐字节相同），且剥掉内部键、字段有长度上限；
//   ⑤ 边界：坏 url / 非 http(s) / verified 缺席 / 全空清单，都不崩。

import assert from 'node:assert/strict';

let pass = 0;
const results = [];
const ok = (name, fn) => {
  try { fn(); pass += 1; results.push('  ok  ' + name); }
  catch (err) { results.push('FAIL  ' + name + ' :: ' + (err && err.message)); }
};

const MOD = await import(new URL('../functions/api/servers/ranking.js', import.meta.url).href);
const { buildRanking, versionRank } = MOD;

// ---- ① versionRank 解析 -------------------------------------------------------------
ok('versionRank 解析点分号 / 读不到给 -1', () => {
  assert.ok(versionRank('0.1.3') > versionRank('0.1.2'));
  assert.ok(versionRank('0.2.0') > versionRank('0.1.9'));
  assert.equal(versionRank('v0.1.4'), versionRank('0.1.4'));
  assert.equal(versionRank(''), -1);
  assert.equal(versionRank(null), -1);
  assert.equal(versionRank('build-abc123'), -1);
});

// ---- 独立参考实现：把前端公式照抄一遍，用来交叉验证 buildRanking 的顺序 -------------
function referenceOrder(listDoc, verifiedDoc) {
  const v = verifiedDoc || {};
  const valid = new Set(v.valid || []);
  const occ = v.occupancy || {}, lat = v.latency || {}, vou = v.vouches || {};
  const rows = (listDoc.servers || []).filter((s) => s && s.enabled !== false && valid.has(s.id)).map((s) => {
    const o = occ[s.id] || {}, l = lat[s.id];
    const vc = vou[s.id] || {};
    return { id: s.id, app: o.app, ms: l && l.ms != null ? l.ms : null, net: (vc.good || 0) - (vc.bad || 0) };
  });
  const vr = (app) => { const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(app || '')); return m ? +m[1] * 1e12 + +m[2] * 1e8 + +(m[3] || 0) * 1e4 + +(m[4] || 0) : -1; };
  const msv = rows.map((r) => r.ms).filter((x) => x != null).map((x) => Math.round(x)).sort((a, b) => a - b);
  const mu = msv.filter((x, i) => i === 0 || x !== msv[i - 1]);
  const lsc = {}; mu.forEach((ms, i) => { lsc[ms] = mu.length > 1 ? 1 - i / (mu.length - 1) : 1; });
  const vseen = {}; rows.forEach((r) => { const k = vr(r.app); if (k > 0) vseen[k] = 1; });
  const vk = Object.keys(vseen).map(Number).sort((a, b) => a - b);
  const vsc = {}; vk.forEach((k, i) => { vsc[k] = vk.length > 1 ? i / (vk.length - 1) : 1; });
  const score = (r) => {
    const ls = r.ms == null ? 0.5 : (lsc[Math.round(r.ms)] ?? 0.5);
    const k = vr(r.app);
    const vs = k > 0 ? (vsc[k] ?? 0) : -0.2;
    const cs = r.net / (Math.abs(r.net) + 4);
    return 0.45 * ls + 0.30 * vs + 0.25 * cs;
  };
  return rows.slice().sort((a, b) => score(b) - score(a)).map((r) => r.id);
}

// ---- ② 名次 == 页面序（随机数据交叉验证）--------------------------------------------
ok('名次与前端参考实现顺序一致（随机 40 组）', () => {
  const rnd = (n) => Math.floor(Math.random() * n);
  for (let trial = 0; trial < 40; trial += 1) {
    const N = 6 + rnd(10);
    const servers = [], valid = [], occupancy = {}, latency = {}, vouches = {};
    for (let i = 0; i < N; i += 1) {
      const id = 'srv' + i;
      servers.push({ id, name: id, url: 'https://h' + i + '.example/', enabled: true });
      if (Math.random() > 0.2) valid.push(id);
      if (Math.random() > 0.3) occupancy[id] = { app: '0.' + rnd(3) + '.' + rnd(5), rooms: rnd(1200), humans: rnd(3000), variant: 'node' };
      if (Math.random() > 0.4) latency[id] = { ms: 50 + rnd(900), src: 'players-cn', n: 1 + rnd(8) };
      if (Math.random() > 0.5) vouches[id] = { good: rnd(6), bad: rnd(6) };
    }
    const listDoc = { servers };
    const verDoc = { valid, occupancy, latency, vouches };
    const mine = buildRanking(listDoc, verDoc).map((r) => r.id);
    const ref = referenceOrder(listDoc, verDoc);
    assert.deepEqual(mine, ref, 'trial ' + trial + ' 顺序不符');
  }
});

// ---- ③ 三条排序不变式 ----------------------------------------------------------------
const mk = (servers, verified) => buildRanking({ servers }, verified);
const entry = (id, url) => ({ id, name: id, url: url || ('https://' + id + '.example/'), enabled: true });

ok('延迟更低者名次更高（版本/评价相同）', () => {
  const servers = [entry('slow'), entry('fast')];
  const verified = {
    valid: ['slow', 'fast'],
    occupancy: { slow: { app: '0.1.0' }, fast: { app: '0.1.0' } },
    latency: { slow: { ms: 800 }, fast: { ms: 100 } },
  };
  const r = mk(servers, verified);
  assert.equal(r[0].id, 'fast');
  assert.equal(r[0].rank, 1);
  assert.equal(r[0].components.latency, 1);   // 最快 = 百分位 1
  assert.equal(r[1].components.latency, 0);   // 最慢 = 百分位 0
});

ok('版本读不到罚到最底（延迟相同时；与前端同口径，-0.2 是版本分量罚分）', () => {
  // 延迟相同 → 百分位并列，延迟分量不产生差异，只剩版本分量决定名次。
  // （前端同理：只有 2 台时延迟百分位跨度 0.45 会盖过版本罚分，所以这里必须让延迟相等才能隔离版本变量。）
  const servers = [entry('noversion'), entry('oldver')];
  const verified = {
    valid: ['noversion', 'oldver'],
    occupancy: { noversion: {}, oldver: { app: '0.1.0' } },
    latency: { noversion: { ms: 200 }, oldver: { ms: 200 } },
  };
  const r = mk(servers, verified);
  assert.equal(r[r.length - 1].id, 'noversion');
  assert.equal(r.find((x) => x.id === 'noversion').components.version, -0.2);
  assert.equal(r.find((x) => x.id === 'oldver').components.version, 1);
});

ok('评价净分 ±4 杯软饱和（大杯能翻盘但有限）', () => {
  const servers = [entry('a'), entry('b')];
  const base = {
    valid: ['a', 'b'],
    occupancy: { a: { app: '0.1.0' }, b: { app: '0.1.0' } },
    latency: { a: { ms: 100 }, b: { ms: 100 } },
  };
  const r1 = mk(servers, { ...base, vouches: { a: { good: 40, bad: 0 }, b: { good: 0, bad: 40 } } });
  assert.equal(r1[0].id, 'a');
  // 净分 +40 的 cup 分量应逼近但不超过 1（饱和）
  assert.ok(r1[0].components.cup > 0.9 && r1[0].components.cup <= 1);
});

// ---- ④ 收录范围 + 确定一致 + 字段裁剪 -------------------------------------------------
ok('只收录 valid 且 enabled；rank 连续、score 降序', () => {
  const servers = [entry('a'), entry('b'), entry('disabled'), entry('invalid')];
  servers[2].enabled = false;
  const verified = {
    valid: ['a', 'b', 'disabled'],
    occupancy: { a: { app: '0.1.0' }, b: { app: '0.1.0' }, disabled: { app: '0.1.0' } },
    latency: { a: { ms: 100 }, b: { ms: 200 } },
  };
  const r = mk(servers, verified);
  const ids = r.map((x) => x.id).sort();
  assert.deepEqual(ids, ['a', 'b']);   // disabled 被 enabled 挡、invalid 被 valid 挡
  assert.deepEqual(r.map((x) => x.rank), [1, 2]);
  for (let i = 1; i < r.length; i += 1) assert.ok(r[i - 1].score >= r[i].score);
});

ok('确定一致：同输入两次逐字节相同', () => {
  const servers = [entry('a'), entry('b'), entry('c')];
  const verified = {
    valid: ['a', 'b', 'c'],
    occupancy: { a: { app: '0.1.1', rooms: 500, humans: 800 }, b: { app: '0.1.2', rooms: 10 }, c: { app: '0.1.0' } },
    latency: { a: { ms: 120, src: 'players-cn', n: 5 }, b: { ms: 300, src: 'cn-probe' }, c: { ms: 60 } },
    vouches: { a: { good: 3, bad: 1 } },
    opens: { a: { total: 42 } },
  };
  assert.equal(JSON.stringify(mk(servers, verified)), JSON.stringify(mk(servers, verified)));
});

ok('剥掉内部键、字段有上限、含全部约定字段', () => {
  const servers = [{ id: 'x', name: 'n'.repeat(99), url: 'https://x.example/', enabled: true, note: 'm'.repeat(200) }];
  const verified = { valid: ['x'], occupancy: { x: { app: '0.1.0', rooms: 1500, humans: 10 } }, latency: { x: { ms: 88, src: 'players', n: 3 } } };
  const [row] = mk(servers, verified);
  assert.equal(row._rank, undefined);
  assert.equal(row._ms, undefined);
  assert.equal(row._net, undefined);
  assert.equal(row._score, undefined);
  assert.equal(row.name.length, 48);
  assert.equal(row.note.length, 80);
  assert.equal(row.load, 1);            // 1500/1000 钳到 1
  assert.equal(row.latency_ms, 88);
  assert.equal(row.opens_total, 0);
  for (const k of ['rank', 'id', 'name', 'url', 'scheme', 'app', 'rooms', 'humans', 'load',
    'latency_ms', 'latency_src', 'latency_samples', 'vouch_good', 'vouch_bad', 'opens_total',
    'score', 'components', 'variant', 'build', 'note']) {
    assert.ok(k in row, '缺字段 ' + k);
  }
});

// ---- ⑤ 边界：不崩 ---------------------------------------------------------------------
ok('坏 url / 非 http(s) / 缺 id 的条目跳过', () => {
  const servers = [
    { id: 'bad', url: 'not-a-url', enabled: true },
    { id: 'ftp', url: 'ftp://x.example/', enabled: true },
    { id: '', url: 'https://y.example/', enabled: true },
    entry('good'),
  ];
  const verified = { valid: ['bad', 'ftp', 'good'], occupancy: { good: { app: '0.1.0' } } };
  const r = mk(servers, verified);
  assert.deepEqual(r.map((x) => x.id), ['good']);
});

ok('verified 缺席：仍按版本+清单序出榜，不崩', () => {
  const servers = [entry('a'), entry('b')];
  const r = buildRanking({ servers }, null);
  assert.deepEqual(r.map((x) => x.id).sort(), ['a', 'b']);
  assert.ok(r.every((x) => x.latency_ms === null));
});

ok('空清单 / 非数组：返回空数组', () => {
  assert.deepEqual(buildRanking(null, null), []);
  assert.deepEqual(buildRanking({ servers: [] }, { valid: [] }), []);
});

console.log(results.join('\n'));
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
