#!/usr/bin/env node
/* ==========================================================================================
   watch-production.mjs — 看门狗：线上跑的不是 origin/main 的内容时，从 main 重新直传一次

   为什么需要它：Pages 项目没连 git（CF API 里项目对象没有 source），GitHub 上那个
   pages-build-deployment 工作流跑成功也不会改生产 —— 直传是唯一上线路径，所以任何一棵
   旧树直传一次，线上就变成旧的了（10-07 真发生过：旧线 cd6fbcb 连传 4 次，生产退回
   download.js?v=22 一个多小时）。tools/deploy.mjs 里的闸门只挡得住"已经拉到 main 的那一方"
   —— 旧树跑的是它自己那份没有闸门的旧脚本。这条看门狗补上另一半：不管谁盖了，15 分钟内
   自动回到 main。

     node tools/watch-production.mjs --dry   只比对，不动线上
     node tools/watch-production.mjs         不一致就从 origin/main 重新直传
     计划任务里跑这份副本时带 --repo "C:\DDDD\Agent Work\stronghold-dl-site"

   判据用版本标记而不是整份文件：index.html 里的 download.js?v= / dl.css?v=，
   servers.html 里的 servers.js?v= / servers.css?v=。改任何对外代码都必须 bump ?v=
   （一年 immutable，不换号等于没人拿到新代码），所以这四个号一致 ≈ 线上就是 main。
   ========================================================================================== */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 默认跟着自己所在的仓库跑；计划任务里用 --repo 指过去，这样这份脚本可以放在任何地方，
// 也不会依赖某个窗口的脏工作树。
const argOf = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const REPO_DIR = path.resolve(argOf('repo', path.resolve(HERE, '..')));
const SRC = REPO_DIR;
const SITE = 'https://dl.jiangjiangze.icu';
const LOG = path.resolve(REPO_DIR, '..', '_watch-production.log');
const WORKTREE = path.resolve(REPO_DIR, '..', '_wt-watch');

// [仓库里的 html, 它引用的资源名, 线上取哪个地址]
const MARKERS = [
  ['index.html', 'download.js', '/'],
  ['index.html', 'dl.css', '/'],
  ['servers.html', 'servers.js', '/servers'],
  ['servers.html', 'servers.css', '/servers'],
];

const git = (args, cwd) => execFileSync('git', args, {
  cwd: cwd || SRC, encoding: 'utf8', timeout: 120000,
  // 计划任务里没有终端可以问口令：GIT_TERMINAL_PROMPT=0 让 git 直接失败而不是挂在那里
  // （实测这个任务曾经 7 分钟不落一行日志，就是卡在 fetch 上等凭据）。
  env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }),
}).trim();

function versionOf(text, asset) {
  const m = String(text || '').match(new RegExp(asset.replace('.', '\\.') + '\\?v=(\\d+)'));
  return m ? Number(m[1]) : null;
}

async function liveVersions(page) {
  // 本机到 Cloudflare 的链路会整段抽掉（实测同一份 HTML 从 0.2 s 到 30 s+ 都有），看门狗是
  // 无人值守跑的，必须自己重试；读不到就本轮放弃，下一轮再看，绝不因为超时去动线上。
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(SITE + page + '?cb=' + Date.now().toString(36),
        { cache: 'no-store', signal: AbortSignal.timeout(90000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (err) {
      last = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  throw last || new Error('unreachable');
}

function log(line) {
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  try {
    const prev = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n') : [];
    fs.writeFileSync(LOG, prev.concat(stamp + ' ' + line).slice(-400).join('\n') + '\n');
  } catch (err) { /* 日志写不下不影响判断 */ }
  console.log(stamp + ' ' + line);
}

const dry = process.argv.includes('--dry');

/**
 * 先确定"main 到底是哪个提交"，再谈比对。
 * 这一步不能只靠 git fetch：本机 github.com:443 经常不通（api.github.com 却是通的），
 * 而**如果拿本地那条旧的 origin/main 去比线上，会把"线上更新"误判成"线上被盖了"**，
 * 然后真去把别人的新构建回滚掉 —— 那就变成我们本来要防的那个事故。
 * 所以：远端真值问 api.github.com；只有本地记录已经追上它，才允许动手修线。
 */
const REPO = 'jingjiangze/stronghold-download';
async function apiJson(p) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch('https://api.github.com/repos/' + REPO + p, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'stronghold-watch-production' },
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 4000 * attempt));
    }
  }
  return null;
}

