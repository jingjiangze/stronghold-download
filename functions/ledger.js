// Pages Function: GET/POST /ledger —— 探针台账（候选池、已投递记录、Actions 分钟计数）读写。
//
// 原来托管在 Cloudflare Worker 的 R2 绑定上；那条链路 2026-10-06 起整账户 1101（见 /ingest 的头注释），
// 台账回写也跟着死 —— R2 里 scout/state.json 的 lastRun 冻在 2026-10-06T20:27:11Z 就是那次的痕迹。
// 站点本来就绑着同一个桶（stronghold-assets），所以这一步只是换个门进来，键名、体积上限、语义都不变。
//
// 边界：同一把 x-scout-key 口令；只接本站域名；写前必须能 JSON.parse，且上限 900 KB ——
// 半截的台账比没有台账更坏（下一轮会拿它当"这台已经投过"的证据）。

const STATE_KEY = 'scout/state.json';
const MAX_BYTES = 900000;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function allowed(context) {
  const origin = new URL(context.request.url).origin;
  if (origin !== 'https://dl.jiangjiangze.icu' && origin !== 'https://stronghold-download.pages.dev') return false;
  const a = String(context.request.headers.get('x-scout-key') || '');
  const b = String(context.env.SCOUT_TOKEN || '');
  if (!b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function onRequestGet(context) {
  if (!allowed(context)) return json({ ok: false, error: 'forbidden' }, 403);
  const obj = await context.env.R2BUCKET.get(STATE_KEY);
  if (!obj) return new Response('{}', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  // R2 对象上是 .text()/.json()/.body（流），没有 .body() —— 写成 body() 会让整条请求 1101。
  return new Response(await obj.text(), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function onRequestPost(context) {
  if (!allowed(context)) return json({ ok: false, error: 'forbidden' }, 403);
  const body = await context.request.text();
  if (body.length > MAX_BYTES) return json({ ok: false, error: 'state 太大' }, 413);
  try { JSON.parse(body); } catch { return json({ ok: false, error: 'state 不是合法 JSON' }, 400); }
  await context.env.R2BUCKET.put(STATE_KEY, body, { httpMetadata: { contentType: 'application/json' } });
  return json({ ok: true, bytes: body.length, at: new Date().toISOString() });
}
