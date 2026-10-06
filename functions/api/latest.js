// Pages Function: GET /api/latest
// Same-origin proxy for "the newest stable release that carries an APK", returned as the
// GitHub release object plus `_cachedAt` / `_stale`.
//
// Why: the page used to call api.github.com from the visitor's browser. GitHub's anonymous
// limit is per-IP, so a shared or mainland-China uplink hits 403 constantly and the page
// kept showing the bundled offline snapshot — an older version — as if it were current.
// Cloudflare fetches upstream once every few minutes from its own egress, serves the rest
// from the edge cache, and keeps a durable copy in KV, so visitors never need to reach
// GitHub at all and a GitHub outage or rate-limit window cannot push the page back onto the
// bundled `data/releases.json` (which stays a cold-start floor, not the normal path).
//
// No request input reaches the upstream URL: repo and endpoint are fixed constants.

import { apkAssetOf, cdnHasBuild, SNAPSHOT_ID } from './_asset.js';
import { kickIfCdnStale, kickLog, kickMirror } from './_cdnkick.js';

const LIST_URL = 'https://api.github.com/repos/jingjiangze/Stronghold-Protocol/releases?per_page=100';
const SNAPSHOT_REFRESH_MS = 30 * 60 * 1000;
const FRESH_MS = 5 * 60 * 1000;
const STALE_KEEP_MS = 24 * 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 8000;

function respond(body, maxAgeSeconds, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=' + maxAgeSeconds,
    },
  });
}

/** Newest stable release with an APK — as a release asset or as a direct .apk link in the
 *  notes (builds sometimes ship the APK out-of-band) — plus the APK download totals across
 *  all releases, which the page would otherwise have to ask GitHub for itself. */
async function fetchLatest(env) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'stronghold-download-edge',
  };
  const token = env && (env.GH_TOKEN || env.GITHUB_TOKEN);
  if (token) headers.authorization = 'Bearer ' + token;
  try {
    const res = await fetch(LIST_URL, {
      headers,
      cf: { cacheTtl: 60, cacheEverything: true },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const releases = await res.json();
    if (!Array.isArray(releases)) return null;
    const release = releases.find(function (r) {
      if (r.draft || r.prerelease) return false;
      return (r.assets || []).some(function (a) { return /\.apk$/i.test(a.name); }) ||
        /https?:\/\/[^\s)\]"<>]+\.apk/i.test(r.body || '');
    }) || null;
    let ghDownloads = 0;
    releases.forEach(function (r) {
      (r.assets || []).forEach(function (a) {
        if (/\.apk$/i.test(a.name)) ghDownloads += a.download_count || 0;
      });
    });
    // 更新日志的数据源：最近的稳定 release（含纯热更的"内容批次"，那几条才是人话）。
    // 这里只做**筛选和截断**，提炼/清洗留给前端一处实现 —— 离线快照 data/releases.json
    // 走的是同一套代码，两边不会出现两种日志口径。
    const history = releases.filter(function (r) {
      return r && !r.draft && !r.prerelease && r.tag_name;
    }).slice(0, 5).map(function (r) {
      return {
        tag: r.tag_name,
        name: String(r.name || r.tag_name).slice(0, 120),
        published_at: r.published_at || r.created_at || '',
        body: String(r.body || '').slice(0, 700),
      };
    });
    return release ? { release: release, ghDownloads: ghDownloads, history: history } : null;
  } catch (err) {
    return null;
  }
}

const CHANGELOG_KEY = 'site/changelog.json';

/**
 * 玩家看得懂的更新日志：由 mirror-apk 在每次发布时生成（compare + 关联 PR 的中文标题），
 * 落在 R2。放在访客路径上算是要吃 GitHub 匿名限额（60 次/小时/IP，而且本机出口本来就 403），
 * 所以这里只读一个对象。tag 对不上就当没有 —— 版本错位的日志比没有日志更糟。
 */
async function readChangelog(env, tag) {
  if (!env || !env.R2BUCKET || !tag) return null;
  try {
    const res = await env.R2BUCKET.get(CHANGELOG_KEY);
    if (!res) return null;
    const doc = JSON.parse(await res.text());
    return doc && doc.tag === tag && Array.isArray(doc.items) ? doc : null;
  } catch (err) {
    return null;
  }
}

