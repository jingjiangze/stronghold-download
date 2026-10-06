// Pages Function: POST /api/servers/vouch
// 匿名审核：玩家对**签名清单里已有的一条服务器**投「我核验通过」或「进不去」。2026-10-06 用户定的。
//
// 为什么两个方向都要有：
//   - 只有正向：判死链里最严的一条「读不到点分版本号即判死」，常常只是那台跑的构建不回报
//     app/version —— 玩家进得去、玩得好，我们却当着所有人的面把整行藏掉（rincynar / tx-106-55）。
//   - 只有负向不够：边缘 403/超时按现政策一律放行展示，可有些地址是真只有国内某几张网进得去，
//     玩家点进去是死页 —— 这需要有人从里面往外说一句话。
//
// 门槛刻意不对称（不是偏心，是 10-05 吃过的亏）：
//   正向 1 票即恢复展示；**负向要 2 个不同来源**才隐藏，且两边比多数。
//   理由：单条「我连不上」多半是本地噪声（adblock、切网、页面没加载完、http 条目在 https 页面
//   根本不让发），曾经一条这种回执就把当天最大的一台服（81 房/83 人）整条藏掉；
//   反过来「多显示一台暂时坏的」只是玩家点开发现打不开，「少显示一台好的」是玩家找不到服务器。
//
// 这一票只翻**显示**，翻不了**准入**：
//   - 只接受签名清单里已存在的 id，地址/名字/探针一律不接受访客输入，所以清单的签名与条数
//     不会因为票发生任何变化（新增仍须走 /api/servers/submit 的指纹 + 入口双测 + 签名）；
//   - enabled===false 服务端硬拒 403 —— 停用是维护者终审（任何方向的票都不许翻）；
//   - 正向票只收「当前被我们藏起来」的条目（409 挡掉已在显示的），负向票反过来（409 挡掉已隐藏的），
//     免得把无意义的写入堆进票数。
//
// 防刷：按 sha256(ip|id|当天) 记名，**同一来源同一天同一台只能有一张票**，改投另一头就把原来那张撤掉
// （翻票是允许的，堆票不行）。只存哈希，不存明文 IP。写 R2 单文件 site/vouches.json，不用 KV
// （免费额度 1000 写/天已被别的心跳吃掉一半）。

const LIST_KEY = 'site/servers.json';
const VERIFIED_KEY = 'site/verified.json';
const VOUCH_KEY = 'site/vouches.json';
const MAX_IDS = 200;          // 清单本身封顶 64，这里只是防文件被历史 id 撑大
const MAX_IPS_PER_SIDE = 64;  // 每边最多记名 64 个来源，超出丢最旧的

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

/** 旧文件形状是 {ips:{...}}（只有正向），迁移成 {ok:{...}}；负向是新增的 bad。 */
function side(rec, which) {
  if (which === 'ok' && (!rec.ok || typeof rec.ok !== 'object')) {
    rec.ok = (rec.ips && typeof rec.ips === 'object') ? rec.ips : {};
  }
  if (!rec[which] || typeof rec[which] !== 'object') rec[which] = {};
  return rec[which];
}

function tally(rec) {
  const ok = side(rec, 'ok');
  const bad = side(rec, 'bad');
  rec.okCount = Object.keys(ok).length;
  rec.badCount = Object.keys(bad).length;
  rec.count = rec.okCount;          // 兼容旧读法
  rec.ips = undefined;              // 删掉迁移前的别名，别让文件里同一份票存两遍
  return rec;
}

