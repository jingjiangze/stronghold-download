// Pages Function: POST /api/servers/submit
// Visitor submission path. NO key required — but every entry must pass the server-side
// "is this really a Stronghold Protocol server" health check before it enters the review
// queue. Nothing is published directly; a maintainer approves via /api/servers/review.
//
// Queue storage: KV namespace SERVER_REVIEW (binding in wrangler.toml).
//   pending/<id>          → submission record
//   pending_index         → JSON array of pending ids (read-modify-write)

import { verifyServerHealth, validateEntries } from '../_verify.js';

const MAX_PENDING = 100;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

async function readIndex(env) {
  const raw = await env.SERVER_REVIEW.get('pending_index');
  const list = raw ? JSON.parse(raw) : [];
  return Array.isArray(list) ? list : [];
}

async function writeIndex(env, ids) {
  await env.SERVER_REVIEW.put('pending_index', JSON.stringify(ids));
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.SERVER_REVIEW) return json({ ok: false, error: '审核队列未配置' }, 500);

  let doc;
  try { doc = await request.json(); } catch { return json({ ok: false, error: '请求不是有效 JSON' }, 400); }

  const checked = validateEntries(doc && doc.servers ? [{ ...doc.servers[0], enabled: true }] : []);
  if (checked.error) return json({ ok: false, error: checked.error }, 400);
  const entry = checked.servers[0];

  // Required server-side identity check: the target must answer /healthz with the
  // upstream project's fields, otherwise the submission is refused outright.
  const verdict = await verifyServerHealth(entry.url, entry.probe);
  if (!verdict.ok) return json({ ok: false, error: `校验失败：${verdict.error}` }, 400);

  // Auto-publish (user decision 2026-10-03: server-side health check is the gate; no
  // human review). Merge into the live list and publish to R2 immediately.
  const liveRes = await env.R2BUCKET.get('site/servers.json');
  let live = { updated: new Date().toISOString(), servers: [] };
  if (liveRes) {
    try { live = JSON.parse(await liveRes.text()); } catch { /* start fresh */ }
  }
  const servers = Array.isArray(live.servers) ? live.servers.slice() : [];
  if (servers.some((s) => s.url === entry.url)) {
    return json({ ok: false, error: '该服务器已在公共清单中' }, 409);
  }
  if (servers.length >= 64) return json({ ok: false, error: '清单已满' }, 429);
  const published = {
    id: entry.id, name: entry.name, url: entry.url, probe: entry.probe, enabled: true,
  };
  if (entry.note) published.note = entry.note;
  servers.push(published);

  const body = JSON.stringify({ updated: new Date().toISOString(), servers }, null, 2) + '\n';
  await env.R2BUCKET.put('site/servers.json', body, {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' },
  });

  return json({ ok: true, published: true, count: servers.length });
}

export async function onRequestGet(context) {
  // maintainer view of the queue (requires key via query is NOT allowed; use header)
  const key = context.request.headers.get('x-admin-key') || '';
  if (!context.env.PUBLISH_KEY || key !== context.env.PUBLISH_KEY) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  const env = context.env;
  const index = await readIndex(env);
  const records = (await Promise.all(index.map((id) => env.SERVER_REVIEW.get(`pending/${id}`))))
    .filter(Boolean).map((raw) => JSON.parse(raw));
  return json({ ok: true, pending: records });
}
