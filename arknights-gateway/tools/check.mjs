#!/usr/bin/env node
/* ==========================================================================================
   check.mjs — 部署前的静态检查（不联网）。

   检查项：
   1. index.html 引用的每个本地资源都在磁盘上；
   2. 站内没有任何第三方子资源（样式/脚本/字体/图片）；外链 <a> 允许，但必须落在白名单里；
   3. JSON 数据文件可解析，通道 origin 是 https 且主机名是公网地址；
   4. fonts.css / webfonts-local.css 里 @font-face 指向的字体文件都存在；
   5. JS 语法可解析（模块按 ESM 检查）。
   ========================================================================================== */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const failures = [];
const notes = [];

const fail = (msg) => failures.push(msg);
const note = (msg) => notes.push(msg);

/* 1 + 2 ---- HTML --------------------------------------------------------------------------- */
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'dl.jiangjiangze.icu',
  'sp-lobby.jiangjiangze.icu',
  'downcdn.jiangjiangze.icu',
  'github.com',
]);

const html = readFileSync(join(pub, 'index.html'), 'utf8');

// 子资源：<link rel=stylesheet|modulepreload|preload ...>、<script src>、<img src>
const subresourcePattern = /<(link|script|img|source|iframe)\b[^>]*?(?:href|src)\s*=\s*"([^"]+)"/gi;
for (const match of html.matchAll(subresourcePattern)) {
  const [, tag, url] = match;
  if (/^(data:|#)/i.test(url)) continue;
  if (/^https?:\/\//i.test(url)) {
    fail(`第三方子资源: <${tag}> ${url}`);
    continue;
  }
  const clean = url.split('?')[0].replace(/^\.\//, '').replace(/^\//, '');
  if (!existsSync(join(pub, clean))) fail(`引用的本地资源不存在: ${url}`);
}

// 外链 <a href>
for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*"(https?:\/\/[^"]+)"/gi)) {
  const host = new URL(match[1]).hostname;
  if (!ALLOWED_EXTERNAL_HOSTS.has(host)) fail(`外链主机不在白名单: ${match[1]}`);
}

// 内联样式/脚本里不该出现外域
for (const match of html.matchAll(/url\(\s*['"]?(https?:\/\/[^)'"]+)/gi)) {
  fail(`内联样式引用了外域: ${match[1]}`);
}

/* ---- 服务器区块与通道卡（2026-10-09 改版后） ------------------------------------------------ */
// 旧设计（服务器网络实时监控 / 第三方节点卡 / 全站地域延迟）已下线：
// 不再有 .net-card / .net-grid / .net-summary / #network-section，也不再有该区块的「进入游戏」按钮。
// 新设计：三条通道卡（.channel-card）只放「你的延迟 + 服务器状态」，服务器级数值统一在
// 「我的服务器」（#server-section / .server-stats）出现一份；延迟由玩家浏览器自主实测。
const htmlForNet = readFileSync(join(pub, 'index.html'), 'utf8');
if (/\.net-card|net-grid|net-summary|net-hint|network-section/.test(htmlForNet)) {
  fail('index.html 仍残留旧「服务器网络实时监控」结构（.net-card / net-grid / #network-section）');
}
if (/服务器网络实时监控/.test(htmlForNet)) fail('index.html 仍含「服务器网络实时监控」文案');

/* 2 ---- CSS ------------------------------------------------------------------------------- */
const cssDir = join(pub, 'css');
const cssFiles = [];
const walkCss = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkCss(full);
    else if (entry.name.endsWith('.css')) cssFiles.push(full);
  }
};
walkCss(cssDir);
for (const file of cssFiles) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/url\(\s*['"]?(https?:\/\/[^)'"]+)/gi)) {
    fail(`${file.replace(root, '.')} 引用了外域资源: ${match[1]}`);
  }
}

/* 3 ---- 数据文件 --------------------------------------------------------------------------- */
const isPrivateIp = (host) => {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224;
  }
  return host === 'localhost' || host.includes(':') || host.endsWith('.local') || host.endsWith('.internal');
};

