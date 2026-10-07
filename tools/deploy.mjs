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

   上线闸门（10-07 加）：这个 Pages 项目**没有连 git**（CF API 里 `source: null`），GitHub 上
   那个 `pages-build-deployment` 工作流跑成功也不会改生产 —— 直传是唯一的上线路径，谁最后传
   谁说了算。10-07 另一条线（HEAD `cd6fbcb`，不含 main 上那十几个提交）连打 4 次直传，把线上
   按回了 `download.js?v=22` 的旧构建，一按就是一个多小时，而且那次连"谁改了 download.js"都
   看不出来。所以：**HEAD 必须已经包含远端 main 的全部提交**才允许上传；应急回滚要显式加
   `--allow-stale`。
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
  'tools', 'tests', 'README.md', 'wrangler.toml', '.gitignore', '.assetsignore', '.dev.vars',
  '_dl-deploy', '_dl-build', '_dl-union', '_tmp', 'admin_harness.txt', 'ls.json']);

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

/**
 * 闸门：这份树是不是远端 main 的**后代**。不是就说明它在一条旧线上，直传会把别人已经上线的
 * 内容按回去（而这个项目没连 git，没有任何东西会把它纠正回来）。
 */
function gateAgainstStaleLine(dryRun) {
  const allow = process.argv.includes('--allow-stale');
  let fetched = true;
  try { execFileSync('git', ['fetch', 'origin'], { cwd: SRC, stdio: 'ignore' }); }
  catch (err) { fetched = false; }
  let remote = '';
  try { remote = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: SRC, encoding: 'utf8' }).trim(); }
  catch (err) { /* 没有远端跟踪引用 */ }
  if (!remote && fetched) {
    try { remote = execFileSync('git', ['rev-parse', 'FETCH_HEAD'], { cwd: SRC, encoding: 'utf8' }).trim(); }
    catch (err) { /* 连 FETCH_HEAD 都没有 */ }
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SRC, encoding: 'utf8' }).trim();
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: SRC, encoding: 'utf8' }).trim();

  if (!remote) {
    const why = '拿不到 origin/main（网络或远端引用问题），闸门无法判断这份树是否落后。';
    if (allow || dryRun) { console.warn('⚠ ' + why + (allow ? '已给 --allow-stale，继续。' : '')); return; }
    throw new Error(why + '确认远端可达后重试，或应急时加 --allow-stale。');
  }
  if (remote === head) return;
  const anc = spawnSync('git', ['merge-base', '--is-ancestor', remote, head], { cwd: SRC, stdio: 'ignore' });
  if (anc.status === 0) return;

  const missing = execFileSync('git', ['log', '--oneline', `${head}..${remote}`], { cwd: SRC, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const lines = [
    `✗ 这份树不在 origin/main 之后：分支 ${branch} @ ${head.slice(0, 7)}，` +
      `远端 main 有 ${missing.length} 个提交不在它里面：`,
    ...missing.slice(0, 12).map((l) => '    ' + l),
  ];
  if (missing.length > 12) lines.push(`    …另外 ${missing.length - 12} 条`);
  lines.push('  直传会把上面这些提交的内容从生产按回去。先 `git fetch && git rebase origin/main`，' +
    '或者从 origin/main 开一个 worktree 再上线（`git worktree add ../_wt-x origin/main`）。');
  const msg = lines.join('\n');
  if (allow) { console.warn(msg.replace(/^/, '⚠ --allow-stale 已给，跳过闸门继续：\n')); return; }
  if (dryRun) { console.warn(msg + '\n（--dry：只提示，不中止）'); return; }
  throw new Error(msg);
}

gateAgainstStaleLine(process.argv.includes('--dry'));

const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: SRC, encoding: 'utf8' })
  .split('\n').filter(Boolean)
  .filter((l) => !/^\?\?/.test(l))
  .map((l) => l.slice(3).trim())
  .filter((p) => !/^(tools|\.github|tests)\//.test(p) && p !== 'README.md' && p !== 'wrangler.toml');
if (dirty.length) {
  console.warn(`⚠ 有 ${dirty.length} 个未提交的对外文件会被一起上传（远端仓库里看不到它们）：` +
    dirty.slice(0, 6).join(', ') + (dirty.length > 6 ? ' …' : ''));
}
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
