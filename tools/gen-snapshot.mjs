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
const HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'stronghold-download-snapshot'
};

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Latest stable release: /releases/latest, falling back to the newest non-prerelease entry. */
async function latestStable() {
  try {
    return await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  } catch (err) {
    if (err.status !== 404) throw err;
    const list = await getJson(`https://api.github.com/repos/${REPO}/releases?per_page=10`);
    const stable = list.find((r) => !r.draft && !r.prerelease);
    if (!stable) throw new Error('no stable release found');
    return stable;
  }
}

const release = await latestStable();
const apks = (release.assets || []).filter((a) => /\.apk$/i.test(a.name));
if (!apks.length) {
  console.error(`release ${release.tag_name} has no .apk asset`);
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
      assets: apks.map((a) => ({
        name: a.name,
        size: a.size,
        url: a.browser_download_url,
        digest: a.digest || null
      }))
    }
  ]
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');
console.log(`snapshot written: ${OUT}`);
console.log(`latest: ${release.tag_name} | apk assets: ${apks.map((a) => a.name).join(', ')}`);
