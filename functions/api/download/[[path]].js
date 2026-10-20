// Pages Function: GET /api/download/<tag>/<file>
// Counted download redirect for the download page's primary button.
//
// Flow: validate the request against a strict allowlist (tag/file patterns, https
// GitHub / accelerator hosts only, no private/loopback targets) -> resolve the target
// (the fastest accelerator in front of the GitHub asset, else the GitHub asset itself)
// -> increment a KV counter -> 302.
// The counter key is `dlcount/<tag>/<file>`; totals are read by /api/download/total. Users
// who copy the raw asset link bypass the redirect, so this number is a lower bound.
//
// `x-download-source` on the response says which path was taken (accelerator / github),
// `x-download-mbps` the measured throughput of the winner, and `x-download-reason` carries
// how many candidates were raced — so the routing decision is auditable from the client
// without reading this file.
//
// 首方 R2 镜像已随 R2 下线取消（2026-10-14）：这里不再探测 CDN，也不再重定向到
// weishucdn。

import { ACCELERATORS, githubAsset, raceAccelerators } from '../_asset.js';

const ALLOWED_HOSTS = (function () {
  const hosts = { 'github.com': true };
  ACCELERATORS.forEach(function (prefix) {
    try { hosts[new URL(prefix).hostname] = true; } catch (err) { /* ignore */ }
  });
  return hosts;
})();

// release asset names are stable; the APK line carries a versionCode suffix (-vcNNNN),
// the content line does not. Both reach the same primary-button route, so accept both.
const TAG_RE = /^shell-v\d+\.\d+\.\d+(?:-vc\d+)?$/;
const FILE_RE = /^[A-Za-z0-9._-]+$/;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function resolveTarget(tag, file) {
  const gh = githubAsset(tag, file);
  if (file !== 'app-release.apk') return { url: gh, source: 'github', reason: 'not-apk', mbps: 0, probed: 0 };

  // Race the accelerators and keep the fastest that actually streams bytes. The cost is one
  // candidate's timeout, not the sum, so this stays well inside a click's patience budget.
  const acc = await raceAccelerators(gh);
  if (acc.ok) {
    return {
      url: acc.url,
      source: 'accelerator',
      reason: 'fastest-of-' + acc.probed,
      mbps: acc.mbps,
      probed: acc.probed,
    };
  }
  return { url: gh, source: 'github', reason: 'accelerator-unavailable', mbps: 0, probed: 0 };
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

  const chosen = await resolveTarget(tag, file);
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
      // Measured throughput of the winner (MB/s, one decimal). Zero when we fell back to
      // GitHub itself. Purely informational: it makes the routing decision auditable from
      // the outside and gives the page something to show next to the button.
      'x-download-mbps': String(Math.round((chosen.mbps || 0) * 10) / 10),
    },
  });
}
