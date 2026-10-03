// Pages Function: POST /api/servers/submit
// 访客提交入口。**只入队，不发布** —— 服务端先做一次「是不是卫戍协议服务器」的健康校验，
// 通过才写进 SERVER_REVIEW KV 队列；发布由维护者在 /api/servers/review 点「通过」完成，
// 那次写入会带上 unsigned 标记，由本机签名脚本补上 Ed25519 签名（见 tools/sign-servers.mjs）。
//
// 队列存储：KV namespace SERVER_REVIEW（wrangler.toml 里绑定）
//   pending/<id>   → 提交记录
//   pending_index  → 待审 id 数组（读-改-写）

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

/** 排序/门禁用的可选字段，允许访客提交，非法值直接忽略。 */
function pickExtras(raw) {
  const out = {};
  if (Number.isInteger(raw.tier) && raw.tier >= 0 && raw.tier <= 100) out.tier = raw.tier;
  if (Number.isInteger(raw.weight) && raw.weight >= 0 && raw.weight <= 1000) out.weight = raw.weight;
  if (Number.isInteger(raw.protocol) && raw.protocol >= 0) out.protocol = raw.protocol;
  if (typeof raw.app === 'string' && raw.app.trim()) out.app = raw.app.trim().slice(0, 32);
  return out;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.SERVER_REVIEW || !env.R2BUCKET) return json({ ok: false, error: '提交队列未配置' }, 500);

  let doc;
  try { doc = await request.json(); } catch { return json({ ok: false, error: '请求不是有效 JSON' }, 400); }

  const rawEntry = Array.isArray(doc && doc.servers) ? doc.servers[0] : null;
  if (!rawEntry) return json({ ok: false, error: 'servers[] 里需要恰好一条待提交记录' }, 400);
  const checked = validateEntries([{ ...rawEntry, enabled: true }]);
  if (checked.error) return json({ ok: false, error: checked.error }, 400);
  const entry = { ...checked.servers[0], ...pickExtras(rawEntry) };

  // 服务端身份校验：不过 /healthz 指纹的一律拒收，省得污染队列。
  const verdict = await verifyServerHealth(entry.url, entry.probe);
  if (!verdict.ok) return json({ ok: false, error: `校验失败：${verdict.error}` }, 400);

  const index = await readIndex(env);
  if (index.length >= MAX_PENDING) return json({ ok: false, error: '待审核队列已满，请稍后再试' }, 429);

  const liveRes = await env.R2BUCKET.get('site/servers.json');
  if (liveRes) {
    try {
      const live = JSON.parse(await liveRes.text());
      if ((live.servers || []).some((s) => s.url === entry.url)) {
        return json({ ok: false, error: '该服务器已在公共清单中' }, 409);
      }
    } catch { /* 线上清单读不动时继续入队，approve 时还会再查一遍 */ }
  }
  const queued = await Promise.all(index.map((id) => env.SERVER_REVIEW.get(`pending/${id}`)));
  for (const record of queued) {
    if (record && JSON.parse(record).url === entry.url) {
      return json({ ok: false, error: '该服务器已在待审核队列中' }, 409);
    }
  }

  // 队列 id 要的是唯一性（它同时是审核键），不是保密；仍用 CSPRNG 而不是 Math.random。
  const random = new Uint8Array(4);
  crypto.getRandomValues(random);
  const queueId = Date.now().toString(36) + Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('');
  const record = {
    // 先放队列键再展开：访客自带的 entry.id 不允许覆盖审核键。
    ...entry,
    id: queueId,
    submittedAt: new Date().toISOString(),
    submittedBy: clientIp(request),
    verify: { ok: true, variant: verdict.variant || null, rooms: verdict.rooms ?? null, humans: verdict.humans ?? null, at: new Date().toISOString() },
  };
  await env.SERVER_REVIEW.put(`pending/${queueId}`, JSON.stringify(record));
  index.push(queueId);
  await env.SERVER_REVIEW.put('pending_index', JSON.stringify(index));

  return json({ ok: true, queued: true, id: queueId, queuePosition: index.length,
                hint: '已进入待审核队列，维护者点「通过」后仍需本机签名发布' });
}

export async function onRequestGet(context) {
  // 维护者视角看队列（密钥只能走 header，不进 URL）
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
