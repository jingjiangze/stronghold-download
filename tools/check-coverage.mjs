// 一次性体检：现网清单 vs verified 结论 vs 国内回执，看哪几台还缺版本/负载。
// node tools/check-coverage.mjs
// 注：这文件刻意不用模板字符串插值 —— 写文件那层的密钥遮蔽会把 ${...} 变成 *** 。
const B = 'https://weishucdn.jiangjiangze.icu/site/';

async function get(name) {
  const url = B + name + '?cb=' + String(Date.now()) + Math.random().toString(36).slice(2);
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  return r.json();
}

const list = await get('servers.json');
const ver = await get('verified.json');
const pings = await get('pings.json').catch(function () { return { pings: {} }; });
const occ = ver.occupancy || {};
const pingMap = pings.pings || {};

function has(o) { return !!(o && (o.rooms != null || o.humans != null || o.app || o.build)); }

console.log('清单 ' + list.servers.length + ' 条 (updated ' + list.updated + ') | verified ' + ver.updated
  + ' | listUpdated ' + ver.listUpdated + ' | 对得上:' + (ver.listUpdated === list.updated));
console.log('valid ' + ver.valid.length + ' / invalid ' + (ver.invalid || []).length
  + ' | 回执条目 ' + Object.keys(pingMap).length + ' | cooling ' + Object.keys(ver.backoff || {}).length);

(ver.invalid || []).forEach(function (x) { console.log('  x ' + x.id + ' ' + x.name + ' -- ' + x.reason); });

let sig = 0;
const missing = [];
list.servers.forEach(function (s) {
  const o = occ[s.id];
  const p = pingMap[s.id];
  if (has(o)) { sig++; return; }
  missing.push('  - 缺 ' + s.id + ' ' + s.name + ' [direct_cn=' + (s.direct_cn === true) + '] 回执='
    + (p ? ((p.ok ? 'ok' : 'dead') + ' ' + p.ms + 'ms rooms=' + (p.rooms == null ? '-' : p.rooms)
      + ' humans=' + (p.humans == null ? '-' : p.humans) + ' app=' + (p.app || '-')) : '无'));
});
console.log('有版本/负载：' + sig + '/' + list.servers.length);
missing.forEach(function (m) { console.log(m); });

const rows = Object.keys(pingMap).map(function (k) {
  const p = pingMap[k];
  return k + ':' + (p.ok ? 'UP' : 'x') + '/' + (p.cn ? 'CN' : p.country) + '/' + p.ms + 'ms'
    + '/h' + (p.humans == null ? '-' : p.humans) + 'r' + (p.rooms == null ? '-' : p.rooms)
    + '/hit' + (p.okHits || 0);
});
console.log('回执一览：' + rows.join('  ').slice(0, 1500));
