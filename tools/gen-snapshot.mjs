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
// CI also mirrors every build to a predictable R2 path: apk/stronghold-<version>.apk
// (e.g. shell-v2.7.6 -> apk/stronghold-v2.7.6.apk). Prefer it when it answers 200.
const version = release.tag_name.replace(/^shell-v/, '');
const r2Link = `https://weishucdn.jiangjiangze.icu/apk/stronghold-${version}.apk`;
let r2Ready = false;
try {
  // R2 answered HEAD inconsistently through some proxies; a 1-byte ranged GET is the
  // reliable probe (404 stays 404, 200 becomes 206).
  const probe = await fetch(r2Link, { headers: { 'user-agent': 'snapshot', range: 'bytes=0-1023' } });
  r2Ready = probe.status === 200 || probe.status === 206;
  try { await probe.body?.cancel(); } catch { /* body already consumed */ }
} catch { /* unreachable: fall back */ }
if (!apks.length && !notesLink && !r2Ready) {
  console.error(`release ${release.tag_name} has no usable APK (asset / notes link / R2 mirror all missing)`);
  process.exit(1);
}

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

// Direct-link preference (first-party R2 CDN beats the GitHub asset URL). The notes link
// wins if present; otherwise the predictable R2 path is used once it answers 200 — this
// covers the window where CI has uploaded to R2 but not attached the asset to the release.
if (r2Ready) {
  snapshot.releases[0].assets = [{
    name: `stronghold-${version}.apk`,
    size: null,
    url: r2Link,
    digest: null,
    external: true
  }];
} else if (notesLink) {
  snapshot.releases[0].assets = [{
    name: notesLink[0].split('/').pop().split(/[?#]/)[0] || 'app-release.apk',
    size: null,
    url: notesLink[0],
    digest: null,
    external: true
  }];
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');
console.log(`snapshot written: ${OUT}`);
console.log(`latest: ${release.tag_name} | apk assets: ${apks.map((a) => a.name).join(', ')}`);
