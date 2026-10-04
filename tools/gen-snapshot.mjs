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
const notesLink = (release.body || '').match(/https?:\/\/[^\s)\]"<>]+\.apk/i);
// CI mirrors every build to a predictable R2 path: apk/stronghold-<version>.apk
// (e.g. shell-v2.7.6 -> apk/stronghold-v2.7.6.apk) — the first-party CDN beats the
// GitHub asset URL. The CF edge caches 404s for hours (requests made before CI finishes
// uploading), so a naive probe can lie: always prefer the R2 link and append a
// cache-buster stamped at generation time to sidestep any stale 404 entry.
const version = release.tag_name.replace(/^shell-v/, '');
const r2UrlWithBuster = `https://weishucdn.jiangjiangze.icu/apk/stronghold-v${version}.apk?cb=` +
  Date.now().toString(36);

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

snapshot.releases[0].assets = [{
  name: `stronghold-v${version}.apk`,
  size: null,
  url: r2UrlWithBuster,
  digest: null,
  external: true
}];

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');
console.log(`snapshot written: ${OUT}`);
console.log(`latest: ${release.tag_name} | apk assets: ${apks.map((a) => a.name).join(', ')}`);
