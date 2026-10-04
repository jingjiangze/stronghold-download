#!/usr/bin/env node
/**
 * Regenerate data/releases.json — the offline snapshot the download page falls back to
 * when api.github.com is unreachable or rate-limited.
 *
 * Policy: the site offers ONLY the latest stable release and ONLY its APK asset.
 * Older versions are never stored, listed or linked.
 *
 * Usage: node tools/gen-snapshot.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'jingjiangze/Stronghold-Protocol';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'data', 'releases.json');
// Optional GH_TOKEN / GITHUB_TOKEN: raises the API limit from 60/h to 5000/h and avoids
// the random 403s an anonymous caller hits on a busy connection.
const HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'stronghold-download-snapshot'
};
if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
  HEADERS.authorization = 'Bearer ' + (process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
}

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Newest stable release that actually carries an APK (a brand-new release whose build
 *  has not attached assets yet is skipped rather than blanking the page). */
async function latestWithApk() {
  const list = await getJson(`https://api.github.com/repos/${REPO}/releases?per_page=10`);
  const stable = list.filter((r) => !r.draft && !r.prerelease);
  // An APK counts either as a release asset or as a direct .apk link in the notes
  // (newer builds ship the APK out-of-band via weishucdn).
  const picked = stable.find((r) => (r.assets || []).some((a) => /\.apk$/i.test(a.name)) ||
    /https?:\/\/[^\s)\]"<>]+\.apk/i.test(r.body || ''));
  if (!picked) throw new Error('no stable release with an APK (asset or notes link) found');
  return picked;
}

const release = await latestWithApk();
const apks = (release.assets || []).filter((a) => /\.apk$/i.test(a.name));
// CI mirrors every build to a predictable R2 path: apk/stronghold-v<version>.apk
// (e.g. shell-v2.7.6 -> apk/stronghold-v2.7.6.apk) — the first-party CDN beats the
// GitHub asset URL. But a brand-new release is not on the CDN yet, and the CF edge caches
// that 404 for hours, so the *probe* carries a cache-buster while the published link never
// does: the R2 custom domain ignores Range as soon as a query string is present, which
// would cost users resume support and make multi-connection downloaders refetch the file.
// Only publish the CDN link when the object actually answers with the release asset size.
const version = release.tag_name.replace(/^shell-v/, '');
const r2Url = `https://weishucdn.jiangjiangze.icu/apk/stronghold-v${version}.apk`;
const buster = `?cb=` + Date.now().toString(36);
const ghApk = apks[0] ? apks[0].browser_download_url : null;

async function probeCdn(url) {
  try {
    const res = await fetch(url, { headers: { range: 'bytes=0-1023' }, redirect: 'manual' });
    if (!(res.status === 200 || res.status === 206)) return { ok: false, size: 0 };
    const len = Number(res.headers.get('content-length') || 0);
    return { ok: true, size: res.status === 206 ? len + 1024 : len };
  } catch {
    return { ok: false, size: 0 };
  }
}

const ghSize = (apks[0] && apks[0].size) || 0;
const cdn = await probeCdn(r2Url + buster);
const useR2 = cdn.ok && (!ghSize || cdn.size === ghSize);
if (!useR2 && !ghApk) throw new Error(`neither the R2 mirror nor a GitHub apk asset is available for ${release.tag_name}`);
console.log(`r2 probe: ${cdn.ok ? 'live' : 'missing'} | cdn ${cdn.size} B vs release asset ${ghSize} B | 采用 ${useR2 ? 'CDN' : 'GitHub 资产'}`);

const snapshot = {
  generated: new Date().toISOString(),
  repo: REPO,
  // exactly one entry, APK assets only — the page never shows older versions
  releases: [
    {
      tag: release.tag_name,
      name: release.name,
      published_at: release.published_at,
      prerelease: !!release.prerelease,
      html_url: release.html_url,
      body: release.body || '',
      assets: apks.map((a) => ({
        name: a.name,
        size: a.size,
        url: a.browser_download_url,
        digest: a.digest || null
      }))
    }
  ]
};

if (useR2) {
  snapshot.releases[0].assets = [{
    name: `stronghold-v${version}.apk`,
    size: cdn.size || null,
    url: r2Url,
    digest: (apks[0] && apks[0].digest) || null,
    external: true
  }];
} else {
  // Keep the GitHub asset: the page routes it through /api/download/<tag>/<file>, which
  // re-checks the CDN at click time and picks up the R2 object once CI has uploaded it.
  snapshot.releases[0].assets = [{
    name: apks[0].name,
    size: apks[0].size,
    url: ghApk,
    digest: apks[0].digest || null
  }];
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');
console.log(`snapshot written: ${OUT}`);
console.log(`latest: ${release.tag_name} | apk assets: ${apks.map((a) => a.name).join(', ')}`);
