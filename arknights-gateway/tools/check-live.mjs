#!/usr/bin/env node
/* ==========================================================================================
   check-live.mjs — 部署后逐文件核对：线上拿到的字节必须与本地一致。

   为什么需要：css/js 在 Worker 里是 `max-age=31536000, immutable`。如果某个 `?v=` URL 的
   首次请求正好落在「新资源还没传播到该边缘节点」的窗口里，边缘会把**旧内容**钉在这个新
   URL 上，并且一年内不再回源 —— 本地改了、线上还是旧的，且没有任何报错。
   所以每次部署后跑一遍这个脚本：发现不一致就再 bump 一次 `?v=` 重新部署。

   用法：node tools/check-live.mjs [https://arknights.jiangjiangze.icu/]
   ========================================================================================== */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const base = (process.argv[2] || 'https://arknights.jiangjiangze.icu/').replace(/\/?$/, '/');

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex').slice(0, 16);

async function get(url) {
  const res = await fetch(url, { cache: 'no-store' });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body, hash: sha(body), cache: res.headers.get('cf-cache-status') || '-' };
}

// 1) 取线上 index.html，抽出它引用的本地 css/js（带 ?v=）
const indexRes = await get(base);
if (indexRes.status !== 200) {
  console.error(`✗ 线上首页不可用: HTTP ${indexRes.status}`);
  process.exit(1);
}
const html = indexRes.body.toString('utf8');
const refs = [...html.matchAll(/(?:href|src)="(\.\/(?:css|js)\/[^"]+)"/g)].map((m) => m[1]);

const problems = [];
let checked = 0;
for (const ref of refs) {
  const url = base + ref.replace(/^\.\//, '');
  const localPath = join(pub, ref.replace(/^\.\//, '').split('?')[0]);
  if (!existsSync(localPath)) { problems.push(`${ref}: 本地不存在`); continue; }
  const local = sha(readFileSync(localPath));
  const live = await get(url);
  checked += 1;
  const same = local === live.hash;
  console.log(`${same ? '✓' : '✗'} ${ref}  本地 ${local} / 线上 ${live.hash}  (${live.cache})`);
  if (!same) problems.push(`${ref}: 本地 ${local} ≠ 线上 ${live.hash}（边缘钉住了旧内容，bump ?v= 重新部署）`);
}

// 2) 数据文件也顺带核一下（前端用 no-cache 拉，边缘缓存 300s）
for (const rel of ['data/channels.json', 'data/announcements.json']) {
  const local = sha(readFileSync(join(pub, rel)));
  const live = await get(base + rel);
  checked += 1;
  const same = local === live.hash;
  console.log(`${same ? '✓' : '✗'} ${rel}  本地 ${local} / 线上 ${live.hash}  (${live.cache})`);
  if (!same) problems.push(`${rel}: 本地 ${local} ≠ 线上 ${live.hash}`);
}

console.log(problems.length ? `\n✗ ${problems.length} 项不一致:\n  - ${problems.join('\n  - ')}` : `\n✓ 线上 ${checked} 个文件与本地逐字节一致`);
process.exit(problems.length ? 1 : 0);
