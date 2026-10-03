// Pages Function: POST /api/servers/review
// Maintainer-only moderation of the visitor submission queue.
//   action: "approve" → run a fresh health check, then append to the live list and publish
//           "reject"  → drop the entry
// Body: { id, action }
// Auth: x-admin-key must match the PUBLISH_KEY secret.

import { verifyServerHealth, validateEntries } from '../_verify.js';

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
    try { live = JSON.parse(await liveRes.text()); } catch { /* start fresh */ }
  }
  const servers = Array.isArray(live.servers) ? live.servers.slice() : [];
  if (servers.some((s) => s.url === record.url)) {
    return json({ ok: true, action, id, note: '已在清单中，未重复添加' });
  }
  const entry = { id: record.id, name: record.name, url: record.url, probe: record.probe || '/healthz', enabled: true };
  if (record.note) entry.note = record.note;
  delete entry.verify; // verification state is not part of the published list
  servers.push(entry);

  const body = JSON.stringify({ updated: new Date().toISOString(), servers }, null, 2) + '\n';
  await env.R2BUCKET.put('site/servers.json', body, {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' },
  });
  return json({ ok: true, action, id, count: servers.length });
}
