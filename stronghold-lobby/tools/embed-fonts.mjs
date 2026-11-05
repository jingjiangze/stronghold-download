// tools/embed-fonts.mjs — inline the lobby page's display fonts into src/page.js.
//
// WHY: GET / is served by this Worker with no asset routes and keeps "zero external requests"
// (CSP default-src 'none'), so the two woff2 files the download site serves as /fonts/*.woff2
// have to travel inside the document as base64 data: URIs. Same faces, same provenance as the
// game client / download site (Bender by Jovanny Lemonad et al.; Novecento Wide by Jan Tonellato
// — free-font terms, see THIRD-PARTY-NOTICES.md).
//
// The generator rewrites only the block between the @@FONTS-BEGIN@@ / @@FONTS-END@@ markers in
// src/page.js, so re-running it after a font update is idempotent. Bender Light (weight 300) is
// deliberately not embedded: nothing in this page uses weight 300.
//
// usage: node tools/embed-fonts.mjs [--from <fontsDir>] [--file <page.js>]
//   default fontsDir: ../../../stronghold-dl-site/fonts (the download-site repo, sibling of lobby-work/)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const fontsDir = resolve(here, opt('--from', '../../../stronghold-dl-site/fonts'));
const pageFile = resolve(here, opt('--file', '../src/page.js'));

const FACES = [
  { family: 'Bender', file: 'bender-regular.woff2', weight: 400 },
  { family: 'Novecento Wide', file: 'novecento-wide-normal.woff2', weight: 400 },
];

const blocks = [];
for (const face of FACES) {
  const file = join(fontsDir, face.file);
  if (!existsSync(file)) {
    console.error(`missing font file: ${file}`);
    process.exit(1);
  }
  const b64 = readFileSync(file).toString('base64');
  blocks.push(
    `@font-face{font-family:'${face.family}';font-style:normal;font-weight:${face.weight};font-display:swap;` +
    `src:url(data:font/woff2;base64,${b64}) format('woff2')}`,
  );
}
const css = blocks.join('\n');

const source = readFileSync(pageFile, 'utf8');
const BEGIN = '/* @@FONTS-BEGIN@@ */';
const END = '/* @@FONTS-END@@ */';
const begin = source.indexOf(BEGIN);
const end = source.indexOf(END);
if (begin < 0 || end < 0 || end < begin) {
  console.error(`markers not found in ${pageFile} — expected ${BEGIN} ... ${END}`);
  process.exit(1);
}

const next = source.slice(0, begin + BEGIN.length) + '\n  ' + css + '\n  ' + source.slice(end);
writeFileSync(pageFile, next);
console.log(`embedded ${FACES.length} faces (${(css.length / 1024).toFixed(1)} KiB of base64) into ${pageFile}`);
