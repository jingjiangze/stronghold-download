// Pages Function: POST /ingest —— 自动探针的投递口（原样替代 Cloudflare Worker 的 /ingest）。
//
// 为什么搬到这里：`*.yuehuibu5561.workers.dev` 上这个账户的**全部**经典 Worker 从 2026-10-06 20:27Z
// 起一律返回 `error code: 1101`（无 key 的 /ledger 也一样 —— 那条在第一句就 return，说明脚本在边缘
// 根本没起来；把当前代码上传到 CF 边缘预览同样 internal error）。同账户的 Pages Functions 全程正常，
// 而投递需要的三样东西本来就在 Pages secret 里（PUBLISH_KEY / SP_SIGN_KEY / SP_PUB_KEY），
// 所以把这一步搬进站点，不再依赖那条坏掉的链路。清单因此从 10-06 起只能靠人手改。
//
// 边界（和 Worker 版一致，没有放宽任何判据）：
//   - 口令 `x-scout-key` 与 Worker 用的 SCOUT_TOKEN 同一把，只是换了个持有者；
//     管理口令 PUBLISH_KEY **不出函数进程**，只在这条请求内部拼给自己的 /api/servers/* 端点。
//   - 只做「转调已有的两条公开端点」：submit（维护者通道）→ review approve（服务端自己再验一次活、
//     再判一次签名），判据、闸门、暂存区规则一行都没改。
//   - approve 完现网仍没签名时补签一次（Worker 原来也有这步），走 publishServersDoc 的乐观并发闸门。
//   - 只接本站自己的域名，防止别人把这里当成任意 URL 的转发器（SSRF）。

import { canSign, publishServersDoc, signServersDoc } from './api/_publish.js';

const LIST_KEY = 'site/servers.json';
const MAX_ITEMS = 10;
const PER_STEP_MS = 40000;   // 两步串起来要留够余量：Actions 侧那条请求 90 秒就放弃了

function json(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 口令比较：长度不同就早退，相同长度逐字节或起来比 —— 不引入新依赖，也不给计时侧信道留口子。 */
function keyOk(provided, expected) {
  const a = String(provided || '');
  const b = String(expected || '');
  if (!b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PER_STEP_MS),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = new URL(request.url).origin;
  if (origin !== 'https://dl.jiangjiangze.icu' && origin !== 'https://stronghold-download.pages.dev') {
    return json({ ok: false, error: '只接受本站域名调用' }, 403);
  }
  if (!keyOk(request.headers.get('x-scout-key'), env.SCOUT_TOKEN)) return json({ ok: false, error: 'forbidden' }, 403);
  if (!env.PUBLISH_KEY) return json({ ok: false, error: '站点缺 PUBLISH_KEY，无法以维护者通道投递' }, 500);

  const payload = await request.json().catch(() => ({}));
  const list = Array.isArray(payload.servers) ? payload.servers.slice(0, MAX_ITEMS) : [];
  if (!list.length) return json({ ok: false, error: 'servers[] 为空' }, 400);

  const admin = { 'x-admin-key': env.PUBLISH_KEY };
  const results = [];

  for (const entry of list) {
    const url = typeof entry.url === 'string' ? entry.url : '';
    try {
      const sub = await postJson(`${origin}/api/servers/submit`, admin, { servers: [entry] });
      if (!sub.body || sub.body.ok !== true) {
        // 「已在队列中」对探针来说是成功（上一轮投过了），Worker 版也是这么折成 already-listed 的。
        const dup = /已在/.test(String((sub.body && sub.body.error) || ''));
        results.push({ url, ok: dup, mode: dup ? 'already-listed' : undefined,
                       error: dup ? undefined : `submit(${sub.status}): ${JSON.stringify(sub.body).slice(0, 160)}` });
        continue;
      }

      const rev = await postJson(`${origin}/api/servers/review`, admin,
        { id: sub.body.id, action: 'approve' });
      if (!rev.body || rev.body.ok !== true) {
        results.push({ url, ok: false,
                       error: `approve(${rev.status}): ${JSON.stringify(rev.body).slice(0, 160)}` });
        continue;
      }

      let signed = rev.body.signed === true;
      let sha = rev.body.canonicalSha256 || null;
      // approve 那条路径自己有 SP_SIGN_KEY 就会签；没签成功时这里补一次（不改内容，只盖章）。
      if (!signed && canSign(env)) {
        const held = await env.R2BUCKET.get(LIST_KEY);
        const live = held ? JSON.parse(await held.text()) : null;
        if (live && Array.isArray(live.servers)) {
          const doc = await signServersDoc(live, env);
          if (doc) {
            const out = await publishServersDoc(env, doc, { baseUpdated: live.updated, via: 'ingest-resign',
                                                            entryId: sub.body.id, entryUrl: url });
            signed = !!out.signed;
            sha = out.sha || sha;
          }
        }
      }
      results.push({ url, ok: true, mode: 'published', signed, detail: { id: sub.body.id, sha256: sha,
                       count: rev.body.count, needsSignature: rev.body.needsSignature === true } });
    } catch (err) {
      results.push({ url, ok: false, error: String((err && err.message) || err).slice(0, 160) });
    }
  }

  const published = results.filter((r) => r.ok).length;
  return json({ ok: published > 0, results, published, at: new Date().toISOString() });
}

export function onRequestGet() {
  return json({ ok: true, endpoint: '/ingest', method: 'POST' });
}
