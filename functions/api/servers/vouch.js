// Pages Function: POST /api/servers/vouch
// 匿名「进不去」举报。2026-10-06 先加了正反两向，同日又**取消了正向票**（站长定的），
// 现在只剩负向：玩家点「我核验通过」不再能把一台被判死的服务器捞回清单。
//
// 为什么取消正向：那一票能翻掉的是「读不到版本号即判死」这条判据 —— 出发点是对的（有些服
// 跑的构建就是不回报 app/version，玩家进得去），但一个没有事实核验的点击去推翻判据，
// 迟早变成"谁点得勤谁上线"。恢复展示交回维护者与盒子那路看得见状态码的探测。
//
// 为什么保留负向：边缘 403/超时按现政策一律放行展示，真只有某几张网进得去的死地址会一直挂在
// 清单上，需要有人从里面往外说一句。门槛比正向高：**2 个不同来源**才隐藏一行，
// 理由不是偏心 —— 10-05 一条本地噪声回执（adblock、切网、页面没加载完）就把当天最大那台服
// （81 房/83 人）整条藏掉过。
//
// 边界（与正向票同一套）：
//   - 只接受签名清单里已存在的 id，地址/名字/探针不接受访客输入 ⇒ 清单的签名与条数不受影响；
//   - enabled===false 硬拒 403（停用是维护者终审）；当前已经不在清单前台显示的拒 409（这一票
//     改变不了什么），但**自己今天已有票的人改投/撤回永远允许**；
//   - 同一来源同一天同一台只能有一张票，重复投拒 429；
//   - 按 sha256(ip|id|当天) 记名，**不存明文 IP**；写 R2 site/vouches.json，不占 KV 写额度。
//
// 维护者口：verdict:'purge' 清掉某一条的全部票（要 x-admin-key），{"all":true} 清整本；
// GET 带同一口令读计数台账（只给每台的票数与最后时间，不含来源哈希）。

const LIST_KEY = 'site/servers.json';
const VERIFIED_KEY = 'site/verified.json';
const VOUCH_KEY = 'site/vouches.json';
const MAX_IDS = 200;
const MAX_TAGS_PER_ID = 64;    // 每条最多记名 64 个来源，超出丢最旧的

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

