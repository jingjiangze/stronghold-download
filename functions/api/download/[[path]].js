// Pages Function: GET /api/download/<tag>/<file>
// Counted download redirect for the download page's primary button.
//
// Flow: validate the request against a strict allowlist (tag/file patterns, https R2 or
// GitHub hosts only, no private/loopback targets) -> increment a KV counter -> 302 to the
// real asset. The counter key is `dlcount/<tag>/<file>`; totals are read by
// /api/download/total. aria2 power users copy the raw R2 direct link instead, so this
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

function buildTarget(tag, file) {
  if (file === 'app-release.apk') {
    // Prefer the first-party R2 direct link; fall back to the GitHub asset.
    return 'https://weishucdn.jiangjiangze.icu/apk/stronghold-' + tag.replace(/^shell-v/, '') + '.apk';
  }
  return 'https://github.com/jingjiangze/Stronghold-Protocol/releases/download/' + tag + '/' + file;
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

  const target = buildTarget(tag, file);
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
