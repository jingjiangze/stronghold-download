#!/usr/bin/env node
/* ==========================================================================================
   changelog.mjs — 给下载页生成"玩家看得懂"的简略更新日志，写到 R2 的 site/changelog.json

   为什么不在页面请求时算：/api/latest 是匿名访问 GitHub 的（本机/大陆出口常 403，边缘出口也有
   60 次/小时的每 IP 限额），而这份日志需要 compare + 每个提交查一次关联 PR —— 十几次调用放在
   访客路径上必然撞限额。所以放在 mirror-apk 里算（它有 workflow token，本来每次发布就跑），
   结果落 R2，站点只是读一个对象。

   数据源与取舍：
     compare(prevStableTag...tag).commits  →  每个提交查 /commits/{sha}/pulls
     优先用 PR 标题（人写的中文介绍，比 commit 主题行适合给玩家看），没有 PR 才用主题行首行。
     bot 与流水线提交（promote:/sync: upstream/chore(deps)/audit mirror:/[bot] 账号）不计入正文，
     只记进 internal_count —— 玩家不需要知道发布闸门改了什么。没有 PR 的提交额外要求**主题是中文**
     （英文主题行基本是会话移植与审计内容），并剥掉 `feat:`/`fix:` 这类约定前缀。

     node tools/changelog.mjs --tag shell-v2.9.27 [--prev shell-v2.9.26] [--out f.json]
     环境变量：GH_TOKEN（必需）、SRC_REPO（默认 jingjiangze/Stronghold-Protocol）
   ========================================================================================== */
import fs from 'node:fs';

const REPO = process.env.SRC_REPO || 'jingjiangze/Stronghold-Protocol';
const TOKEN = process.env.GH_TOKEN || '';
const MAX_COMMITS = 16;          // 一次发布最多看这么多提交（上游同步的合并提交只算一条）
const MAX_ITEMS = 6;             // 页面上最多显示几条
const TEXT_CLIP = 120;

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };

// 流水线/机器人提交：对玩家没有信息量，还会把日志挤满
const INTERNAL = /^(promote:|apk-release\/|sync: upstream|chore\(deps\)|ci\(|\.github\/|build\(deps\)|audit(?: mirror)?:|port the main session)/i;
const INTERNAL_USER = /\[bot\]|dependabot|sourcery/i;
// 没有关联 PR 的提交只剩主题行，而主题行是写给维护者看的：英文的基本是流水线、
// 会话移植、审计这类内容（"audit mirror: apk@…"、"port the main session's PR#28 …"），
// 放进玩家日志就没人知道那条在说什么。所以无 PR 的提交要中文主题才进正文，其余只计数。
const CJK = /[㐀-鿿぀-ヿ가-힯]/;
const CONVENTIONAL = /^((feat|fix|perf|refactor|style|docs?|chore|revert)(\([^)]*\))?!?):\s*/i;

function cleanTitle(text) {
  const raw = String(text || '');
  const out = raw.replace(CONVENTIONAL, '');
  return out.trim() ? out : raw;   // 整条就是个 `feat:` 前缀时别把内容清空
}

function clip(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const cap = max || TEXT_CLIP;
  return t.length > cap ? t.slice(0, cap - 1) + '…' : t;
}

async function api(path) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch('https://api.github.com/' + path, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: 'Bearer ' + TOKEN,
          'user-agent': 'stronghold-changelog',
        },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) {
        // 限流时退一下再试：一次发布只跑一遍，慢一点没关系，拿不到才要紧
        await new Promise((r) => setTimeout(r, 3000 * attempt));
        continue;
      }
      if (!res.ok) return { error: 'HTTP ' + res.status + ' ' + path };
      return { json: await res.json() };
    } catch (err) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  return { error: 'unreachable ' + path };
}

async function resolvePrev(tag) {
  const got = await api('repos/' + REPO + '/releases?per_page=40');
  if (got.error) return { error: got.error };
  const stable = (got.json || []).filter((r) => !r.draft && !r.prerelease &&
    (r.assets || []).some((a) => /\.apk$/i.test(a.name)));
  const idx = stable.findIndex((r) => r.tag_name === tag);
  return { list: stable, prev: idx >= 0 && idx + 1 < stable.length ? stable[idx + 1].tag_name : null,
           self: idx >= 0 ? stable[idx] : null };
}

async function main() {
  if (!TOKEN) { console.error('缺 GH_TOKEN'); process.exit(2); }
  const tag = opt('tag', '');
  if (!tag) { console.error('需要 --tag'); process.exit(2); }

  const resolved = await resolvePrev(tag);
  const prev = opt('prev', '') || resolved.prev || '';
  const self = resolved.self || null;

  let commits = [];
  if (prev) {
    const cmp = await api('repos/' + REPO + '/compare/' + encodeURIComponent(prev) + '...' + encodeURIComponent(tag));
    if (cmp.error) console.error('compare 失败：' + cmp.error);
    else commits = (cmp.json.commits || []).slice(0, MAX_COMMITS);
  }

  const items = [];
  const seenPr = new Set();
  let internal = 0;

  for (const c of commits) {
    const subject = String(c.commit && c.commit.message ? c.commit.message.split('\n')[0] : '').trim();
    const author = (c.commit && c.commit.author && c.commit.author.name) || '';
    const assoc = await api('repos/' + REPO + '/commits/' + c.sha + '/pulls');
    const prs = assoc.error ? [] : (assoc.json || []);
    // 关联 PR 里只排掉机器人与流水线提交：squash/上游合并常把 merged_at 留空，
    // 但提交已经在 master 的历史里（它就是被这次发布带出来的），标题照样能用。
    const real = prs.filter((p) => !INTERNAL_USER.test((p.user && p.user.login) || '') &&
      !INTERNAL.test(String(p.title || '')));
    if (!real.length) {
      if (INTERNAL.test(subject) || /→ apk$/i.test(subject) || INTERNAL_USER.test(author) ||
          !CJK.test(subject)) { internal += 1; continue; }
      if (subject) items.push({ text: clip(cleanTitle(subject)), pr: null, author: clip(author, 30), html: null });
      continue;
    }
    for (const p of real) {
      if (seenPr.has(p.number)) continue;
      seenPr.add(p.number);
      items.push({ text: clip(cleanTitle(p.title)), pr: p.number,
                   author: (p.user && p.user.login) || '', html: p.html_url || null });
    }
  }

  const doc = {
    version: tag.replace(/^shell-/, ''),
    tag,
    prev: prev || null,
    published_at: (self && self.published_at) || null,
    url: (self && self.html_url) || ('https://github.com/' + REPO + '/releases/tag/' + tag),
    items: items.slice(0, MAX_ITEMS),
    internal_count: internal,
    commits_seen: commits.length,
    generated_at: new Date().toISOString(),
  };

  const out = opt('out', '');
  const body = JSON.stringify(doc, null, 2) + '\n';
  if (out) fs.writeFileSync(out, body);
  else process.stdout.write(body);
  console.error(`changelog ${doc.version}: ${doc.items.length} 条（看过 ${commits.length} 个提交，${internal} 条流水线噪声已滤掉）`);
  doc.items.forEach((i) => console.error('  - ' + (i.pr ? 'PR#' + i.pr + ' ' : '') + i.text));
}

await main();