/** 统一成 {at, bad:{tag:{at,day}}}。正向票（旧文件的 ok/ips 桶）在这里被丢掉。 */
function norm(rec) {
  const out = { at: (rec && rec.at) || null, bad: {} };
  const bad = (rec && rec.bad && typeof rec.bad === 'object') ? rec.bad : {};
  for (const t of Object.keys(bad)) {
    const v = bad[t];
    if (v && typeof v === 'object') out.bad[t] = { at: v.at || out.at, day: v.day || String(v.at || '').slice(0, 10) };
  }
  out.count = Object.keys(out.bad).length;
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
    const tags = Object.keys(rec.bad);
    if (tags.length > MAX_TAGS_PER_ID) {
      tags.sort((a, b) => String(rec.bad[b].at || '').localeCompare(String(rec.bad[a].at || '')));
      tags.slice(MAX_TAGS_PER_ID).forEach((t) => delete rec.bad[t]);
      rec.count = Object.keys(rec.bad).length;
    }
    if (!rec.count) continue;
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

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.R2BUCKET) return json({ ok: false, error: 'R2 binding missing' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const id = typeof body.id === 'string' ? body.id.slice(0, 48) : '';
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id)) return json({ ok: false, error: 'bad id' }, 400);
  // 老客户端只发 {id}：当年那是正向票，而正向已取消，所以一律按撤回处理，绝不当成"能进"
  const raw = body.verdict === undefined ? 'clear' : body.verdict;
  if (raw === 'ok') {
    return json({ ok: false, error: '玩家「核验通过」已取消：恢复展示由维护者与健康端点探测决定' }, 410);
  }
  if (raw !== 'bad' && raw !== 'clear' && raw !== 'purge') {
    return json({ ok: false, error: "verdict 只能是 'bad' / 'clear' / 'purge'" }, 400);
  }

  const isAdmin = !!env.PUBLISH_KEY && (request.headers.get('x-admin-key') || '') === env.PUBLISH_KEY;

  // 清票：投票刷屏时比「停用整条」轻一档的手段。放在清单查询之前 —— 清单里已经没这个 id 的
  // 孤儿票正是要清的对象。匿名一律 403。
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
    const servers = Array.isArray(doc.servers) ? doc.servers : [];
    entry = servers.find((s) => s && s.id === id);
  } catch { return json({ ok: false, error: 'list corrupt' }, 500); }
  if (!entry) return json({ ok: false, error: 'unknown id' }, 404);
  if (entry.enabled === false) {
    return json({ ok: false, error: '这条已由站长停用，无需玩家审核' }, 403);
  }

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const tag = await ipTag(request.headers.get('cf-connecting-ip') || 'unknown', id, day);
  const doc = await readVouches(env);
  const rec = norm(doc.vouches[id] || {});

  if (raw === 'clear') {
    const had = !!rec.bad[tag];
    delete rec.bad[tag];
    rec.count = Object.keys(rec.bad).length;   // 删完要重算，否则响应里报的是删除前的票数
    if (!had) return json({ ok: true, id, verdict: 'clear', cleared: false, counts: { bad: rec.count } });
    rec.at = now.toISOString();
    if (rec.count) doc.vouches[id] = rec; else delete doc.vouches[id];
    doc.updated = now.toISOString();
    await writeVouches(env, trim(doc));
    return json({ ok: true, id, name: entry.name, verdict: 'clear', cleared: true, counts: { bad: rec.count } });
  }

  // 这一票要能改变什么：已经不在前台显示的，再报"进不去"没有作用（页面也不会给它摆按钮）。
  // 例外是自己今天已经投过 —— 分区快照可能滞后 120 s，不能拿它挡住改投/撤回。
  const mineToday = rec.bad[tag] && String(rec.bad[tag].day || '') === day;
  if (!mineToday && !isAdmin) {
    const prevRes = await env.R2BUCKET.get(VERIFIED_KEY);
    if (prevRes) {
      try {
        const v = JSON.parse(await prevRes.text());
        if (Array.isArray(v.valid) && !v.valid.includes(id)) {
          return json({ ok: false, error: '这台当前没在清单里显示，报告「进不去」没有作用' }, 409);
        }
      } catch { /* 分区读不到就照常收票 */ }
    }
  }
  if (mineToday) {
    return json({ ok: false, error: '你今天已经审过这条了', verdict: 'bad', counts: { bad: rec.count } }, 429);
  }

  rec.bad[tag] = { at: now.toISOString(), day };
  rec.at = now.toISOString();
  rec.count = Object.keys(rec.bad).length;
  doc.vouches[id] = rec;
  doc.updated = now.toISOString();
  const saved = trim(doc);
  await writeVouches(env, saved);
  const mine = saved.vouches[id];
  if (!mine) return json({ ok: false, error: '写入被裁剪，请重试' }, 500);
  return json({ ok: true, id, name: entry.name, verdict: 'bad', counts: { bad: mine.count },
                need: Math.max(0, 2 - mine.count) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  // 只有出示管理口令才给读数；没口令照旧 405，不对外宣布这里有维护者口
  const isAdmin = !!env.PUBLISH_KEY
    && (request.headers.get('x-admin-key') || '') === env.PUBLISH_KEY;
  if (!isAdmin || !env.R2BUCKET) return json({ ok: false, error: 'POST only' }, 405);
  const doc = await readVouches(env);
  const ids = {};
  for (const id of Object.keys(doc.vouches)) {
    ids[id] = { bad: doc.vouches[id].count, at: doc.vouches[id].at || null };
  }
  return json({ ok: true, updated: doc.updated || null, ids });
}
