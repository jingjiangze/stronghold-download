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

  const index = await readIndex(env);
  if (index.length >= MAX_PENDING) return json({ ok: false, error: '待审核队列已满，请稍后再试' }, 429);

  // Same URL already queued or already live?
  const live = await env.R2BUCKET.get('site/servers.json');
  if (live) {
    try {
      const liveDoc = JSON.parse(await live.text());
      if ((liveDoc.servers || []).some((s) => s.url === entry.url)) {
        return json({ ok: false, error: '该服务器已在公共清单中' }, 409);
      }
    } catch { /* unreadable live list: proceed to queue */ }
  }
  const queued = await Promise.all(index.map((id) => env.SERVER_REVIEW.get(`pending/${id}`)));
  for (const record of queued) {
    if (record && JSON.parse(record).url === entry.url) {
      return json({ ok: false, error: '该服务器已在待审核队列中' }, 409);
    }
  }

  // Queue id: uniqueness matters (ids gate moderation), not secrecy — but per security
  // review, derive it from the platform CSPRNG instead of Math.random().
  const random = new Uint8Array(4);
  crypto.getRandomValues(random);
  const queueId = Date.now().toString(36) + Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('');
  const record = {
    // Queue key first, then the entry: a visitor-supplied entry.id must not overwrite the
    // moderation key (`id` would otherwise be clobbered by the spread below).
    ...entry,
    id: queueId,
    submittedAt: new Date().toISOString(),
    submittedBy: clientIp(request),
    verify: { ok: true, rooms: verdict.rooms || null, humans: verdict.humans || null, at: new Date().toISOString() },
  };
  await env.SERVER_REVIEW.put(`pending/${queueId}`, JSON.stringify(record));
  index.push(queueId);
  await writeIndex(env, index);

  return json({ ok: true, id: queueId, queuePosition: index.length });
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
