// Pages Function: GET /api/latest
// Same-origin proxy for "the newest stable release that carries an APK", returned as the
// GitHub release object plus `_cachedAt` / `_stale`.
//
// Why: the page used to call api.github.com from the visitor's browser. GitHub's anonymous
// limit is per-IP, so a shared or mainland-China uplink hits 403 constantly and the page
// kept showing the bundled offline snapshot — an older version — as if it were current.
// Cloudflare fetches upstream once every few minutes from its own egress and serves the
// rest from the edge cache, so visitors never need to reach GitHub at all.
//
// No request input reaches the upstream URL: repo and endpoint are fixed constants.

const LIST_URL = 'https://api.github.com/repos/jingjiangze/Stronghold-Protocol/releases?per_page=100';
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
    return release ? { release: release, ghDownloads: ghDownloads } : null;
  } catch (err) {
    return null;
  }
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
    const payload = Object.assign({}, fetched.release, {
      _cachedAt: Date.now(),
      _stale: false,
      _ghDownloads: fetched.ghDownloads,
    });
    waitUntil(cache.put(key, respond(payload, STALE_KEEP_MS / 1000)));
    return respond(payload, FRESH_MS / 1000);
  }

  if (cached && cached.tag_name) return respond(Object.assign({}, cached, { _stale: true }), 30);
  return respond({ error: 'upstream unavailable' }, 0, 502);
}
