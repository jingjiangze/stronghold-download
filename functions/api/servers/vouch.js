// Pages Function: POST /api/servers/vouch
// 匿名评价：**大杯 = 好评，小杯 = 差评**（2026-10-06 站定的形态）。两个都只调清单排序权重，
// 永远不决定某台服务器显不显示。
//
// 这一天在这里来回过两次，结论都写进注释里，别再走一遍：
//   ① 先做成正向「我核验通过」一票即恢复展示 —— 同日取消：一个没有事实核验的点击去推翻判据，
//      迟早变成"谁点得勤谁上线"。
//   ② 再做成正向票 + 负向「进不去」两票即隐藏 —— 同日改成负向也只降权：单条「我连不上」多半是
//      本地噪声（adblock、切网、页面没加载完、https 页面不让发 http 请求），10-05 就有一条这种
//      回执把当天最大的一台服（81 房/83 人）整条藏掉过。往后挪是可逆的，藏掉是不可逆的。
// 所以显示/隐藏仍然只有三样东西说话：边缘指纹、盒子那路看得见状态码的探测、站长停用（终审）。
//
// 边界：
//   - 只接受签名清单里已存在的 id，地址/名字/探针不接受访客输入 ⇒ 清单的签名与条数不受任何影响；
//   - enabled === false（站长停用）硬拒 403；
//   - 同一来源同一天同一台只能有一张票：大杯小杯互斥，改投另一头会自动撤掉原来那张
//     （允许翻案，不允许堆票）；重复投同一向拒 429；verdict:'clear' 随时撤回自己那张。
//   - 按 sha256(ip|id|当天) 记名，**不存明文 IP**；写 R2 site/vouches.json，不占 KV 写额度
//     （免费额度 1000 写/天已被别的心跳吃掉一半）。
//
// 票数由 /api/servers/verify 并进 site/verified.json 的 vouches，页面拿 good-bad 当净分排序。
//
// 维护者口（要 x-admin-key: $PUBLISH_KEY）：verdict:'purge' 清某一条的全部票（清单里已不存在的
// 孤儿票也清得掉，所以这一步走在清单查询之前），"all":true 清整本；GET 读计数台账
// （只给每台的好/差票数与最后时间，不含来源哈希）。匿名 purge 一律 403，无口令 GET 照旧 405。

const LIST_KEY = 'site/servers.json';
const VOUCH_KEY = 'site/vouches.json';
const MAX_IDS = 200;
const MAX_TAGS_PER_SIDE = 64;   // 每边最多记名 64 个来源，超出丢最旧的
const SIDES = ['good', 'bad'];

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function ipTag(ip, id, day) {
  const bytes = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(ip + '|' + id + '|' + day));
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/** 统一成 {at, good:{tag:{at,day}}, bad:{...}, goodCount, badCount}；顺手裁掉越界的记名。 */
function norm(rec) {
  const out = { at: (rec && rec.at) || null, good: {}, bad: {} };
  for (const side of SIDES) {
    const map = (rec && rec[side] && typeof rec[side] === 'object') ? rec[side] : {};
    for (const t of Object.keys(map)) {
      const v = map[t] || {};
      out[side][t] = { at: v.at || out.at, day: v.day || String(v.at || '').slice(0, 10) };
    }
    out[side + 'Count'] = Object.keys(out[side]).length;
  }
  return out;
}

function trim(oldDoc) {
  const out = { updated: (oldDoc && oldDoc.updated) || null, vouches: {} };
  const src = (oldDoc && typeof oldDoc.vouches === 'object' && oldDoc.vouches) || {};
  const ids = Object.keys(src);
  if (ids.length > MAX_IDS) {
    ids.sort((a, b) => String((src[b] || {}).at || '').localeCompare(String((src[a] || {}).at || '')));
    ids.slice(MAX_IDS).forEach((k) => delete src[k]);
  }
  for (const id of Object.keys(src)) {
    const rec = norm(src[id]);
    for (const side of SIDES) {
      const map = rec[side];
      const tags = Object.keys(map);
      if (tags.length > MAX_TAGS_PER_SIDE) {
        tags.sort((a, b) => String(map[b].at || '').localeCompare(String(map[a].at || '')));
        tags.slice(MAX_TAGS_PER_SIDE).forEach((t) => delete map[t]);
        rec[side + 'Count'] = Object.keys(map).length;
      }
    }
    if (!rec.goodCount && !rec.badCount) continue;
    out.vouches[id] = rec;
  }
  return out;
}

async function readVouches(env) {
  let doc = { updated: null, vouches: {} };
  const res = await env.R2BUCKET.get(VOUCH_KEY);
  if (res) { try { doc = trim(JSON.parse(await res.text())); } catch { /* 覆盖重来 */ } }
  return doc;
}

