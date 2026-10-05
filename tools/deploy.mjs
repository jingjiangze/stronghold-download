#!/usr/bin/env node
/* ==========================================================================================
   deploy.mjs — 发布站点（唯一正确的上线方式）

     node tools/deploy.mjs            构建 staging 并部署到 Production
     node tools/deploy.mjs --dry      只打印将要上传的文件清单，不部署

   为什么不直接 `wrangler pages deploy .`：
     直传通道会把工作目录里的**每一个**文件烤进 deployment —— 实测 `.assetsignore` 对它
     无效（连 `.assetsignore` 自己都被列在文件里却仍返回 200）。于是 `.gitignore` 挡不住
     README.md / wrangler.toml / .github/workflows/*.yml / tools/*.mjs，更挡不住
     .mimosa/**（工具运行日志，含会话 id 与本机路径）和随手落在根目录的调试输出。
     2026-10-05 就是这么泄漏了 12 个调试文件 + 上面这些，清理只能靠换一个干净目录上传。
   ========================================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const DST = path.resolve(SRC, '..', '_dl-deploy');
const PROJECT = 'stronghold-download';

// 顶层不进站点的条目（目录按名字整棵剪掉）
const SKIP_TOP = new Set(['.git', '.github', '.wrangler', '.mimosa', 'node_modules',
  'tools', 'README.md', 'wrangler.toml', '.gitignore', '.assetsignore', '.dev.vars',
  '_dl-deploy', 'admin_harness.txt', 'ls.json']);

function skip(rel) {
  if (/(^|\/)\.mimosa(\/|$)/.test(rel)) return true;          // data/.mimosa 也算
  if (/(^|\/)\.(git|wrangler)(\/|$)/.test(rel)) return true;
  if (/_out\.txt$|_err\.txt$|test.*\.txt$/.test(rel)) return true;
  return false;
}

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (!base && SKIP_TOP.has(e.name)) continue;
    if (e.isDirectory()) { out.push(...walk(path.join(dir, e.name), rel)); continue; }
    if (skip(rel)) continue;
    out.push(rel);
  }
  return out;
}

const files = walk(SRC).sort();
if (process.argv.includes('--dry')) {
  console.log(`将上传 ${files.length} 个文件到 ${PROJECT}：\n${files.join('\n')}`);
  process.exit(0);
}
for (const must of ['index.html', 'functions/api/servers.js', 'js/servers.js']) {
  if (!files.includes(must)) throw new Error(`staging 里缺 ${must}，排除规则写错了，中止部署`);
}

fs.rmSync(DST, { recursive: true, force: true });
for (const rel of files) {
  const to = path.join(DST, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(SRC, rel), to);
}
console.log(`staged ${files.length} files -> ${DST}`);

const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: SRC }).toString().trim();
// Windows 上 npx 是 .cmd，Node 不允许在无 shell 的情况下 spawn 它，所以走 shell:true 并自己加引号
const cmd = ['npx --yes wrangler pages deploy', `"${DST}"`, `--project-name=${PROJECT}`,
  '--branch=main', '--commit-dirty=true'].join(' ');
const r = spawnSync(cmd, { cwd: SRC, encoding: 'utf8', shell: true });
const out = `${r.stdout || ''}${r.stderr || ''}`;
if (r.status !== 0) throw new Error(`wrangler pages deploy 失败 exit=${r.status}\n${out}`);
console.log(out.trim().split('\n').slice(-4).join('\n'));
console.log(`HEAD ${head} | 上传文件数 ${files.length}`);
