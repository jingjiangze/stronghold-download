// Pages Function: POST /api/servers/submit
// 访客提交入口。**校验有效就当场上线，不再等维护者点「通过」**（2026-10-05 用户定的）：
// 服务端要连过两道 —— 健康端点指纹（是不是卫戍协议服务器）与清单那条入口地址本身
// （玩家真会点开的链接），两道都过才追加进签名清单并立刻发布；签名用 Pages secret
// SP_SIGN_KEY 在这边算，且签完立刻用 SP_PUB_KEY 自校验，配错密钥宁可不发。
// 以下三种情况仍退回队列，由维护者在 /api/servers/review 处置：
//   ① 带 x-admin-key 的投递链（scout）—— 边缘失败靠维护者担保；
//   ② 该 IP 一小时内自动上线已超 3 条（防刷屏）；
//   ③ 没配签名密钥或写清单时撞上并发（不硬盖别人的发布）。
//
// 队列存储：KV namespace SERVER_REVIEW（wrangler.toml 里绑定）
//   pending/<id>   → 提交记录
//   pending_index  → 待审 id 数组（读-改-写）

import { checkEntryUrl, validateEntries, verifyServerHealth } from '../_verify.js';
import { canSign, publishServersDoc, recentPublishes, signServersDoc } from '../_publish.js';

const MAX_PENDING = 100;
// 匿名提交现在直接进签名清单，所以给每个 IP 一个刷屏上限：一小时内最多自动上线 3 条，
// 超出就退回队列（维护者仍在，只是不再是必经步骤）。
const AUTO_PER_IP = 3;
const AUTO_WINDOW_MS = 60 * 60 * 1000;

/** 与 scout 侧一致的判据：同 host 且有一方是根路径（深链 ?room= 归一后就是根）算同一台；
 *  两边子路径不同则视为另一台实例，允许另报一条。 */
function sameServer(a, b) {
  const cut = (u) => {
    try { const x = new URL(u); return { host: x.host, path: x.pathname.replace(/\/+$/, '') || '/' }; }
    catch { return null; }
  };
  const x = cut(a); const y = cut(b);
  if (!x || !y || x.host !== y.host) return false;
  return x.path === y.path || x.path === '/' || y.path === '/';
}

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

  // 服务端身份校验：不过健康端点指纹的一律拒收，省得污染队列。
  // 提交路径给 12s：国内主机从边缘 PoP 过去常常 5s 内握不上手，那不等于"不是卫戍服务器"。
  const verdict = await verifyServerHealth(entry.url, entry.probe, 12000);
  // 出示管理口令的提交者（本机工具、带 PUBLISH_KEY 的 scout 投递链）本身就是验活通道之一：
  // 它们只在别的出口跑过指纹之后才投，边缘 403/超时不算否决 —— 直接补上 direct_cn，
  // 让后续 verify 也按"越过边缘探测"处理。匿名访客仍然必须过边缘校验。
  if (!verdict.ok && !isAdmin) {
    return json({ ok: false, error: `校验失败：${verdict.error}` }, 400);
  }
  if (!verdict.ok) { entry.direct_cn = true; entry.attested_by = 'maintainer'; }

  // 第二道闸：清单里那条入口地址（玩家真正会点的）自己也得打得开。
  // game.rainya.me 就是靠这个漏进来的：/api/status 一直 200 而 /play 是 502。
  const gate = verdict.ok ? await checkEntryUrl(entry.url) : { ok: true };
  if (verdict.ok && gate.ok === false && !isAdmin) {
    return json({ ok: false, error: `校验失败：${gate.error}` }, 400);
  }

  // 条目 id 要稳（客户端拿它当 occupancy 键），又要防撞：访客没给就生成一个，
  // 不能让 validateEntries 的 `srv-0` 兜底值进清单 —— 那会和下一条撞键。
  if (!String(rawEntry.id || '').trim()) {
    const rnd = new Uint8Array(4);
    crypto.getRandomValues(rnd);
    entry.id = Date.now().toString(36) + Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const index = await readIndex(env);
  if (index.length >= MAX_PENDING) return json({ ok: false, error: '待审核队列已满，请稍后再试' }, 429);

  const liveRes = await env.R2BUCKET.get('site/servers.json');
  let liveDoc = null;
  if (liveRes) { try { liveDoc = JSON.parse(await liveRes.text()); } catch { /* 现网坏了就只入队 */ } }
  const servers = liveDoc && Array.isArray(liveDoc.servers) ? liveDoc.servers : [];
  if (servers.some((x) => sameServer(x.url, entry.url))) {
    return json({ ok: false, error: '该服务器已在公共清单中（同一 host 的根地址视为同一台；不同子路径可另报一条）' }, 409);
  }
  const queued = await Promise.all(index.map((id) => env.SERVER_REVIEW.get(`pending/${id}`)));
  for (const record of queued) {
    if (record && sameServer(JSON.parse(record).url, entry.url)) {
      return json({ ok: false, error: '该服务器已在待审核队列中' }, 409);
    }
  }

  const ip = clientIp(request);
  // 匿名 + 两道都过 + 配了签名密钥 + 本 IP 额度没用完 → 当场上线（签好名再写，客户端不会看见未签名清单）
  if (!isAdmin && verdict.ok && gate.ok === true && canSign(env)
      && (await recentPublishes(env, ip, AUTO_WINDOW_MS)) < AUTO_PER_IP) {
    const signed = await signServersDoc({ ...liveDoc, servers: servers.concat([entry]) }, env);
    if (signed) {
      const out = await publishServersDoc(env, signed, {
        baseUpdated: liveDoc && liveDoc.updated, via: 'auto-submit',
        entryId: entry.id, entryUrl: entry.url, ip,
        ua: request.headers.get('user-agent'), country: (request.cf && request.cf.country) || null,
      });
      if (out.ok) {
        return json({ ok: true, published: true, id: entry.id, count: out.count,
                      hint: '校验通过，已当场上线；后台校验每 30 分钟复查一次，入口或后端坏了会自动隐藏' });
      }
      // out.conflict：期间有人改过清单。不硬盖，退回队列让维护者看见最新状态。
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
                hint: '已进入待审核队列（担保提交、本 IP 额度已满、或清单正在并发更新），维护者点「通过」即上线' });
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
