// Pages Function: POST /api/servers/submit
// 访客提交入口。**只入队，不发布** —— 服务端先做一次「是不是卫戍协议服务器」的健康校验，
// 通过才写进 SERVER_REVIEW KV 队列；发布由维护者在 /api/servers/review 点「通过」完成，
// 那次写入会带上 unsigned 标记，由本机签名脚本补上 Ed25519 签名（见 tools/sign-servers.mjs）。
//
// 队列存储：KV namespace SERVER_REVIEW（wrangler.toml 里绑定）
//   pending/<id>   → 提交记录
//   pending_index  → 待审 id 数组（读-改-写）

import { canonicalUrl, validateEntries, verifyServerHealth } from '../_verify.js';

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
function pickExtras(raw, isAdmin) {
  const out = {};
  if (Number.isInteger(raw.tier) && raw.tier >= 0 && raw.tier <= 100) out.tier = raw.tier;
  if (Number.isInteger(raw.weight) && raw.weight >= 0 && raw.weight <= 1000) out.weight = raw.weight;
  if (Number.isInteger(raw.protocol) && raw.protocol >= 0) out.protocol = raw.protocol;
  if (typeof raw.app === 'string' && raw.app.trim()) out.app = raw.app.trim().slice(0, 32);
  // direct_cn 只认出示管理口令的提交者：它是「绕过边缘指纹」的通行证，
  // 若匿名访客也能带，就等于任何人都能往签名清单里塞一台没被核实过的服务器。
  if (isAdmin && raw.direct_cn === true) { out.direct_cn = true; out.attested_by = 'maintainer'; }
  return out;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.SERVER_REVIEW || !env.R2BUCKET) return json({ ok: false, error: '提交队列未配置' }, 500);

  let doc;
  try { doc = await request.json(); } catch { return json({ ok: false, error: '请求不是有效 JSON' }, 400); }

  const rawEntry = Array.isArray(doc && doc.servers) ? doc.servers[0] : null;
  if (!rawEntry) return json({ ok: false, error: 'servers[] 里需要恰好一条待提交记录' }, 400);
  // 出示管理口令的提交者（本机工具、以及带 PUBLISH_KEY 的 scout 投递链）走的是维护者通道
  const isAdmin = !!env.PUBLISH_KEY && (request.headers.get('x-admin-key') || '') === env.PUBLISH_KEY;
  const checked = validateEntries([{ ...rawEntry, enabled: true }]);
  if (checked.error) return json({ ok: false, error: checked.error }, 400);
  // validateEntries 会原样保留 direct_cn（清单 PUT 路径要靠它），所以这里必须按身份剥掉：
  // 不剥的话匿名提交直接绕过 x-admin-key 闸门。
  if (!isAdmin) delete checked.servers[0].direct_cn;
  const entry = { ...checked.servers[0], ...pickExtras(rawEntry, isAdmin) };

  // 服务端身份校验：不过 /healthz 指纹的一律拒收，省得污染队列。
  // 提交路径给 12s：国内主机从边缘 PoP 过去常常 5s 内握不上手，那不等于"不是卫戍服务器"。
  const verdict = await verifyServerHealth(entry.url, entry.probe, 12000);
  // direct_cn 是维护者留证的「国内直连/其它出口可达、CF 边缘不通」条目，边缘探测失败只记录不拦提交。
  if (!verdict.ok && entry.direct_cn !== true) {
    return json({ ok: false, error: `校验失败：${verdict.error}` }, 400);
  }

  const index = await readIndex(env);
  if (index.length >= MAX_PENDING) return json({ ok: false, error: '待审核队列已满，请稍后再试' }, 429);

  const liveRes = await env.R2BUCKET.get('site/servers.json');
  const mine = canonicalUrl(entry.url);
  if (liveRes) {
    try {
      const live = JSON.parse(await liveRes.text());
      // 与 scout 侧一致的判据：同 host 且有一方是根路径（深链 ?room= 归一后就是根）算同一台；
      // 两边子路径不同则视为另一台实例，允许另报一条。
      const sameServer = (a, b) => {
        const cut = (u) => { try { const x = new URL(u); const p = x.pathname.replace(/\/+$/, ''); return { host: x.host, path: p || '/' }; } catch { return null; } };
        const x = cut(a); const y = cut(b);
        if (!x || !y || x.host !== y.host) return false;
        return x.path === y.path || x.path === '/' || y.path === '/';
      };
      const dup = (live.servers || []).some((x) => sameServer(x.url, entry.url));
      if (dup) return json({ ok: false, error: '该服务器已在公共清单中（同一 host 的根地址视为同一台；不同子路径可另报一条）' }, 409);
    } catch { /* 线上清单读不动时继续入队，approve 时还会再查一遍 */ }
  }
  const queued = await Promise.all(index.map((id) => env.SERVER_REVIEW.get(`pending/${id}`)));
  for (const record of queued) {
    if (record && sameServer(JSON.parse(record).url, entry.url)) {
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
    // 边缘探测结果原样入档：direct_cn 条目这里可能是 ok:false，审核时得看得见"是维护者担保的"
    verify: {
      ok: !!verdict.ok,
      variant: verdict.variant || null,
      rooms: verdict.rooms ?? null,
      humans: verdict.humans ?? null,
      error: verdict.ok ? undefined : verdict.error,
      at: new Date().toISOString(),
    },
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
