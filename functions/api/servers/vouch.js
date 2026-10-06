// Pages Function: POST /api/servers/vouch
// 匿名「我核验通过」：玩家点一下就代表这台过了核验（2026-10-06 用户定的口径）。
//
// 存在的理由：verify.js 最严的一条判据是「读不到点分版本号即判死」，而读不到版本号常常只是
// 那台跑的构建不回报 app/version —— 玩家进得去、玩得好，我们却当着所有人的面把整行藏掉
// （现网 rincynar / tx-106-55 / anciusland 三台全卡在这条上）。玩家的眼睛比我们的探针强。
//
// 这一票只翻**显示**，翻不了**准入**：
//   - 只接受签名清单里已存在的 id，地址/名字/探针一律不接受访客输入，所以匿名票新增不了服务器，
//     也改不了任何一条已经上线的地址（新增仍须走 /api/servers/submit 的指纹 + 入口双测 + 签名）；
//   - enabled===false 服务端硬拒 —— 停用是维护者终审（10-06 定的），玩家票不许把它捞回前台；
//   - 当前就在 valid 里的条目拒收（409）：那是无意义写入，页面本来也不会给它摆按钮。
//
// 防刷：按 sha256(ip|id|当天) 记名，一人一天一票；**只存哈希，不存明文 IP**。
// 存储写 R2 单文件 site/vouches.json，不用 KV —— 免费额度 1000 写/天已被别的心跳吃掉一半。

const LIST_KEY = 'site/servers.json';
const VERIFIED_KEY = 'site/verified.json';
const VOUCH_KEY = 'site/vouches.json';
const MAX_IDS = 200;          // 清单本身封顶 64，这里只是防文件被历史 id 撑大
const MAX_IPS_PER_ID = 64;    // 每条最多记名 64 个来源，超出丢最旧的

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

function trim(oldDoc) {
  const out = { updated: null, vouches: {} };
  const src = (oldDoc && typeof oldDoc.vouches === 'object' && oldDoc.vouches) || {};
  const ids = Object.keys(src);
  if (ids.length > MAX_IDS) {
    ids.sort((a, b) => String(src[b].at || '').localeCompare(String(src[a].at || '')));
    ids.slice(MAX_IDS).forEach((k) => delete src[k]);
  }
  for (const id of Object.keys(src)) {
    const v = src[id];
    if (!v || typeof v !== 'object') continue;
    const tags = Object.keys(v.ips || {});
    if (tags.length > MAX_IPS_PER_ID) {
      tags.sort((a, b) => String(v.ips[b].at || '').localeCompare(String(v.ips[a].at || '')));
      tags.slice(MAX_IPS_PER_ID).forEach((t) => delete v.ips[t]);
    }
    v.count = Object.keys(v.ips || {}).length;
    if (!v.count) { delete src[id]; continue; }
    out.vouches[id] = v;
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
    return json({ ok: false, error: '这条已由站长停用，玩家核验不能恢复展示' }, 403);
  }

  // 只在「我们判它未核」时收票：还亮着的条目不需要，也不该被票污染统计
  const prevRes = await env.R2BUCKET.get(VERIFIED_KEY);
  if (prevRes) {
    try {
      const v = JSON.parse(await prevRes.text());
      if (Array.isArray(v.valid) && v.valid.includes(id)) {
        return json({ ok: false, error: '这台当前就在清单里正常显示，无需核验' }, 409);
      }
    } catch { /* 分区读不到就当没有，照样收票 */ }
  }

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const tag = await ipTag(request.headers.get('cf-connecting-ip') || 'unknown', id, day);

  let doc = { updated: null, vouches: {} };
  const vRes = await env.R2BUCKET.get(VOUCH_KEY);
  if (vRes) { try { doc = trim(JSON.parse(await vRes.text())); } catch { /* 覆盖重来 */ } }
  if (!doc.vouches[id]) doc.vouches[id] = { at: null, count: 0, ips: {} };
  const rec = doc.vouches[id];
  if (!rec.ips || typeof rec.ips !== 'object') rec.ips = {};
  if (rec.ips[tag] && String(rec.ips[tag].day || '') === day) {
    return json({ ok: false, error: '你今天已经核验过这条了' }, 429);
  }
  rec.ips[tag] = { at: now.toISOString(), day, ok: true };
  rec.at = now.toISOString();
  doc = trim(doc);
  const mine = doc.vouches[id];
  if (!mine) return json({ ok: false, error: '写入被裁剪，请重试' }, 500);
  doc.updated = now.toISOString();
  await env.R2BUCKET.put(VOUCH_KEY, JSON.stringify(doc, null, 1) + '\n', {
    httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
  });
  return json({ ok: true, id, name: entry.name, confirmed_by: mine.count });
}

export async function onRequestGet() {
  return json({ ok: false, error: 'POST only' }, 405);
}
