// Pages Function: POST /api/servers/review
// 维护者审核队列。
//   action: "approve" → 重做健康校验 + 入口校验 → 追加进线上清单 → 当场签名（配了 SP_SIGN_KEY 时）
//           "reject"  → 丢弃该条
// Body: { id, action }   Auth: header x-admin-key == PUBLISH_KEY secret
// approve 的返回里带 canonicalSha256，便于确认「签的就是这份」。
// 匿名提交的正常路径已经不走这里了：/api/servers/submit 校验有效就当场上线，队列只留给
// 需要维护者处置的三种情况（担保提交 / 本 IP 额度用完 / 清单并发更新）。

import { canonicalUrl, checkEntryUrl, payloadSha256, verifyServerHealth } from '../_verify.js';
import { publishServersDoc, signServersDoc } from '../_publish.js';

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
  const verdict = await verifyServerHealth(record.url, record.probe, 12000);
  // direct_cn 条目允许在边缘复核失败时发布：真实玩家从国内连接，verify.js 的 direct_cn
  // 分支会让它留在 valid 里，不会被隔离。
  if (!verdict.ok && record.direct_cn !== true) {
    return json({ ok: false, error: `复核失败：${verdict.error}（已从队列移除）` }, 400);
  }
  // 第二道闸（与 submit 同口径）：清单那条入口地址本身也得打得开，
  // 否则一上线就是"绿灯行 + 玩家点开 502"（game.rainya.me 那种半挂）。
  if (verdict.ok) {
    const gate = await checkEntryUrl(record.url);
    if (!gate.ok) return json({ ok: false, error: `复核失败：${gate.error}（已从队列移除）` }, 400);
  }

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
  // direct_cn 必须一起带进清单：verify.js 靠这个字段放过「国内直连 200、CF 边缘 403」的服，
  // 漏带的话这种服务器收录后会被整条隐藏（183.66.27.19:20522 就踩过）。
  for (const k of ['note', 'region', 'tier', 'weight', 'protocol', 'app', 'direct_cn']) if (record[k] != null) entry[k] = record[k];
  servers.push(entry);

  // 保留信封字段（v / keyId / note 等），换上新清单与时间戳。配了 SP_SIGN_KEY 就当场签好；
  // 没配（或密钥自校验没过）才标 unsigned 让本机 tools/sign-servers.mjs 补签 —— 签名覆盖的
  // 是旧载荷，加了一条就必须重签，否则客户端验签会静默拒绝整份清单。
  const next = { ...live };
  delete next.sig;
  delete next.unsigned;
  next.servers = servers;
  const signedDoc = await signServersDoc(next, env);
  const toWrite = signedDoc || Object.assign(next, { updated: new Date().toISOString(), unsigned: true });
  const out = await publishServersDoc(env, toWrite, {
    baseUpdated: live.updated, via: 'review-approve', entryId: record.id, entryUrl: record.url,
    ip: (request.headers.get('cf-connecting-ip') || '').slice(0, 60),
    ua: request.headers.get('user-agent'), country: (request.cf && request.cf.country) || null,
  });
  if (out.conflict) {
    return json({ ok: false, error: `清单在这期间又被改过（现网 ${out.liveUpdated}），没有覆盖；请重新审核这条` }, 409);
  }
  return json({
    ok: true, action, id, count: out.count, signed: !!out.signed, needsSignature: !out.signed,
    canonicalSha256: await payloadSha256(toWrite),
    hint: out.signed ? '已上线并完成签名' : '清单已更新但签名作废；本机执行 node tools/sign-servers.mjs --sign --publish 补签',
  });
}
