// Shared asset-target helpers for the download functions. One place decides what counts as
// "the first-party CDN copy of this release", so /api/latest and /api/download/<tag>/<file>
// can never disagree about it.

export const R2_HOST = 'weishucdn.jiangjiangze.icu';
export const SNAPSHOT_ID = 'latest-release';

/** Public accelerators in front of a GitHub URL, in preference order. Only used when the
 *  first-party CDN cannot serve the exact build. */
export const ACCELERATORS = [
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  'https://ghproxy.net/',
];

export function r2Asset(tag) {
  // Object keys keep the leading "v" of the shell tag: apk/stronghold-v2.8.0.apk.
  return 'https://' + R2_HOST + '/apk/stronghold-' + tag.replace(/^shell-/, '') + '.apk';
}

export function githubAsset(tag, file) {
  return 'https://github.com/jingjiangze/Stronghold-Protocol/releases/download/' + tag + '/' + file;
}

function busted(url) {
  // The edge caches a 404 at that key for hours (requests land before CI finishes the
  // upload), so a probe must carry a unique cache-buster or it can lie.
  return url + '?cb=' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/**
 * Does the first-party CDN hold *this exact build*?
 *
 * The key name alone is not trustworthy: apk/stronghold-v2.8.0.apk turned out to be a
 * 2.7.7-generation binary (521,193,612 B) while the shell-v2.8.0 release asset is
 * 543,630,883 B. Serving that silently hands out an old client labelled as the newest one,
 * so the object must answer AND match the release asset size when the size is known.
 */
export async function cdnHasBuild(tag, expectedSize) {
  const url = r2Asset(tag);
  if (!expectedSize) return { ok: false, url: url, reason: 'size-unknown', expected: 0, size: 0 };
  try {
    const res = await fetch(busted(url), {
      method: 'HEAD',
      cf: { cacheTtl: 0, cacheEverything: false },
      signal: AbortSignal.timeout(4000),
    });
    const size = Number(res.headers.get('content-length') || 0);
    if (!res.ok) return { ok: false, url: url, reason: 'missing', expected: expectedSize, size: 0 };
    if (size && size !== expectedSize) {
      return { ok: false, url: url, reason: 'size-mismatch', expected: expectedSize, size: size };
    }
    return { ok: true, url: url, reason: 'ok', expected: expectedSize, size: size };
  } catch (err) {
    return { ok: false, url: url, reason: 'probe-failed', expected: expectedSize, size: 0 };
  }
}

/** First accelerator that actually streams bytes. A dead proxy must never become a
 *  redirect target, so each candidate gets a 1 KiB Range probe first. */
export async function accelerated(ghUrl) {
  for (let i = 0; i < ACCELERATORS.length; i += 1) {
    const target = ACCELERATORS[i] + ghUrl;
    try {
      const res = await fetch(target, {
        method: 'GET',
        headers: { range: 'bytes=0-1023' },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok || res.status === 206) {
        try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (err) { /* ignore */ }
        return { ok: true, url: target, via: ACCELERATORS[i] };
      }
    } catch (err) { /* next candidate */ }
  }
  return { ok: false, url: null, via: null };
}

export function apkAssetOf(release) {
  const assets = (release && release.assets) || [];
  const apks = assets.filter(function (a) { return /\.apk$/i.test(a.name); });
  return apks.filter(function (a) { return a.name === 'app-release.apk'; })[0] || apks[0] || null;
}