async function writeVouches(env, doc) {
  await env.R2BUCKET.put(VOUCH_KEY, JSON.stringify(doc, null, 1) + '\n', {
    httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
  });
}

const counts = (rec) => ({ good: (rec && rec.goodCount) || 0, bad: (rec && rec.badCount) || 0 });

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.R2BUCKET) return json({ ok: false, error: 'R2 binding missing' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const id = typeof body.id === 'string' ? body.id.slice(0, 48) : '';
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id)) return json({ ok: false, error: 'bad id' }, 400);
  // good = 大杯（好评），bad = 小杯（差评）。兼容早先的 'ok' 写法（它当年也叫"能进"）。
  const raw = body.verdict === 'ok' ? 'good' : body.verdict;
  if (raw !== 'good' && raw !== 'bad' && raw !== 'clear' && raw !== 'purge') {
    return json({ ok: false, error: "verdict 只能是 'good' / 'bad' / 'clear' / 'purge'" }, 400);
  }

  const isAdmin = !!env.PUBLISH_KEY && (request.headers.get('x-admin-key') || '') === env.PUBLISH_KEY;

  if (raw === 'purge') {
    if (!isAdmin) return json({ ok: false, error: 'purge 需要 x-admin-key' }, 403);
    const doc = await readVouches(env);
    const had = Object.keys(doc.vouches).length;
    if (body.all === true) doc.vouches = {};
    else delete doc.vouches[id];
    doc.updated = new Date().toISOString();
    await writeVouches(env, doc);
    return json({ ok: true, purged: had - Object.keys(doc.vouches).length,
                  scope: body.all === true ? '*' : id, ids_left: Object.keys(doc.vouches) });
  }

  const listRes = await env.R2BUCKET.get(LIST_KEY);
  if (!listRes) return json({ ok: false, error: 'list missing' }, 500);
  let entry;
  try {
    const doc = JSON.parse(await listRes.text());
    entry = (Array.isArray(doc.servers) ? doc.servers : []).find((s) => s && s.id === id);
  } catch { return json({ ok: false, error: 'list corrupt' }, 500); }
  if (!entry) return json({ ok: false, error: 'unknown id' }, 404);
  if (entry.enabled === false) {
    return json({ ok: false, error: '这条已由站长停用，评价无意义' }, 403);
  }

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const tag = await ipTag(request.headers.get('cf-connecting-ip') || 'unknown', id, day);
  const doc = await readVouches(env);
  const rec = norm(doc.vouches[id] || {});
  rec.at = rec.at || null;

  if (raw === 'clear') {
    let cleared = 0;
    for (const side of SIDES) {
      if (rec[side][tag]) { delete rec[side][tag]; cleared += 1; }
    }
    for (const side of SIDES) rec[side + 'Count'] = Object.keys(rec[side]).length;
    if (!cleared) return json({ ok: true, id, verdict: 'clear', cleared: false, counts: counts(rec) });
    rec.at = now.toISOString();
    doc.vouches[id] = rec;
    doc.updated = now.toISOString();
    await writeVouches(env, trim(doc));
    return json({ ok: true, id, name: entry.name, verdict: 'clear', cleared: true, counts: counts(rec) });
  }

  const mine = rec[raw];
  const other = rec[raw === 'good' ? 'bad' : 'good'];
  if (mine[tag] && String(mine[tag].day || '') === day) {
    return json({ ok: false, error: '你今天已经评价过这条了', verdict: raw, counts: counts(rec) }, 429);
  }
  // 同一天同一来源只能有一张票：改投另一头先撤掉原来那张
  if (other[tag] && String(other[tag].day || '') === day) delete other[tag];
  mine[tag] = { at: now.toISOString(), day };
  rec.at = now.toISOString();
  for (const side of SIDES) rec[side + 'Count'] = Object.keys(rec[side]).length;
  doc.vouches[id] = rec;
  doc.updated = now.toISOString();
  const saved = trim(doc);
  await writeVouches(env, saved);
  const stored = saved.vouches[id];
  if (!stored) return json({ ok: false, error: '写入被裁剪，请重试' }, 500);
  const c = counts(stored);
  return json({ ok: true, id, name: entry.name, verdict: raw, counts: c, score: c.good - c.bad });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const isAdmin = !!env.PUBLISH_KEY
    && (request.headers.get('x-admin-key') || '') === env.PUBLISH_KEY;
  if (!isAdmin || !env.R2BUCKET) return json({ ok: false, error: 'POST only' }, 405);
  const doc = await readVouches(env);
  const ids = {};
  for (const id of Object.keys(doc.vouches)) {
    const c = counts(doc.vouches[id]);
    ids[id] = { good: c.good, bad: c.bad, score: c.good - c.bad, at: doc.vouches[id].at || null };
  }
  return json({ ok: true, updated: doc.updated || null, ids });
}
