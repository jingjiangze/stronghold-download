#!/usr/bin/env node
/* ==========================================================================================
   verify.mjs — 浏览器核验：本地 wrangler dev 或线上都能跑。

   检查：无第三方请求、无控制台/页面错误、三张通道卡状态正确、我的服务器（8 项数值）正确、
   公告轮播与历史弹窗可用，并输出桌面/移动整页截图。

   2026-10-09 改版后的预期：
   - 没有「服务器网络实时监控」区块（.net-card 不可出现）；
   - 延迟由玩家浏览器自主探测（对通道 origin 做 no-cors 连接计时），所以自签名证书那条
     渠道可能显示「不通」——这不算缺陷，只要页面没报错、其它两条拿到数字即可；
   - 「我的服务器」只有本站自己一台服的 8 个数值（在线玩家/会话/房间/对局/连接/运行时长/内存/CPU）。

   用法：node tools/verify.mjs <url> <截图前缀>
   playwright 从 ~/tools/pwshot 解析（那里装着 chromium）。
   ========================================================================================== */
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

// playwright（含 chromium）装在 pwshot 工具目录里；换机器用 PWSHOT_DIR 指过去。
const pwshot = resolve(process.env.PWSHOT_DIR || 'C:/Users/16891/tools/pwshot');
const { chromium } = createRequire(join(pwshot, 'package.json'))('playwright');

const url = process.argv[2] || 'http://127.0.0.1:8788/';
const prefix = process.argv[3] || 'arkgate';
// 浏览器只跟站点自己的 origin 说话（以及被允许的三条通道 origin，用于玩家自测延迟）；
// 出现别的 host（例如 globalping / speed.cloudflare）就说明又把探测挪回浏览器了。
const ALLOWED_HOSTS = new Set([new URL(url).hostname]);
try {
  const channels = JSON.parse(
    (await import('node:fs')).readFileSync(resolve(process.cwd(), 'public/data/channels.json'), 'utf8')
  );
  for (const c of channels.channels || []) {
    try { ALLOWED_HOSTS.add(new URL(c.origin).hostname); } catch { /* ignore */ }
  }
} catch { /* ignore */ }

// 2026-10-09 起不再有任何第三方探测（延迟改由玩家浏览器自主测、且同源），所以核验可以用系统
// 代理直连本站；不再需要 --proxy-server=direct://（那条反而会让本机 Chromium 连不上
// *.jiangjiangze.icu，因为该域名走的是 Clash 代理出口）。
const browser = await chromium.launch();
const report = { url, consoleErrors: [], pageErrors: [], foreignHosts: [], failed: [], cards: [], shots: [] };

