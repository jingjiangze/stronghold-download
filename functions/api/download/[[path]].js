// Pages Function: GET /api/download/<tag>/<file>
// Counted download redirect for the download page's primary button.
//
// Flow: validate the request against a strict allowlist (tag/file patterns, https first-party
// CDN / GitHub / accelerator hosts only, no private/loopback targets) -> resolve the target
// (first-party R2 CDN only when it verifiably holds THIS build, otherwise a public
// accelerator in front of the GitHub asset) -> increment a KV counter -> 302.
// The counter key is `dlcount/<tag>/<file>`; totals are read by /api/download/total. Users
// who copy the raw CDN direct link bypass the redirect, so this number is a lower bound.
//
// `x-download-source` on the response says which path was taken (cdn / accelerator / github)
// so the routing decision is auditable from the client without reading this file.

import { ACCELERATORS, accelerated, apkAssetOf, cdnHasBuild, githubAsset, R2_HOST, SNAPSHOT_ID } from '../_asset.js';

const ALLOWED_HOSTS = (function () {
  const hosts = { 'github.com': true };
  hosts[R2_HOST] = true;
  ACCELERATORS.forEach(function (prefix) {
    try { hosts[new URL(prefix).hostname] = true; } catch (err) { /* ignore */ }
  });
  return hosts;
})();

// release asset names are stable; tags are shell-v<X.Y.Z>
const TAG_RE = /^shell-v\d+\.\d+\.\d+$/;
const FILE_RE = /^[A-Za-z0-9._-]+$/;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** The release asset size for `tag`, from the KV snapshot written by /api/latest. Zero means
 *  "we cannot verify what the CDN object contains" — which is treated as not usable. */
async function expectedSize(env, tag) {
  try {
    const raw = await env.SERVER_REVIEW.get(SNAPSHOT_ID);
    const snap = raw ? JSON.parse(raw) : null;
    if (!snap || snap.tag_name !== tag) return 0;
    const apk = apkAssetOf(snap);
    return (apk && apk.size) || 0;
  } catch (err) {
    return 0;
  }
}

async function resolveTarget(tag, file, env) {
  const gh = githubAsset(tag, file);
  if (file !== 'app-release.apk') return { url: gh, source: 'github', reason: 'not-apk' };

  const cdn = await cdnHasBuild(tag, await expectedSize(env, tag));
  if (cdn.ok) return { url: cdn.url, source: 'cdn', reason: cdn.reason };

  const acc = await accelerated(gh);
  if (acc.ok) return { url: acc.url, source: 'accelerator', reason: cdn.reason };
  return { url: gh, source: 'github', reason: cdn.reason };
}

export async function onRequestGet(context) {
  const { env } = context;
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

  const chosen = await resolveTarget(tag, file, env);
  let parsed;
  try { parsed = new URL(chosen.url); } catch { return json({ ok: false, error: 'bad target' }, 500); }
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

  return new Response(null, {
    status: 302,
    headers: {
      location: chosen.url,
      'cache-control': 'no-store',
      'x-download-source': chosen.source,
      'x-download-reason': chosen.reason || '',
    },
  });
}
