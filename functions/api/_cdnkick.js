// CDN 落后就自己去催 mirror-apk —— GitHub 的 cron 在这个账户上是饥饿的（实测 `*/10` 从
// 10-04 建流到 10-05 只命中 5 次），所以"CDN 没有构建"能挂两个小时。这里用现成的
// Pages secret GH_TICK_TOKEN 直接 dispatch 本仓库的 mirror-apk，两个入口共用同一套闸门：
//   · /api/latest 探到 _cdn.ok=false 时顺带 kick（访客驱动，发布后一两分钟内就补）
//   · /api/tick 的闹钟打进来时拉一次 /api/latest（盒子每小时 :27，没人访问也能补）
// 限流是必须的：这条链路会写 GitHub Actions 分钟数（免费 2000/月），一次 mirror 跑约 40 秒。
const OWN_REPO = 'jingjiangze/stronghold-download';
const WF_PATH = '/actions/workflows/mirror-apk.yml/dispatches';
const STATE_KEY = 'site/cdn-kick.json';
const GAP_MS = 10 * 60 * 1000;          // 同一个 tag 两次 kick 至少隔 10 分钟
const DAY_MAX = 6;                        // 同一个 tag 一天最多 6 次
const TAG_RE = /^[\w.+-]{1,60}$/;         // 绝不能把任意文本塞进 workflow 的 gh release download

const dispatchUrl = () => 'https://api.github.com/repos/' + OWN_REPO + WF_PATH;

async function readState(env) {
  try {
    const res = await env.R2BUCKET.get(STATE_KEY);
    const doc = res ? JSON.parse(await res.text()) : {};
    return doc && typeof doc === 'object' ? doc : {};
  } catch {
    return {};
  }
}

async function writeState(env, doc) {
  try {
    await env.R2BUCKET.put(STATE_KEY, JSON.stringify(doc, null, 1) + '\n', {
      httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
    });
  } catch { /* 记不下就不记，别挡抓取 */ }
}

/**
 * 真正发一次 dispatch。`force` 只给管理口令用（手工补抓，不等 cron）。
 * 返回一条可直接打印的判定，绝不抛异常 —— 调用方都在 waitUntil 里。
 */
export async function kickMirror(env, tag, opts) {
  const o = opts || {};
  if (!TAG_RE.test(String(tag || ''))) return { ok: false, skipped: 'tag 非法' };
  if (!env.GH_TICK_TOKEN) return { ok: false, skipped: '未配置 GH_TICK_TOKEN' };
  if (!env.R2BUCKET) return { ok: false, skipped: '没有 R2 绑定' };

  const state = await readState(env);
  const rec = state[tag] || { hits: [] };
  const now = Date.now();
  rec.hits = (Array.isArray(rec.hits) ? rec.hits : []).filter((t) => now - Number(t) < 24 * 3600e3);
  if (!o.force) {
    if (rec.hits.length && now - Number(rec.hits[rec.hits.length - 1]) < GAP_MS) {
      return { ok: false, skipped: '距上次 kick 不足 10 分钟', last: new Date(Number(rec.hits[rec.hits.length - 1])).toISOString() };
    }
    if (rec.hits.length >= DAY_MAX) return { ok: false, skipped: '该 tag 今天已 kick ' + rec.hits.length + ' 次' };
  }

  let http = 0;
  let note = '';
  try {
    const res = await fetch(dispatchUrl(), {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: {
        authorization: 'Bearer ' + env.GH_TICK_TOKEN,
        accept: 'application/vnd.github+json',
        'user-agent': 'stronghold-dl-cdn-kick',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { tag } }),
    });
    http = res.status;
    if (res.status !== 204) note = (await res.text().catch(() => '')).slice(0, 180);
  } catch (err) {
    note = String((err && err.name) || err).slice(0, 80);
  }

  const sent = http === 204;
  rec.hits = rec.hits.concat(sent ? [now] : []);
  rec.last = { at: new Date(now).toISOString(), http, note, forced: !!o.force };
  const pruned = {};
  for (const k of Object.keys(state)) if (k !== tag && Array.isArray(state[k].hits) && state[k].hits.length) pruned[k] = state[k];
  await writeState(env, Object.assign(pruned, { [tag]: rec }));

  return { ok: sent, tag, http, note: note || null, forced: !!o.force, kicksToday: rec.hits.length };
}

/** 访客路径上的判定：只在"CDN 确实缺/不符"时 kick，一切限流照走。 */
export async function kickIfCdnStale(env, tag, cdn) {
  if (!tag) return { ok: false, skipped: '没有可比的 tag' };
  if (cdn && cdn.ok) return { ok: false, skipped: 'CDN 已是最新构建' };
  const reason = (cdn && cdn.reason) || 'unknown';
  const out = await kickMirror(env, tag);
  return Object.assign({ cdnReason: reason }, out);
}

/** 给管理页/审计用的最近记录。 */
export async function kickLog(env) {
  const state = await readState(env);
  const rows = Object.entries(state).map(([tag, r]) => ({
    tag, kicksToday: (r.hits || []).length, last: r.last || null,
  }));
  return rows.sort((a, b) => String(b.last && b.last.at).localeCompare(String(a.last && a.last.at)));
}
