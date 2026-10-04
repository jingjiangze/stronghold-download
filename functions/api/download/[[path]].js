// Pages Function: GET /api/download/<tag>/<file>
// Counted download redirect for the download page's primary button.
//
// Flow: validate the request against a strict allowlist (tag/file patterns, https R2 or
// GitHub hosts only, no private/loopback targets) -> resolve the target (first-party R2 CDN
// when that object exists, GitHub asset otherwise) -> increment a KV counter -> 302.
// The counter key is `dlcount/<tag>/<file>`; totals are read by
// /api/download/total. Users who copy the raw R2 direct link bypass the redirect, so this
// number is a lower bound of the true total.

const ALLOWED_HOSTS = {
  'weishucdn.jiangjiangze.icu': true,
  'github.com': true,
};
// release asset names are stable; tags are shell-v<X.Y.Z>
const TAG_RE = /^shell-v\d+\.\d+\.\d+$/;
const FILE_RE = /^[A-Za-z0-9._-]+$/;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function githubAsset(tag, file) {
  return 'https://github.com/jingjiangze/Stronghold-Protocol/releases/download/' + tag + '/' + file;
}

function r2Asset(tag) {
  // Object keys keep the leading "v" of the shell tag: apk/stronghold-v2.8.0.apk.
  return 'https://weishucdn.jiangjiangze.icu/apk/stronghold-' + tag.replace(/^shell-/, '') + '.apk';
}

/** A release published minutes ago is not on the CDN yet (the mirror upload lags), and the
 *  edge caches a 404 at that key for hours, so the probe carries a unique cache-buster.
 *  Missing object -> serve the GitHub asset: an older-but-working link is worse than a
 *  slower-but-correct one, and a 404 is worse than both. */
async function resolveTarget(tag, file) {
  if (file !== 'app-release.apk') return githubAsset(tag, file);
  const r2 = r2Asset(tag);
  try {
    const probe = await fetch(r2 + '?cb=' + Date.now().toString(36) + Math.random().toString(36).slice(2), {
      method: 'HEAD',
      cf: { cacheTtl: 0, cacheEverything: false },
      signal: AbortSignal.timeout(4000),
    });
    if (probe.ok) return r2;
  } catch (err) { /* unreachable CDN: GitHub asset is the honest fallback */ }
  return githubAsset(tag, file);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  // [[path]] params arrive as an array of segments, not a joined string.
  const rawPath = context.params && context.params.path;
  const parts = Array.isArray(rawPath) ? rawPath : String(rawPath || '').split('/').filter(Boolean);

  // /api/download/total -> read the counters
  if (parts.length === 1 && parts[0] === 'total') {
    const total = Number(await env.SERVER_REVIEW.get('dlcount/total') || 0);
    return json({ ok: true, total: total });
  }

  // /api/download/<tag>/<file>
  if (parts.length !== 2) return json({ ok: false, error: 'not found' }, 404);
  const tag = decodeURIComponent(parts[0]);
  const file = decodeURIComponent(parts[1]);
  if (!TAG_RE.test(tag) || !FILE_RE.test(file) || !file.endsWith('.apk')) {
    return json({ ok: false, error: 'invalid tag or file' }, 400);
  }

  const target = await resolveTarget(tag, file);
  let parsed;
  try { parsed = new URL(target); } catch { return json({ ok: false, error: 'bad target' }, 500); }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS[parsed.hostname]) {
    return json({ ok: false, error: 'target not allowed' }, 500);
  }

  // Count (best-effort: a counter failure must not block the download)
  try {
    const counterKey = 'dlcount/' + tag + '/' + file;
    const current = Number(await env.SERVER_REVIEW.get(counterKey) || 0);
    await env.SERVER_REVIEW.put(counterKey, String(current + 1));
    const total = Number(await env.SERVER_REVIEW.get('dlcount/total') || 0);
    await env.SERVER_REVIEW.put('dlcount/total', String(total + 1));
  } catch { /* counter is best-effort */ }

  return Response.redirect(parsed.href, 302);
}
