#!/usr/bin/env node
/* ==========================================================================================
   gh-push.mjs — github.com:443 打不通时，用 api.github.com 把当前 HEAD 的内容推到远端分支

   站点本身走 wrangler 直传、不依赖 git；但 `.github/workflows/*`（尤其 tls-probe 自动探针）
   **只有推到 GitHub 才会跑**，所以这条路必须随时能走。

   用法：
     node tools/gh-push.mjs --files .github/workflows/tls-probe.yml,tools/tls-probe.mjs
     node tools/gh-push.mjs --from 53772c6            # 该提交之后 HEAD 改过的文件全推
     node tools/gh-push.mjs --files x.js --delete y.js
     任何写法都支持 --dry / --branch main

   三条纪律（都是踩过的坑）：
     · 口令只从 git credential helper 取，绝不打印、绝不写盘；
     · 走 `base_tree`：只动点名的路径，远端别人推过的其余内容原样保留（不做全树覆盖，
       就不会把另一个窗口刚推的提交按回去）；
     · blobs 传**原文**（content 字段），不是 base64 —— 2026-10-06 就是因为把 base64 再塞进
       content，远端存下的是编码文本而不是代码；每个 blob 写完立刻拉回来逐字节比对。
   ========================================================================================== */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const REPO = process.env.GH_REPO || 'jingjiangze/stronghold-download';
const API = 'https://api.github.com';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : def;
};
const BRANCH = arg('branch', 'main');
const dry = process.argv.includes('--dry');
const git = (a) => execFileSync('git', a, { cwd: SRC, encoding: 'utf8' }).trim();

function readCred() {
  const out = execFileSync('git', ['credential', 'fill'], {
    cwd: SRC, encoding: 'utf8', input: 'protocol=https\nhost=github.com\n\n', stdio: ['pipe', 'pipe', 'ignore'],
  });
  const map = {};
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) map[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  if (!map.password) throw new Error('credential helper 里没有 github.com 的口令');
  return map;
}

const token = readCred().password;
const headers = { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json',
  'user-agent': 'stronghold-dl-site-gh-push', 'content-type': 'application/json' };
const call = async (method, url, body) => {
  const res = await fetch(API + url, { method, headers, signal: AbortSignal.timeout(90000),
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
};

const split = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
let files = split(arg('files', ''));
let deletes = split(arg('delete', ''));
const from = arg('from', '');
if (from) {
  const rows = git(['diff', '--name-status', from, 'HEAD']).split('\n').filter(Boolean);
  files = files.concat(rows.filter((l) => !/^D/.test(l)).map((l) => l.split('\t').pop()));
  deletes = deletes.concat(rows.filter((l) => /^D/.test(l)).map((l) => l.split('\t').pop()));
}
files = [...new Set(files)];
deletes = [...new Set(deletes)].filter((d) => !files.includes(d));
if (!files.length && !deletes.length) { console.error('没给文件：--files 或 --from 至少来一个'); process.exit(2); }
// 文件必须存在于**本地 HEAD 这棵提交里**（不是工作树）：要推的就是已提交的内容，
// 工作树里未提交的同类文件与本任务无关，混进来反而会把别人没验证过的东西推上线。
const head = git(['rev-parse', 'HEAD']);
for (const f of files) {
  const has = spawnSync('git', ['cat-file', '-e', `${head}:${f}`], { cwd: SRC }).status === 0;
  if (!has) { console.error(`本地 HEAD 里没有这个文件：${f}`); process.exit(2); }
}

console.log(`目标 ${REPO}@${BRANCH}：更新 ${files.length} · 删除 ${deletes.length}`);
files.forEach((f) => console.log('  +', f));
deletes.forEach((f) => console.log('  -', f));
if (dry) { console.log('（--dry：什么都没动）'); process.exit(0); }

const ref = await call('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`);
const remoteSha = ref.object.sha;
console.log('远端当前 =', remoteSha.slice(0, 10));

const tree = [];
for (const rel of files) {
  // 取**提交里**的内容，不是工作树的：core.autocrlf=true 时工作树是 CRLF，
  // 直接读文件会把 CRLF 推上远端，导致远端 blob 与本地 git blob 永远差一个 \r。
  // 注意这里不能走 git()：那个 helper 带 .trim()，会把文件末尾的换行吃掉。
  const raw = execFileSync('git', ['show', `${head}:${rel}`], { cwd: SRC, encoding: 'utf8' });
  const blob = await call('POST', `/repos/${REPO}/git/blobs`, { content: raw });   // 原文，不 base64
  tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
  const back = await call('GET', `/repos/${REPO}/git/blobs/${blob.sha}`);
  if (Buffer.from(back.content || '', 'base64').toString('utf8') !== raw) {
    throw new Error(`${rel} 远端字节与本地不一致，中止（不推半份代码）`);
  }
}
for (const rel of deletes) tree.push({ path: rel, mode: '100644', type: 'blob', sha: null });

const newTree = await call('POST', `/repos/${REPO}/git/trees`, { base_tree: remoteSha, tree });
const commit = await call('POST', `/repos/${REPO}/git/commits`, {
  message: `${git(['log', '-1', '--format=%s'])}\n\n（tools/gh-push.mjs 经 api.github.com 推送：本机到 github.com:443 不可达）`,
  tree: newTree.sha, parents: [remoteSha],
});
await call('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
console.log('已推送 →', commit.sha.slice(0, 10));