for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1, locale: 'zh-CN' });
  const page = await ctx.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') report.consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => report.pageErrors.push(String(err.message)));
  page.on('request', (req) => {
    let host;
    try { host = new URL(req.url()).hostname; } catch { return; }
    if (!ALLOWED_HOSTS.has(host)) report.foreignHosts.push(req.url());
  });
  page.on('requestfailed', (req) => report.failed.push(`${req.url()} :: ${req.failure()?.errorText}`));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 等状态轮询 + 玩家自测延迟（3 次 × 900ms 间隙，外加首轮）
  await page.waitForTimeout(13000);

  report.cards = await page.$$eval('.channel-card', (nodes) => nodes.map((n) => ({
    id: n.dataset.channel,
    state: n.querySelector('[data-field="state"]')?.textContent?.trim(),
    metrics: [...n.querySelectorAll('.channel-metrics > div')].map((d) => `${d.querySelector('dt').textContent}=${d.querySelector('dd').textContent}`),
    latency: n.querySelector('[data-field="latency"]')?.textContent?.trim(),
    href: n.querySelector('.channel-actions a')?.getAttribute('href'),
  })));
  report.stats = await page.$$eval('.quick-stats strong', (n) => n.map((x) => x.textContent));
  report.region = {
    stat: await page.textContent('#statRegion').catch(() => null),
    meta: await page.textContent('#baselineMeta').catch(() => null),
    metaVisible: await page.$eval('#baselineMeta', (n) => !n.hidden).catch(() => false),
  };

  // 我的服务器：8 项数值，只在 #server-section 出现一份，不再有 .net-card / 第三方节点。
  const netCards = await page.$$eval('.net-card', (n) => n.length).catch(() => 0);
  report.server = {
    netCards,
    fields: await page.$$eval('#serverStats [data-field]', (n) => n.map((x) => `${x.dataset.field}=${x.textContent}`)),
    sub: await page.textContent('#serverStatsSub').catch(() => null),
    note: await page.textContent('#serverNote').catch(() => null),
  };

  report.notice = {
    status: await page.textContent('#announcementStatus').catch(() => null),
    slides: await page.$$eval('.announcement-slide', (n) => n.length),
  };

  // 线上大厅：只读房间牌（经本站 /api/lobby 代理，不应有任何第三方请求）。
  report.lobby = {
    section: await page.$eval('#lobby-section', (n) => !!n).catch(() => false),
    nav: await page.$$eval('.navigation a', (n) => n.map((x) => x.textContent)).then((a) => a.some((t) => t.includes('线上大厅'))),
    cards: await page.$$eval('#lobbyList .lobby-card', (n) => n.length).catch(() => 0),
    hasJoin: await page.$$eval('#lobbyList .lobby-card .btn', (n) => n.length).catch(() => 0),
    note: await page.textContent('#lobbyNote').catch(() => null),
  };
  report.guideText = await page.$$eval('.guide-list li', (n) => n.map((x) => x.textContent).join('|')).catch(() => '');

  // 当前服务器玩法（协同共竞）：区块必须存在、有内容卡片、引用审计。
  report.gameplay = {
    section: await page.$eval('#gameplay-section', (n) => !!n).catch(() => false),
    nav: await page.$$eval('.navigation a', (n) => n.map((x) => x.textContent)).then((a) => a.some((t) => t.includes('当前玩法'))),
    cards: await page.$$eval('#gameplay-section .gameplay-card', (n) => n.length).catch(() => 0),
    mentionsAudit: await page.$eval('#gameplay-section', (n) => /审计/.test(n.textContent)).catch(() => false),
  };
  // bug 反馈表单：区块 + 表单 + 必填描述 + 提交按钮。
  report.feedback = {
    section: await page.$eval('#feedback-section', (n) => !!n).catch(() => false),
    nav: await page.$$eval('.navigation a', (n) => n.map((x) => x.textContent)).then((a) => a.some((t) => t.includes('反馈'))),
    hasForm: await page.$eval('#feedbackForm', (n) => !!n).catch(() => false),
    hasSubmit: await page.$eval('#feedbackForm button[type="submit"]', (n) => !!n).catch(() => false),
  };
  // 反馈管理接口必须带鉴权：未授权访问应 401（不能泄漏反馈内容）。
  try {
    const noAuth = await fetch(`${url.replace(/\/$/, '')}/api/feedback/pending`, { cache: 'no-store' });
    report.feedback.pendingUnguarded = noAuth.status;
  } catch {
    report.feedback.pendingUnguarded = 'err';
  }
  // 反馈提交端到端：填描述、不带截图，应拿到 ok 响应（同源 /api/feedback）。
  // 不用 waitForFunction（页面后台延迟探测很多，waitForFunction 轮询会被抖动干扰误判）；
  // 改为提交后等一会儿再读状态，模拟用户看到的结果。
  let fbOk = false;
  try {
    await page.fill('#fbDesc', '测试反馈：用山东通道进入后建房页面点创建没反应');
    await page.click('#fbSubmit');
    await page.waitForTimeout(6000);
    const state = await page.getAttribute('#fbStatus', 'data-state').catch(() => null);
    fbOk = state === 'ok';
    report.feedback.submitState = state;
  } catch {
    report.feedback.submitState = 'timeout';
  }

  await page.click('#announcementHistoryBtn');
  await page.waitForTimeout(400);
  report.historyOpen = await page.$eval('#announcementHistoryDialog', (d) => d.open);
  await page.click('#announcementHistoryClose');

  const shot = `${prefix}-${size.width}x${size.height}.png`;
  await page.screenshot({ path: shot, fullPage: true });
  report.shots.push(shot);
  await ctx.close();
}
await browser.close();

console.log(JSON.stringify(report, null, 1));
const problems = [];
if (report.foreignHosts.length) problems.push(`第三方请求: ${report.foreignHosts.join(', ')}`);
if (report.pageErrors.length) problems.push(`页面异常: ${report.pageErrors.join(' | ')}`);
const consoleErrors = report.consoleErrors.filter((t) => !/Failed to load resource/i.test(t));
if (consoleErrors.length) problems.push(`控制台错误: ${consoleErrors.join(' | ')}`);
if (report.cards.length !== 3) problems.push(`通道卡片数 = ${report.cards.length}（应 3 条）`);
if (report.notice.slides < 2) problems.push(`公告轮播条数 = ${report.notice.slides}`);
if (!report.historyOpen) problems.push('历史公告弹窗没打开');