const channels = JSON.parse(readFileSync(join(pub, 'data/channels.json'), 'utf8'));
if (!Array.isArray(channels.channels) || channels.channels.length === 0) fail('channels.json 没有通道');
for (const channel of channels.channels) {
  let url;
  try {
    url = new URL(channel.origin);
  } catch {
    fail(`通道 ${channel.id} 的 origin 不是合法 URL: ${channel.origin}`);
    continue;
  }
  if (url.protocol !== 'https:') fail(`通道 ${channel.id} 不是 https: ${channel.origin}`);
  if (isPrivateIp(url.hostname.toLowerCase())) fail(`通道 ${channel.id} 指向私网/保留地址: ${url.hostname}`);
  if (url.hostname.toLowerCase() !== String(channel.host).toLowerCase()) {
    fail(`通道 ${channel.id} 的 host 字段与 origin 不一致: ${channel.host} vs ${url.hostname}`);
  }
}
const announcements = JSON.parse(readFileSync(join(pub, 'data/announcements.json'), 'utf8'));
for (const item of announcements.announcements ?? []) {
  if (!item.title || !item.text) fail(`公告缺少标题或正文: ${item.revision}`);
  if (!Number.isFinite(item.publishedAt)) fail(`公告缺少 publishedAt: ${item.revision}`);
  if (item.publishedAt > Date.now()) fail(`公告发布时间在未来: ${item.revision}`);
}

