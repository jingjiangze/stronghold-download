// Pages Function: POST /api/servers/review
// 维护者审核队列。
//   action: "approve" → 重新做一次健康校验 → 追加进线上清单 → **作废签名并标 unsigned**
//           "reject"  → 丢弃该条
// Body: { id, action }   Auth: header x-admin-key == PUBLISH_KEY secret
// approve 的返回里带 canonicalSha256，便于确认「本机签的就是这份」。

import { canonicalUrl, payloadSha256, verifyServerHealth } from '../_verify.js';

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function readIndex(env) {
  const raw = await env.SERVER_REVIEW.get('pending_index');
  const list = raw ? JSON.parse(raw) : [];
  return Array.isArray(list) ? list : [];
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const key = request.headers.get('x-admin-key') || '';
  if (!env.PUBLISH_KEY || !key || key !== env.PUBLISH_KEY) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (!env.SERVER_REVIEW || !env.R2BUCKET) return json({ ok: false, error: 'bindings missing' }, 500);

  let doc;
  try { doc = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const { id, action } = doc || {};
  if (!id || (action !== 'approve' && action !== 'reject')) {
    return json({ ok: false, error: '需要 { id, action: approve|reject }' }, 400);
  }

  const raw = await env.SERVER_REVIEW.get(`pending/${id}`);
  if (!raw) return json({ ok: false, error: '条目不存在（可能已被处理）' }, 404);
  const record = JSON.parse(raw);

  const index = await readIndex(env);
  const nextIndex = index.filter((x) => x !== id);
  await env.SERVER_REVIEW.delete(`pending/${id}`);
  await env.SERVER_REVIEW.put('pending_index', JSON.stringify(nextIndex));

  if (action === 'reject') {
    return json({ ok: true, action, id });
  }

  // approve: fresh verification (the queue may be stale), then publish.
  const verdict = await verifyServerHealth(record.url, record.probe);
  if (!verdict.ok) return json({ ok: false, error: `复核失败：${verdict.error}（已从队列移除）` }, 400);

  const liveRes = await env.R2BUCKET.get('site/servers.json');
  let live = { updated: new Date().toISOString(), servers: [] };
  if (liveRes) {
    try { live = JSON.parse(await liveRes.text()); } catch { /* 坏了就重建骨架 */ }
  }
  const servers = Array.isArray(live.servers) ? live.servers.slice() : [];
  const mine = canonicalUrl(record.url);
  if (servers.some((s) => canonicalUrl(s.url) === mine)) {
    return json({ ok: true, action, id, note: '已在清单中，未重复添加' });
  }
  const entry = { id: record.id, name: record.name, url: record.url, probe: record.probe || '/healthz', enabled: true };
  for (const k of ['note', 'region', 'tier', 'weight', 'protocol', 'app']) if (record[k] != null) entry[k] = record[k];
  servers.push(entry);

  // 保留信封字段（v / keyId / note 等），换上新清单与时间戳，并把签名作废：
  // 签名覆盖的是旧载荷，加了一条就必须重签，否则客户端验签会静默拒绝整份清单。
  const next = { ...live };
  delete next.sig;
  next.servers = servers;
  next.updated = new Date().toISOString();
  next.unsigned = true;

  const body = JSON.stringify(next, null, 2) + '\n';
  await env.R2BUCKET.put('site/servers.json', body, {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' },
  });
  return json({
    ok: true, action, id, count: servers.length, needsSignature: true,
    canonicalSha256: await payloadSha256(next),
    hint: '清单已更新但签名作废；本机执行 node tools/sign-servers.mjs --sign --publish 补签',
  });
}
