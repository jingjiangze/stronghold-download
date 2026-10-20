// Shared asset-target helpers for the download functions.
//
// 首方 R2 镜像（weishucdn）与 mirror-apk 上传已于 2026-10-14 取消，所以这里不再有
// 「CDN 有没有这份构建」的探测：/api/latest 只负责给出最新 release，/api/download
// 直接落到公共加速器（或 GitHub 资产本身）。

export const SNAPSHOT_ID = 'latest-release';

/** Public accelerators in front of a GitHub URL. Order is no longer a preference: the
 *  caller races them and keeps whichever actually streams fastest (see `raceAccelerators`). */
export const ACCELERATORS = [
  'https://gh-proxy.com/',
  'https://ghfast.top/',
];

/** How much each candidate must stream before it counts as alive, and the ceiling on how
 *  long we wait. Kept small: this runs inline on a click, and the whole point is to answer
 *  "which mirror is fastest" without the user waiting for it. */
const PROBE_BYTES = 512 * 1024;
const PROBE_TIMEOUT_MS = 4000;

export function githubAsset(tag, file) {
  return 'https://github.com/jingjiangze/Stronghold-Protocol/releases/download/' + tag + '/' + file;
}

/** Stream up to PROBE_BYTES from one accelerator and report its throughput.
 *  Returns null on any failure, so a dead proxy can never become a redirect target. */
async function measure(accUrl) {
  const started = Date.now();
  try {
    const res = await fetch(accUrl, {
      method: 'GET',
      headers: { range: 'bytes=0-' + (PROBE_BYTES - 1) },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 206) return null;

    let received = 0;
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) {
      const buf = await res.arrayBuffer();
      received = buf.byteLength;
    } else {
      try {
        while (received < PROBE_BYTES) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received += chunk.value.byteLength;
        }
      } finally {
        try { await reader.cancel(); } catch (err) { /* already closed */ }
      }
    }
    if (received <= 0) return null;
    // A 200 (Range ignored) means the proxy is sending the whole 1 GB body: the bytes we did
    // read are still a valid sample of its speed, so this is not treated as a failure.
    const seconds = Math.max((Date.now() - started) / 1000, 0.01);
    return { bytes: received, mbps: (received / 1048576) / seconds };
  } catch (err) {
    return null;
  }
}

/** Race every accelerator and return the fastest one that actually streams bytes.
 *
 * Why not the old "first one that answers a 1 KiB probe": that picked a fixed order, so a
 * visitor on a network where the first entry is throttled got the slow mirror every single
 * time and had no way to know. Now the candidate list is probed concurrently (so the cost
 * is one slow candidate's timeout, not the sum of all of them) and the winner is chosen by
 * measured throughput.
 *
 * Tie-break/fallback: if nothing streams, callers fall back to the GitHub asset itself. */
export async function raceAccelerators(ghUrl) {
  const results = await Promise.all(ACCELERATORS.map(async function (prefix) {
    const m = await measure(prefix + ghUrl);
    return m ? { url: prefix + ghUrl, via: prefix, mbps: m.mbps, bytes: m.bytes } : null;
  }));
  const alive = results.filter(Boolean);
  if (!alive.length) return { ok: false, url: null, via: null, mbps: 0, probed: 0 };
  alive.sort(function (a, b) { return b.mbps - a.mbps; });
  const best = alive[0];
  return { ok: true, url: best.url, via: best.via, mbps: best.mbps, probed: alive.length };
}

/** Kept for compatibility with any caller that only needs "is anything alive": the old
 *  single-shot probe, now expressed on top of the race. */
export async function accelerated(ghUrl) {
  const r = await raceAccelerators(ghUrl);
  return r.ok ? { ok: true, url: r.url, via: r.via } : { ok: false, url: null, via: null };
}