/* 4 ---- 字体 ------------------------------------------------------------------------------- */
for (const cssName of ['fonts/fonts.css', 'fonts/webfonts-local.css']) {
  const text = readFileSync(join(pub, cssName), 'utf8');
  for (const match of text.matchAll(/url\(\s*['"]?(\/fonts\/[^)'"]+)/gi)) {
    const target = join(pub, match[1].replace(/^\//, ''));
    // .otf/.ttf 只是 woff2 之后的兜底，缺失不算错；woff2 必须存在。
    if (match[1].endsWith('.woff2') && !existsSync(target)) fail(`${cssName} 指向的字体不存在: ${match[1]}`);
  }
}

/* 5 ---- JS --------------------------------------------------------------------------------- */
const jsFiles = readdirSync(join(pub, 'js')).filter((f) => f.endsWith('.js'));
for (const file of jsFiles) {
  const full = join(pub, 'js', file);
  try {
    execFileSync(process.execPath, ['--check', '--input-type=module'], { input: readFileSync(full), stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    fail(`js/${file} 语法检查失败: ${String(error.stderr || error.message).split('\n')[0]}`);
  }
}
try {
  execFileSync(process.execPath, ['--check', join(root, 'src/index.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
} catch (error) {
  fail(`src/index.js 语法检查失败: ${String(error.stderr || error.message).split('\n')[0]}`);
}

/* 6 ---- 类名冲突 --------------------------------------------------------------------------- */
// 站内引入了 dl 站的 theme.css / components.css / screens/title.css，里面的游戏 UI 类名与
// 文档页类名可能同名（例如游戏内顶栏 .topbar 是 display:grid，会把页面顶栏压扁）。
// 有意复用 dl 组件的类名列在 allowlist 里，其余同名一律报错。
// 2026-10-12：这个检查原来只扫 index.html，admin.html 因此长期处于规则之外。
// 改成扫 public/ 下所有 html —— 新页面默认就受约束，不用等谁想起来手动加。
const VENDORED = ['css/theme.css', 'css/components.css', 'css/screens/title.css'];
// 有意复用 dl 的组件：按钮/面板/图标/背景纹理/排版小工具，以及标题屏背景（雷达 + 山脊）那组类。
const REUSED = new Set(['btn', 'btn--primary', 'btn--secondary', 'btn--ghost', 'icon', 'panel', 'cross', 'micro', 'display', 'num', 'app-bg', 'screen']);
const REUSED_PREFIXES = ['title-bg', 'ridge', 'micro--'];
// 后台页（admin.html）复用的 dl 组件变体：面板配色变体、面板内容槽、以及 theme.css 的 sr-only。
const ADMIN_REUSED = new Set(['panel--mint', 'panel--gold', 'panel__body', 'sr-only']);
const vendoredClasses = new Set();
for (const file of VENDORED) {
  const text = readFileSync(join(pub, file), 'utf8');
  for (const match of text.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) vendoredClasses.add(match[1]);
}
const htmlPages = readdirSync(pub).filter((f) => f.endsWith('.html')).sort();
if (!htmlPages.includes('index.html')) fail('public/ 下缺少 index.html');
for (const page of htmlPages) {
  // 门禁只保证「没撞名」，页面自己声明复用了什么（含 admin 白名单）才算有意。
  const extra = page === 'admin.html' ? ADMIN_REUSED : new Set();
  const usedClasses = new Set();
  for (const match of readFileSync(join(pub, page), 'utf8').matchAll(/class\s*=\s*"([^"]+)"/g)) {
    for (const name of match[1].split(/\s+/)) if (name) usedClasses.add(name);
  }
  for (const name of usedClasses) {
    const reused = REUSED.has(name) || REUSED_PREFIXES.some((prefix) => name.startsWith(prefix)) || extra.has(name);
    if (vendoredClasses.has(name) && !reused) {
      fail(`${page}: 类名与引入的 dl 样式冲突（请改名或加入 REUSED 白名单）: .${name}`);
    }
  }
}

/* 7 ---- 浏览器侧零第三方 ------------------------------------------------------------------- */
// 测速与探测全部在 Worker 侧完成，前端脚本里不该出现任何外部 URL；
// CSP 的 connect-src 也必须只有 'self'（有第三方 connect 就说明又回到「玩家参与测速」了）。
const workerSrc = readFileSync(join(root, 'src/index.js'), 'utf8');
const gateSrc = readFileSync(join(pub, 'js/gate.js'), 'utf8');
const frontendJs = [gateSrc, readFileSync(join(pub, 'js/notices.js'), 'utf8')];
for (const source of frontendJs) {
  // 玩家自主延迟探测是允许的（页面要对通道 origin 做 no-cors 连接计时），所以这里只查
  // 真·第三方探测服务地址（globalping / speed.cloudflare 之类），放行三通道 origin（已在 CSP
  // 放行，也在 channels.json 里）。注释里会写服务名与路径，只在实际代码上判。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const url = code.match(/https?:\/\/[^\s'"`]+/);
  if (url && /globalping|speed\.cloudflare|api\.measurement/i.test(url[0])) {
    fail(`前端脚本里出现了第三方探测服务地址（${url[0]}），延迟应改由玩家浏览器自主探测`);
  }
}
// 只在真正的 CSP 模板字符串上判断（注释里也会出现 connect-src 字样，别误伤）。
// 2026-10-09 起：connect-src 除了 'self' 还要放行三通道 origin（玩家浏览器自主测延迟），
// origin 是在 cspFor() 里按 channels.json 动态拼接进 ${connectExtra} 的，源码里不写死，
// 所以这里只验证：(a) connect-src 模板以 'self' 开头并插值了 ${connectExtra}；(b) cspFor
// 确实从通道 origin 构造 connectExtra。
const connectTpl = workerSrc.match(/`connect-src[^`]*`/);
if (!connectTpl) fail('src/index.js 找不到 connect-src 模板字符串');
else {
  const tpl = connectTpl[0];
  if (!/connect-src 'self'/.test(tpl)) fail('CSP 的 connect-src 必须以 \'self\' 开头');
  if (!/\$\{connectExtra\}/.test(tpl)) fail('CSP 的 connect-src 必须插值 ${connectExtra}（放行三通道 origin 供玩家自测延迟）');
  if (/[^a-z0-9' :/.\-*%${}`]/i.test(tpl.replace(/https?:\/\//g, '').replace(/`/g, ''))) {
    fail(`CSP 的 connect-src 含有无法识别的内容: ${tpl}`);
  }
}
// cspFor 必须从通道 origin 构造 connectExtra（否则三通道 origin 不会进 CSP，玩家自测延迟会被拦）。
if (!/connectExtra\s*=/.test(workerSrc) || !/channel\.origin|origin\.startsWith/.test(workerSrc)) {
  fail('src/index.js 的 cspFor 没有按通道 origin 构造 connectExtra');
}

note(`检查了 ${cssFiles.length} 个 css、${jsFiles.length} 个 js、${channels.channels.length} 条通道`);
if (failures.length) {
  console.error(`✗ ${failures.length} 项未通过:`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log(`✓ 全部通过（${notes.join('；')}）`);