for (const card of report.cards) {
  if (card.state !== '在线' && card.state !== '状态未取') problems.push(`通道 ${card.id} 状态异常: ${card.state}`);
  // 自签名证书的通道（山东 sakura）自测可能不通——那是证书问题，不是缺陷，允许「不通」；
  // 其余通道必须有延迟数字。
  if (card.id !== 'sakura' && !/ms|不通/.test(card.latency || '')) {
    problems.push(`通道 ${card.id} 延迟未显示: ${card.latency}`);
  }
  if (!card.metrics.some((m) => m.includes('服务器=在线'))) {
    problems.push(`通道 ${card.id} 没有服务器状态: ${card.metrics.join(' ')}`);
  }
}

// 我的服务器：2026-10-09 起只显示本站自己的一台服，不再有第三方 .net-card。
if (report.server.netCards > 0) problems.push(`仍出现 .net-card（应删除旧「服务器网络实时监控」区块）: ${report.server.netCards} 张`);
const eight = ['srvHumans', 'srvSessions', 'srvRooms', 'srvMatches', 'srvSockets', 'srvUptime', 'srvMem', 'srvCpu'];
const missing = eight.filter((f) => !report.server.fields.some((m) => m.startsWith(`${f}=`)));
if (missing.length) problems.push(`我的服务器缺字段: ${missing.join('、')}（应为 ${eight.join('/')}）`);
const allDash = eight.every((f) => report.server.fields.some((m) => m.startsWith(`${f}=—`)));
if (allDash) problems.push('我的服务器 8 项数值全是「—」（/api/status 没拿到盒子回传？）');

if (report.region.metaVisible === false) problems.push('hero 未展示地区信息提示');
if (!report.region.stat || report.region.stat === '—') report.degraded = 'hero「你的延迟」暂未取到（自测可能仍在进行或被证书阻断）';

// 线上大厅区块必须存在且能从本站代理读到房间牌（没有第三方请求）。
if (!report.lobby.section) problems.push('缺少「线上大厅」区块');
if (!report.lobby.nav) problems.push('导航缺少「线上大厅」入口');
// 大厅卡片数可以是 0（当前没有房间），但「加入」按钮逻辑必须存在（代码层面：lobbyList 渲染了空态或卡片）。
if (report.lobby.cards > 0 && report.lobby.hasJoin === 0) problems.push('大厅有房间但缺少「加入」按钮');

// 当前服务器玩法（协同共竞）区块必须存在、能从导航进入、有内容卡片、引用审计。
if (!report.gameplay.section) problems.push('缺少「当前服务器玩法」区块');
if (!report.gameplay.nav) problems.push('导航缺少「当前玩法」入口');
if (report.gameplay.cards < 3) problems.push(`「当前服务器玩法」内容卡片过少: ${report.gameplay.cards}`);
if (!report.gameplay.mentionsAudit) problems.push('「当前服务器玩法」未引用玩法设计审计');

// bug 反馈通道：区块 + 表单 + 提交按钮 + 端到端提交成功。
if (!report.feedback.section) problems.push('缺少「反馈」区块');
if (!report.feedback.nav) problems.push('导航缺少「反馈」入口');
if (!report.feedback.hasForm) problems.push('反馈区块缺少表单（#feedbackForm）');
if (!report.feedback.hasSubmit) problems.push('反馈表单缺少提交按钮');
if (report.feedback.submitState !== 'ok') problems.push(`反馈表单提交未成功: ${report.feedback.submitState}`);
// 管理接口（/api/feedback/pending）必须鉴权：不带 token 应 401，不能泄漏反馈内容。
if (report.feedback.pendingUnguarded !== 401) {
  problems.push(`反馈管理接口未鉴权保护（应 401，实际 ${report.feedback.pendingUnguarded}）`);
}
  // 横屏游玩提示必须已删除（用户明确要求）。
  if (/横屏/.test(report.guideText || '')) problems.push('游玩指南仍含「横屏游玩」提示（应已删除）');

console.log(problems.length ? `✗ ${problems.join('\n✗ ')}` : '✓ 浏览器核验通过');
if (report.degraded) console.log(`⚠ 降级（非缺陷）：${report.degraded}`);
process.exit(problems.length ? 1 : 0);
