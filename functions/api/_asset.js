// Shared asset-target helpers for the download functions.
//
// 首方 R2 镜像（weishucdn）与 mirror-apk 上传已于 2026-10-14 取消，所以这里不再有
// 「CDN 有没有这份构建」的探测：/api/latest 只负责给出最新 release，/api/download
// 直接落到公共加速器（或 GitHub 资产本身）。

export const SNAPSHOT_ID = 'latest-release';

/** Public accelerators in front of a GitHub URL, in preference order. */
export const ACCELERATORS = [
  'https://gh-proxy.com/',
  'https://ghfast.top/',
];

export function githubAsset(tag, file) {
  return 'https://github.com/jingjiangze/Stronghold-Protocol/releases/download/' + tag + '/' + file;
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
