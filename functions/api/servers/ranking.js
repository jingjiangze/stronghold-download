// Pages Function: GET /api/servers/ranking
// 服务器排行的公开只读接口 —— 给抓取方（脚本/机器人/第三方榜单）一份干净的 JSON，
// 不用解析 HTML。名次与 /servers 页面上玩家看到的顺序**同一算法、同一数据源**算出。
//
// 数据来源（全部读 R2 两个固定键，**不 fetch 任何用户提供的地址**，无 SSRF 面）：
//   · site/servers.json  —— 清单（id/name/url/enabled/note）
//   · site/verified.json —— 服务端校验分区 + 共享延迟 + 房间/人数 + 大杯小杯 + 打开数
//
// 与网页的**唯一**差异：网页的延迟列掺了访客本机实测，排序权重用的是共享值；本接口
// 只取共享值（盒子国内探测 / 玩家反馈中位数），所以输出对所有抓取方**确定一致**，
// 不会因谁在访问而变。这是"排行榜"该有的性质。
//
// 排序复刻 js/servers.js：权重 = 延迟 45% + 版本 30% + 评价 25%（三项都归一到 0..1，
// 读不到版本罚到最底，延迟按同批百分位，评价净分过 ±4 杯软饱和）。只收录
// enabled 且通过服务端指纹校验（在 verified.valid 里）的条目。

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'accept',
  'vary': 'Accept-Encoding',
};

const LIST_KEY = 'site/servers.json';
const VERIFIED_KEY = 'site/verified.json';

// 与前端同名同值，改一处记得改另一处（tests/ranking.test.mjs 会盯住这几条不变式）。
const ROOM_CAPACITY = 1000;
const W_LATENCY = 0.45;
const W_VERSION = 0.30;
const W_CUP = 0.25;

function json(data, status, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...(extra || {}) },
  });
}

const VERSION_RE = /^v?(\d{1,4})\.(\d{1,4})(?:\.(\d{1,4}))?(?:\.(\d{1,4}))?/;

/** 版本号排序键：`0.1.3` → 数值；读不到给 -1（前端 versionRank 的镜像）。 */
export function versionRank(app) {
  const m = String(app || '').match(VERSION_RE);
  if (!m) return -1;
  return Number(m[1]) * 1e12 + Number(m[2]) * 1e8 + Number(m[3] || 0) * 1e4 + Number(m[4] || 0);
}

/**
 * 纯函数：两份 R2 文档 → 排好序的服务器数组。不碰网络、不碰 env，方便单测。
 * 抽出来是为了让"接口名次 == 页面名次"这件事可验证，而不是靠肉眼比对。
 */
