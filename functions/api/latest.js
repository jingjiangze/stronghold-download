// Pages Function: GET /api/latest
// Same-origin proxy for "the newest stable release that carries an APK", returned as the
// GitHub release object plus `_cachedAt` / `_stale`.
//
// Why: the page used to call api.github.com from the visitor's browser. GitHub's anonymous
// limit is per-IP, so a shared or mainland-China uplink hits 403 constantly and the page
// kept showing the bundled offline snapshot — an older version — as if it were current.
// Cloudflare fetches upstream once every few minutes from its own egress, serves the rest
// from the edge cache, and keeps a durable copy in KV, so visitors never need to reach
// GitHub at all. The bundled `data/releases.json` is gone (10-06): the GitHub Pages copy of
// this site has no Functions, so that mirror could *only* ever show the packed snapshot, and
// it showed shell-v2.9.2 for two days after the real version moved on. A page that cannot
// answer says "暂无法获取版本信息" instead of naming an old build.
//
// No request input reaches the upstream URL: repo and endpoint are fixed constants.

import { SNAPSHOT_ID } from './_asset.js';
import { blobStore } from '../_store.js';

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
    // 这里只做**筛选和截断**，提炼/清洗留给前端一处实现 —— 浏览器直连 GitHub 那条回退路径
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
 * 玩家看得懂的更新日志：历史上由 mirror-apk 在每次发布时生成（compare + 关联 PR 的中文标题）
 * 落在 R2。R2 上传已取消，所以这份对象只会停在最后一次发布的版本上；tag 对不上就当没有 ——
 * 页面会退回 release 正文提炼，不会崩也不会显示错位日志。
 */
async function readChangelog(env, tag) {
  if (!env || !env.DB || !tag) return null;
  try {
    const res = await blobStore(env).get(CHANGELOG_KEY);
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

  const hit = await cache.match(key).catch(function () { return undefined; });
  const cached = hit ? await hit.json().catch(function () { return null; }) : null;
  if (cached && cached.tag_name && Date.now() - (cached._cachedAt || 0) < FRESH_MS) {
    return respond(cached, FRESH_MS / 1000);
  }

  const fetched = await fetchLatest(env);
  if (fetched) {
    // 首方 R2 镜像与自动补抓已随 R2 下线一并取消：这里不再探测 CDN、也不再 dispatch
    // mirror-apk。下载由 /api/download 直接落到公共加速器（或 GitHub 资产）。
    const changelog = await readChangelog(env, fetched.release.tag_name);
    const payload = Object.assign({}, fetched.release, {
      _cachedAt: Date.now(),
      _stale: false,
      _ghDownloads: fetched.ghDownloads,
      _history: fetched.history || [],
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
