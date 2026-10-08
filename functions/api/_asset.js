// Shared asset-target helpers for the download functions. One place decides what counts as
// "the first-party CDN copy of this release", so /api/latest and /api/download/<tag>/<file>
// can never disagree about it.

export const R2_HOST = 'weishucdn.jiangjiangze.icu';
export const SNAPSHOT_ID = 'latest-release';

/** How far the CDN object's byte size may drift from the release asset and still be served.
 *  Covers the publish pipeline's rebuild delta (single-digit bytes) while still refusing a
 *  genuinely different build (the 2.8.0 case was 22 MB off). */
export const SIZE_TOLERANCE = 65536;

/** Public accelerators in front of a GitHub URL, in preference order. Only used when the
 *  first-party CDN cannot serve the exact build. */
export const ACCELERATORS = [
  'https://gh-proxy.com/',
  'https://ghfast.top/',
];

export function r2Asset(tag) {
  // Object keys keep the leading "v" of the shell tag: apk/stronghold-v2.8.0.apk.
  return r2Candidates(tag)[0];
}

/**
 * 桶里同一份构建可能有两个键：
 *   apk/stronghold-v<X.Y.Z>.apk  —— 主仓库 apk.yml 按 versionName 上传，也是本仓库 mirror 写的键
 *   apk/<tag>.apk               —— 按 tag 直接命名（release 正文里广告的就是这条，如 shell-v2.9.18.apk）
 * 只认前一条会造成假"CDN 没有构建"：10-05 的 shell-v2.9.18 就是 `apk/shell-v2.9.18.apk` 已经
 * 200/逐字节正确，而站点探的那条 404 —— 直链明明在，页面却退回第三方加速器。
 */
export function r2Candidates(tag) {
  const bare = tag.replace(/^shell-/, '');
  return [
    'https://' + R2_HOST + '/apk/stronghold-' + bare + '.apk',
    'https://' + R2_HOST + '/apk/' + tag + '.apk',
  ];
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
 * Does the first-party CDN hold *this* build?
 *
 * The key name alone is not trustworthy: apk/stronghold-v2.8.0.apk turned out to be a
 * 2.7.7-generation binary (521,193,612 B) while the shell-v2.8.0 release asset is
 * 543,630,883 B. So the object must answer and its size must sit within SIZE_TOLERANCE of
 * the release asset.
 *
 * The tolerance is deliberate: the publish pipeline rebuilds the APK for the CDN copy, so a
 * current release differs by a few bytes (shell-v2.8.4: +4 B, three zip entries with
 * different CRCs — a build stamp and two patch manifests). Refusing that cost every visitor
 * the fast first-party link, so small deltas now prefer the CDN; a large delta is a
 * different build and is still refused.
 */
export async function cdnHasBuild(tag, expectedSize) {
  const candidates = r2Candidates(tag);
  if (!expectedSize) return { ok: false, url: candidates[0], reason: 'size-unknown', expected: 0, size: 0 };
  let firstBad = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const url = candidates[i];
    let res;
    try {
      res = await fetch(busted(url), {
        method: 'HEAD',
        cf: { cacheTtl: 0, cacheEverything: false },
        signal: AbortSignal.timeout(4000),
      });
    } catch (err) {
      if (!firstBad) firstBad = { ok: false, url, reason: 'probe-failed', expected: expectedSize, size: 0 };
      continue;
    }
    const size = Number(res.headers.get('content-length') || 0);
    if (!res.ok) {
      if (!firstBad) firstBad = { ok: false, url, reason: 'missing', expected: expectedSize, size: 0 };
      continue;
    }
    if (size && Math.abs(size - expectedSize) > SIZE_TOLERANCE) {
      // 这条键在、但不是这份构建（2.8.0 那种差 22 MB 的旧包）：继续试下一个键名，
      // 两个都不符才回 size-mismatch
      if (!firstBad) firstBad = { ok: false, url, reason: 'size-mismatch', expected: expectedSize, size };
      continue;
    }
    return {
      ok: true, url, expected: expectedSize, size,
      key: url.split('/').pop(),
      reason: size === expectedSize ? 'ok' : 'size-close',
    };
  }
  return firstBad || { ok: false, url: candidates[0], reason: 'probe-failed', expected: expectedSize, size: 0 };
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