export function buildRanking(listDoc, verifiedDoc) {
  const servers = listDoc && Array.isArray(listDoc.servers) ? listDoc.servers : [];
  const v = verifiedDoc && typeof verifiedDoc === 'object' ? verifiedDoc : {};
  // 对齐前端 applyVerified 的降级：valid 不是数组（verified.json 缺席/损坏）时**不过滤**，
  // 全部启用条目照常出榜 —— 否则抓取方会在一次短暂的后端缺档时拿到空榜。
  const hasValid = Array.isArray(v.valid);
  const validSet = {};
  if (hasValid) v.valid.forEach((id) => { validSet[String(id)] = true; });
  const occ = v.occupancy && typeof v.occupancy === 'object' ? v.occupancy : {};
  const lat = v.latency && typeof v.latency === 'object' ? v.latency : {};
  const vouch = v.vouches && typeof v.vouches === 'object' ? v.vouches : {};
  const opens = v.opens && typeof v.opens === 'object' ? v.opens : {};

  const rows = [];
  for (const s of servers) {
    if (!s || s.enabled === false) continue;
    const id = String(s.id || '');
    if (!id) continue;
    if (hasValid && !validSet[id]) continue;          // 未通过服务端校验的条目不进榜（与页面隐藏一致）
    let url;
    try { url = new URL(String(s.url)); } catch { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const o = occ[id] || {};
    const l = lat[id];
    const vc = vouch[id] || {};
    const op = opens[id] || {};
    const good = Number(vc.good) || 0;
    const bad = Number(vc.bad) || 0;
    const msNum = l && Number.isFinite(Number(l.ms)) ? Number(l.ms) : null;
    rows.push({
      id,
      name: String(s.name || url.hostname).slice(0, 48),
      url: url.href,
      scheme: url.protocol.replace(':', ''),
      note: typeof s.note === 'string' ? s.note.slice(0, 80) : null,
      app: typeof o.app === 'string' ? o.app.slice(0, 24) : null,
      build: typeof o.build === 'string' ? o.build.slice(0, 40) : null,
      variant: o.variant === 'workers' ? 'workers' : o.variant === 'node' ? 'node' : null,
      rooms: Number.isFinite(Number(o.rooms)) ? Number(o.rooms) : null,
      humans: Number.isFinite(Number(o.humans)) ? Number(o.humans) : null,
      latency_ms: msNum == null ? null : Math.round(msNum),
      latency_src: (l && l.src) || null,
      latency_samples: l && Number(l.n) > 0 ? Number(l.n) : (msNum == null ? 0 : 1),
      vouch_good: good,
      vouch_bad: bad,
      opens_total: Number(op.total) || 0,
      // 内部排序键，返回前剥掉
      _rank: versionRank(o.app),
      _ms: msNum,
      _net: good - bad,
    });
  }

  // 延迟归一化 = 同批已测到的百分位（最快 1、最慢 0，并列同档）。前端 latencyScale 的镜像。
  const vals = rows.map((r) => r._ms).filter((x) => x != null).map((x) => Math.round(x))
    .sort((a, b) => a - b);
  const uniq = vals.filter((x, i) => i === 0 || x !== vals[i - 1]);
  const latScale = {};
  uniq.forEach((ms, i) => { latScale[ms] = uniq.length > 1 ? 1 - i / (uniq.length - 1) : 1; });

  // 版本归一化 = 这批里出现过的版本号排成 0..1（最高 1）。前端 versionScale 的镜像。
  const vseen = {};
  rows.forEach((r) => { if (r._rank > 0) vseen[r._rank] = 1; });
  const vranks = Object.keys(vseen).map(Number).sort((a, b) => a - b);
  const verScale = {};
  vranks.forEach((r, i) => { verScale[r] = vranks.length > 1 ? i / (vranks.length - 1) : 1; });

  const latencyScore = (r) => {
    // 无共享值：接口里没有"本机测到离线"这种证据，一律按中位 0.5（不罚），与前端非离线分支一致。
    if (r._ms == null) return 0.5;
    const s = latScale[Math.round(r._ms)];
    return s == null ? 0.5 : s;
  };
  const versionScore = (r) => (r._rank > 0 ? (verScale[r._rank] != null ? verScale[r._rank] : 0) : -0.2);
  const cupScore = (r) => r._net / (Math.abs(r._net) + 4);

  rows.forEach((r) => {
    const comp = {
      latency: latencyScore(r),
      version: versionScore(r),
      cup: cupScore(r),
    };
    // 排序用全精度（_score），与前端 weightOf 逐位一致；只在输出字段上取整。
    // 若排序前先四舍五入，两个仅在小数第 5 位之后有别的行会被当成并列、保持清单原序，
    // 名次就可能和页面差一位（随机交叉验证抓到过这个）。
    r._score = W_LATENCY * comp.latency + W_VERSION * comp.version + W_CUP * comp.cup;
    r.score = Number(r._score.toFixed(4));
    r.components = {
      latency: Number(comp.latency.toFixed(4)),
      version: Number(comp.version.toFixed(4)),
      cup: Number(comp.cup.toFixed(4)),
    };
    r.load = r.rooms != null ? Number(Math.min(1, r.rooms / ROOM_CAPACITY).toFixed(3)) : null;
  });

  // 稳定排序：分数降序，并列保持清单原顺序（Array.sort 在 ES2019+ 保证稳定）。
  rows.sort((a, b) => b._score - a._score);
  rows.forEach((r, i) => { r.rank = i + 1; });

  return rows.map(({ _rank, _ms, _net, _score, ...rest }) => rest);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.R2BUCKET) return json({ ok: false, error: 'R2 binding missing' }, 500);

  let listDoc = null;
  let verDoc = null;
  try {
    const r = await env.R2BUCKET.get(LIST_KEY);
    if (r) listDoc = JSON.parse(await r.text());
  } catch { /* 下面统一报不可用 */ }
  try {
    const r = await env.R2BUCKET.get(VERIFIED_KEY);
    if (r) verDoc = JSON.parse(await r.text());
  } catch { /* verified 缺席不致命：只是没有延迟/人数/票数，排序退化成版本+清单序 */ }

  if (!listDoc || !Array.isArray(listDoc.servers)) {
    return json({ ok: false, error: 'list unavailable' }, 503);
  }

  const servers = buildRanking(listDoc, verDoc);
  return json({
    ok: true,
    updated: (verDoc && verDoc.updated) || null,
    listUpdated: (listDoc && listDoc.updated) || null,
    count: servers.length,
    method: {
      weights: { latency: W_LATENCY, version: W_VERSION, cup: W_CUP },
      note: '名次 = 延迟45%+版本30%+评价25%（共享探测值，非某访客本机实测）；只含通过服务端校验且启用的服务器。',
      latencyFields: 'latency_ms 单位毫秒；latency_src ∈ players-cn/players/cn-probe/browser；null 表示暂无共享值（按中位算，不代表离线）。',
    },
    servers,
  }, 200, { 'cache-control': 'public, max-age=60, stale-while-revalidate=300' });
}