/** Durable copy of the last good answer. The edge cache is per-colo and gets evicted; KV
 *  is what lets the page stay on the newest version across a GitHub outage or a rate-limit
 *  window, instead of dropping back to the bundled file (which is only a cold-start floor). */
async function readSnapshot(env) {
  try {
    const raw = await env.SERVER_REVIEW.get(SNAPSHOT_ID);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.tag_name ? parsed : null;
  } catch (err) {
    return null;
  }
}

async function writeSnapshot(env, payload) {
  const prev = await readSnapshot(env);
  // KV writes are the scarce side of the free tier: refresh at most every
  // SNAPSHOT_REFRESH_MS unless the release itself changed.
  if (prev && prev.tag_name === payload.tag_name &&
      payload._cachedAt - (prev._cachedAt || 0) < SNAPSHOT_REFRESH_MS) return;
  try {
    await env.SERVER_REVIEW.put(SNAPSHOT_ID, JSON.stringify(payload));
  } catch (err) { /* KV is optional; the edge cache still covers this colo */ }
}

export async function onRequestGet(context) {
  const { env, waitUntil } = context;
  const cache = caches.default;
  const host = new URL(context.request.url).host;
  const key = new Request('https://' + host + '/api/latest');
  const q = new URL(context.request.url).searchParams;

  // 维护者的催抓口必须走在边缘缓存命中之前：否则 5 分钟内被缓存的那份会把 ?kick/?kicklog
  // 一起吞成普通 release 载荷，口令门看着像没生效。
  if (q.get('kick') || q.get('kicklog')) {
    if (!env.PUBLISH_KEY || (context.request.headers.get('x-admin-key') || '') !== env.PUBLISH_KEY) {
      return respond({ error: 'unauthorized' }, 0, 401);
    }
    if (q.get('kicklog')) return respond(await kickLog(env), 0, 200);
    const forTag = q.get('tag') || (await fetchLatest(env).then((r) => (r && r.release ? r.release.tag_name : '')));
    if (!forTag) return respond({ ok: false, skipped: '拿不到可比对的最新 tag' }, 0, 502);
    return respond(await kickMirror(env, forTag, { force: q.get('force') === '1' }), 0, 200);
  }

  const hit = await cache.match(key).catch(function () { return undefined; });
  const cached = hit ? await hit.json().catch(function () { return null; }) : null;
  if (cached && cached.tag_name && Date.now() - (cached._cachedAt || 0) < FRESH_MS) {
    return respond(cached, FRESH_MS / 1000);
  }

  const fetched = await fetchLatest(env);
  if (fetched) {
    // Tell the page whether the first-party CDN can serve this exact build, so it can be
    // honest about the download source instead of silently falling back to GitHub.
    const apk = apkAssetOf(fetched.release);
    const cdn = await cdnHasBuild(fetched.release.tag_name, apk && apk.size);
    const changelog = await readChangelog(env, fetched.release.tag_name);
    // CDN 缺这份构建 → 去催 mirror-apk。GitHub 的 cron 在这是饥饿的（实测 `*/10` 五个小时
    // 只命中一次，shell-v2.9.18 发布后挂了整整 2 小时），所以不能只等定时。
    waitUntil(kickIfCdnStale(env, fetched.release.tag_name, cdn));
    const payload = Object.assign({}, fetched.release, {
      _cachedAt: Date.now(),
      _stale: false,
      _ghDownloads: fetched.ghDownloads,
      _history: fetched.history || [],
      _cdn: cdn,
      _changelog: changelog,
    });
    waitUntil(cache.put(key, respond(payload, STALE_KEEP_MS / 1000)));
    waitUntil(writeSnapshot(env, payload));
    return respond(payload, FRESH_MS / 1000);
  }

  // Upstream unavailable: edge copy first, then the durable KV copy, both flagged stale.
  if (cached && cached.tag_name) return respond(Object.assign({}, cached, { _stale: true }), 30);
  const snapshot = await readSnapshot(env);
  if (snapshot) return respond(Object.assign({}, snapshot, { _stale: true }), 30);
  return respond({ error: 'upstream unavailable' }, 0, 502);
}