function trim(oldDoc) {
  const out = { updated: null, vouches: {} };
  const src = (oldDoc && typeof oldDoc.vouches === 'object' && oldDoc.vouches) || {};
  const ids = Object.keys(src);
  if (ids.length > MAX_IDS) {
    ids.sort((a, b) => String(src[b].at || '').localeCompare(String(src[a].at || '')));
    ids.slice(MAX_IDS).forEach((k) => delete src[k]);
  }
  for (const id of Object.keys(src)) {
    const rec = src[id];
    if (!rec || typeof rec !== 'object') { delete src[id]; continue; }
    for (const which of ['ok', 'bad']) {
      const map = side(rec, which);
      const tags = Object.keys(map);
      if (tags.length > MAX_IPS_PER_SIDE) {
        tags.sort((a, b) => String(map[b].at || '').localeCompare(String(map[a].at || '')));
        tags.slice(MAX_IPS_PER_SIDE).forEach((t) => delete map[t]);
      }
    }
    tally(rec);
    if (!rec.okCount && !rec.badCount) { delete src[id]; continue; }
    out.vouches[id] = rec;
  }
  return out;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.R2BUCKET) return json({ ok: false, error: 'R2 binding missing' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const id = typeof body.id === 'string' ? body.id.slice(0, 48) : '';
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id)) return json({ ok: false, error: 'bad id' }, 400);
  // 缺省按正向（老客户端只发 {id}）；clear 是「撤回我今天这张票」，第三个取值一律拒绝
  const verdict = body.verdict === undefined || body.verdict === 'ok' ? 'ok'
    : (body.verdict === 'bad' || body.verdict === 'clear' ? body.verdict : null);
  if (!verdict) return json({ ok: false, error: "verdict 只能是 'ok' / 'bad' / 'clear'" }, 400);

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
    return json({ ok: false, error: '这条已由站长停用，玩家审核不能恢复展示' }, 403);
  }

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const tag = await ipTag(request.headers.get('cf-connecting-ip') || 'unknown', id, day);

  let doc = { updated: null, vouches: {} };
  const vRes = await env.R2BUCKET.get(VOUCH_KEY);
  if (vRes) { try { doc = trim(JSON.parse(await vRes.text())); } catch { /* 覆盖重来 */ } }
  if (!doc.vouches[id] || typeof doc.vouches[id] !== 'object') {
    doc.vouches[id] = { at: null, ok: {}, bad: {} };
  }
  const rec = tally(doc.vouches[id]);
  const dayOf = (map) => (map[tag] && String(map[tag].day || '') === day);
  const hasMineToday = dayOf(side(rec, 'ok')) || dayOf(side(rec, 'bad'));

  // 只在"这一票能改变什么"时收：正向票救被我们藏起来的，负向票针对正在显示的。
  // 两个例外：撤回（clear）永远允许，点错的人必须能反悔；手里已经有票的人改投另一头也永远允许 ——
  // 否则「先点了能进、分区刷新后又想报告进不去」会被这条 409 挡掉，而分区本身可能滞后 120 s。
  let shown = null;
  const prevRes = await env.R2BUCKET.get(VERIFIED_KEY);
  if (prevRes) {
    try {
      const v = JSON.parse(await prevRes.text());
      if (Array.isArray(v.valid)) shown = v.valid.includes(id);
    } catch { /* 分区读不到就照常收票 */ }
  }
  if (verdict === 'clear') {
    let cleared = 0;
    for (const which of ['ok', 'bad']) {
      const map = side(rec, which);
      if (map[tag]) { delete map[tag]; cleared += 1; }
    }
    tally(rec);
    if (!cleared) {
      return json({ ok: true, id, verdict: 'clear', cleared: false,
                    counts: { ok: rec.okCount, bad: rec.badCount } });
    }
    rec.at = now.toISOString();
    doc = trim(doc);
    doc.updated = now.toISOString();
    await env.R2BUCKET.put(VOUCH_KEY, JSON.stringify(doc, null, 1) + '\n', {
      httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
    });
    const after = (doc.vouches[id] || {});
    return json({ ok: true, id, name: entry.name, verdict: 'clear', cleared: true,
                  counts: { ok: after.okCount || 0, bad: after.badCount || 0 } });
  }
  if (!hasMineToday && verdict === 'ok' && shown === true) {
    return json({ ok: false, error: '这台当前就在清单里正常显示，无需核验' }, 409);
  }
  if (!hasMineToday && verdict === 'bad' && shown === false) {
    return json({ ok: false, error: '这台当前没在清单里显示，报告「进不去」没有作用；能连上请点「我核验通过」' }, 409);
  }

  const mine = side(rec, verdict);
  const other = side(rec, verdict === 'ok' ? 'bad' : 'ok');
  const prior = mine[tag];
  if (prior && String(prior.day || '') === day) {
    return json({ ok: false, error: '你今天已经审过这条了', verdict,
                  counts: { ok: rec.okCount, bad: rec.badCount } }, 429);
  }
  // 同一来源同一天只能有一张票：改投另一头就撤掉原来那张（允许翻案，不允许堆票）
  if (other[tag] && String(other[tag].day || '') === day) delete other[tag];
  mine[tag] = { at: now.toISOString(), day, v: verdict };
  rec.at = now.toISOString();
  doc = trim(doc);
  const saved = doc.vouches[id];
  if (!saved) return json({ ok: false, error: '写入被裁剪，请重试' }, 500);
  doc.updated = now.toISOString();
  await env.R2BUCKET.put(VOUCH_KEY, JSON.stringify(doc, null, 1) + '\n', {
    httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
  });
  return json({ ok: true, id, name: entry.name, verdict,
                counts: { ok: saved.okCount, bad: saved.badCount } });
}

export async function onRequestGet() {
  return json({ ok: false, error: 'POST only' }, 405);
}