let remoteTip = '';
try {
  const rows = await apiJson('/commits?sha=main&per_page=1');
  remoteTip = rows && rows[0] && rows[0].sha || '';
} catch (err) { log('问不到远端 main（' + err.message + '）'); }

try { git(['fetch', 'origin', '--quiet']); }
catch (err) { log('git fetch 失败：' + String(err.message).split('\n')[0]); }

let localRef = '';
try { localRef = git(['rev-parse', 'origin/main']); } catch (err) { localRef = ''; }

if (!remoteTip) { log('没有远端真值，本轮不判断（绝不拿本地旧 ref 去修线）'); process.exit(1); }
const remote = remoteTip;
// 动手修线需要 main 的**整棵树**（只有 git fetch 拿得到），所以本地引用必须已经追上远端。
// 但"发现线上被人盖了"不需要 —— 期望值直接问 api.github.com 的 contents 接口，
// github.com:443 不通的那段时间里照样能报警（只是不动线上）。
const canFix = localRef === remoteTip;
if (!canFix) {
  log('本地 origin/main (' + (localRef ? localRef.slice(0, 7) : '无') + ') ≠ 远端 main (' +
    remoteTip.slice(0, 7) + ') —— 本轮只报告，不动线上');
}

async function expectedFromApi(file) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch('https://api.github.com/repos/' + REPO + '/contents/' +
        file.split('/').map(encodeURIComponent).join('/') + '?ref=' + remoteTip, {
        headers: { accept: 'application/vnd.github.raw', 'user-agent': 'stronghold-watch-production' },
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 4000 * attempt));
    }
  }
  return '';
}

const sources = [];
for (const [file, asset, page] of MARKERS) {
  if (!sources.some((s) => s.file === file)) {
    let text = '';
    try { text = await expectedFromApi(file); }
    catch (err) { log('读不到远端 ' + file + '：' + err.message); }
    sources.push({ file, text });
  }
}
const checks = MARKERS.map(([file, asset, page]) => ({
  file, asset, page, want: versionOf((sources.find((s) => s.file === file) || {}).text, asset),
}));

let pages = {};
try {
  const uniq = [...new Set(checks.map((c) => c.page))];
  const bodies = await Promise.all(uniq.map((page) => liveVersions(page)));
  uniq.forEach((page, i) => { pages[page] = bodies[i]; });
} catch (err) { log('读线上失败：' + err.message); process.exit(1); }

const bad = checks.filter((c) => {
  const got = versionOf(pages[c.page], c.asset);
  c.got = got;
  return c.want !== null && got !== c.want;
});
const summary = checks.map((c) => c.asset + ' main=' + c.want + ' 线上=' + (c.got === undefined ? '?' : c.got)).join(' | ');

if (!bad.length) { log('一致：' + summary); process.exit(0); }

log('✗ 线上与 main 不一致：' + summary);
if (dry) process.exit(2);
if (!canFix) { log('  …但本地拿不到 main 的整棵树（git fetch 未跟上），不动线上'); process.exit(2); }
log('  → 从 origin/main 重新直传');

try { fs.rmSync(WORKTREE, { recursive: true, force: true }); } catch (err) { /* Windows 上可能慢一拍 */ }
try { git(['worktree', 'add', '--detach', WORKTREE, remote]); }
catch (err) {
  // 上一轮的目录还没释放：清掉注册再试一次
  git(['worktree', 'prune']);
  git(['worktree', 'add', '--detach', WORKTREE, remote]);
}
const r = spawnSync('node', ['tools/deploy.mjs'], { cwd: WORKTREE, encoding: 'utf8', shell: true });
const out = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-3).join(' / ');
log((r.status === 0 ? '直传完成' : '直传失败 exit=' + r.status) + '：' + out);
try { git(['worktree', 'remove', '--force', WORKTREE]); } catch (err) { git(['worktree', 'prune']); }
process.exit(r.status === 0 ? 0 : 3);
