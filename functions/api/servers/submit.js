// Pages Function: POST /api/servers/submit
// 访客提交入口。**校验有效就当场上线，不再等维护者点「通过」**（2026-10-05 用户定的）：
// 服务端要连过两道 —— 健康端点指纹（是不是卫戍协议服务器）与清单那条入口地址本身
// （玩家真会点开的链接），两道都过才追加进签名清单并立刻发布；签名用 Pages secret
// SP_SIGN_KEY 在这边算，且签完立刻用 SP_PUB_KEY 自校验，配错密钥宁可不发。
// 以下情况退回暂存区，由维护者在 /api/servers/review 处置：
//   ① 边缘**看不见**这台服务器（CF 52x 自签证书、防火墙 403、超时、候选路径全 404）——
//      这类标 needsReview:true，附访客浏览器证据，提示"会复核"，不再当场拒收；
//   ② 带 x-admin-key 的投递链（scout）—— 边缘失败靠维护者担保；
//   ③ 该 IP 一小时内自动上线已超 3 条 / 进暂存区已超 5 条（防刷屏）；
//   ④ 没配签名密钥或写清单时撞上并发（不硬盖别人的发布）。
// 只有"边缘**亲眼看见它不是**卫戍协议服务器"（读到 JSON 但 ok 不是 true / 缺协议字段）
// 才当场拒收 —— 且这种如果访客浏览器给出了完整指纹，也照样进暂存区让维护者判。
//
// 队列存储：KV namespace SERVER_REVIEW（wrangler.toml 里绑定）
//   pending/<id>   → 提交记录
//   pending_index  → 待审 id 数组（读-改-写）

import { checkEntryUrl, listCollision, looksLikeClientPage, normalizeTarget, probeKey, readProbeReports, rememberRecheck, sanitizeBrowserVerify, validateEntries, verifyServerHealth } from '../_verify.js';
import { canSign, publishServersDoc, readPublishLog, recentPublishes, signServersDoc } from '../_publish.js';

const MAX_PENDING = 100;
// 匿名提交现在直接进签名清单，所以给每个 IP 一个刷屏上限：一小时内最多自动上线 3 条，
// 超出就退回队列（维护者仍在，只是不再是必经步骤）。
const AUTO_PER_IP = 3;
const AUTO_WINDOW_MS = 60 * 60 * 1000;
// 暂存区额度：边缘"看不见"的提交现在不再被当场拒收，而是带证据入队等复核，
// 所以同一 IP 每小时能送进暂存区的条数也要有个闸（和自动上线分开算，免得互相挤）。
const QUEUE_PER_IP = 5;


function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

async function readIndex(env) {
  const raw = await env.SERVER_REVIEW.get('pending_index');
  const list = raw ? JSON.parse(raw) : [];
  return Array.isArray(list) ? list : [];
}

/** 排序/门禁用的可选字段，允许访客提交，非法值直接忽略。 */
function pickExtras(raw, isAdmin) {
  const out = {};
  if (Number.isInteger(raw.tier) && raw.tier >= 0 && raw.tier <= 100) out.tier = raw.tier;
  if (Number.isInteger(raw.weight) && raw.weight >= 0 && raw.weight <= 1000) out.weight = raw.weight;
  if (Number.isInteger(raw.protocol) && raw.protocol >= 0) out.protocol = raw.protocol;
  if (typeof raw.app === 'string' && raw.app.trim()) out.app = raw.app.trim().slice(0, 32);
  // direct_cn 只认出示管理口令的提交者：它是「绕过边缘指纹」的通行证，
  // 若匿名访客也能带，就等于任何人都能往签名清单里塞一台没被核实过的服务器。
  if (isAdmin && raw.direct_cn === true) { out.direct_cn = true; out.attested_by = 'maintainer'; }
  return out;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.SERVER_REVIEW || !env.R2BUCKET) return json({ ok: false, error: '提交队列未配置' }, 500);

  let doc;
  try { doc = await request.json(); } catch { return json({ ok: false, error: '请求不是有效 JSON' }, 400); }

  const rawEntry = Array.isArray(doc && doc.servers) ? doc.servers[0] : null;
  if (!rawEntry) return json({ ok: false, error: 'servers[] 里需要恰好一条待提交记录' }, 400);
  // 出示管理口令的提交者（本机工具、以及带 PUBLISH_KEY 的 scout 投递链）走的是维护者通道
  const isAdmin = !!env.PUBLISH_KEY && (request.headers.get('x-admin-key') || '') === env.PUBLISH_KEY;
  const checked = validateEntries([{ ...rawEntry, enabled: true }]);
  if (checked.error) return json({ ok: false, error: checked.error }, 400);
  // validateEntries 会原样保留 direct_cn（清单 PUT 路径要靠它），所以这里必须按身份剥掉：
  // 不剥的话匿名提交直接绕过 x-admin-key 闸门。
  if (!isAdmin) delete checked.servers[0].direct_cn;
  const entry = { ...checked.servers[0], ...pickExtras(rawEntry, isAdmin) };

  // 服务端身份校验：按候选路径逐个打（`/healthz`、`/api/status`、`/api/health`、`/health`），
  // 第一个合法指纹就停。提交路径给 12s：国内主机从边缘 PoP 过去常常 5s 内握不上手，
  // 那不等于"不是卫戍服务器"。
  // 访客**没填**探针时不能沿用 validateEntries 的 '/healthz' 默认值去打 —— 那样多候选路径
  // 永远轮不到，挂在 /api/status 上的服会被当成"不是卫戍协议"（rainya 就是这么漏进来的）。
  const rawProbe = typeof rawEntry.probe === 'string' ? rawEntry.probe.trim() : '';
  const verdict = await verifyServerHealth(entry.url, rawProbe || null, 12000);
  // 命中哪条路径要存进条目：以后每轮校验只敲那一条，不再四扇门都敲一遍。
  if (verdict.ok && verdict.probePath) entry.probe = verdict.probePath;
  // 访客浏览器带来的第二手证据（见 js/servers.js 的 browserVerify）：**只当复核材料，
  // 绝不作为放行依据** —— 那玩意儿任何人都能伪造，而它恰恰是唯一能穿过"证书警告 + 继续访问"
  // 这条路径的观察点（dx.frp-gap.com 就是源站证书 CF 验不过、玩家自己进得去）。
  const browserVerify = sanitizeBrowserVerify(doc.browserVerify);
  // 出示管理口令的提交者（本机工具、带 PUBLISH_KEY 的 scout 投递链）本身就是验活通道之一：
  // 它们只在别的出口跑过指纹之后才投，边缘 403/超时不算否决 —— 直接补上 direct_cn，
  // 让后续 verify 也按"越过边缘探测"处理。
  // 第三路探针：证书旁路（GitHub Runner / 本机盒子）读到的完整协议指纹。
  // 它补的正是 CF 补不了的那一块 —— 自签源站在边缘永远只能拿到 525/526，而这一路能真的
  // 读到 { ok:true, version, rooms, humans … }。**只补"看不见"，不翻"看见不是"**：
  // 边缘读出过一份不是卫戍协议的 JSON 时，探针结论与它矛盾，那种仍然进暂存区让人判。
  const reports = verdict.ok ? {} : await readProbeReports(env);
  const report = verdict.ok ? null : (reports[probeKey(entry.url)] || null);
  // 只有"看不见"能被探针补上；边缘**看见它不是**卫戍协议时，探针结论与它矛盾，那种进暂存区让人判
  const probeBacked = !!report && verdict.verdict === 'inconclusive' && report.entryOk !== false;
  if (probeBacked) {
    entry.direct_cn = true;                    // 越过边缘探测的通行证，来源写死在 attested_by 里
    entry.attested_by = 'tls-probe';
    if (report.probePath) entry.probe = report.probePath;
  }
  if (!verdict.ok && !isAdmin && verdict.verdict === 'negative' && !browserVerify && !report) {
    // 只有"我们**看见它不是**卫戍协议服务器"（200 + JSON 但缺协议字段）才当场拒收；
    // 52x/403/超时/TLS/路径 404 这些"看不见"的不再把报料丢掉 —— 带着证据进暂存区等复核。
    return json({ ok: false, error: `校验失败：${verdict.error}` }, 400);
  }
  if (!verdict.ok && isAdmin) {
    // 带口令的投递链本身就是一条验活通道：它们只在别的出口跑过指纹之后才投。
    entry.direct_cn = true; entry.attested_by = 'maintainer';
  }
  // 匿名 + 边缘看不见：**不打 direct_cn**（那是担保放行的通行证，只有维护者能给），
  // 只是入队，由维护者带着两边证据判断。

  // 第二道闸：清单里那条入口地址（玩家真正会点的）自己也得打得开。
  // game.rainya.me 就是靠这个漏进来的：/api/status 一直 200 而 /play 是 502。
  // 这一道没过**不再当场拒收**：健康端点是好的、只是入口路径挂了，这种最值得维护者去看一眼，
  // 所以带着证据进暂存区（自动上线分支要求 gate.ok === true，自然不会误发）。
  const gate = verdict.ok ? await checkEntryUrl(entry.url) : { ok: true };

  // 条目 id 要稳（客户端拿它当 occupancy 键），又要防撞：访客没给就生成一个，
  // 不能让 validateEntries 的 `srv-0` 兜底值进清单 —— 那会和下一条撞键。
  if (!String(rawEntry.id || '').trim()) {
    const rnd = new Uint8Array(4);
    crypto.getRandomValues(rnd);
    entry.id = Date.now().toString(36) + Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const index = await readIndex(env);
  if (index.length >= MAX_PENDING) return json({ ok: false, error: '待审核队列已满，请稍后再试' }, 429);

  const liveRes = await env.R2BUCKET.get('site/servers.json');
  let liveDoc = null;
  if (liveRes) { try { liveDoc = JSON.parse(await liveRes.text()); } catch { /* 现网坏了就只入队 */ } }
  const servers = liveDoc && Array.isArray(liveDoc.servers) ? liveDoc.servers : [];
  // 「同一台已经在清单里，但清单存的是裸根地址」不当成重复，而是一次**入口升级**：
  // 挖掘侧的挂载点表覆盖不了玩家自定的文件名（/play.html 就是），直接 409 会把纠正永久堵死
  // —— 名单里那条链接点不开客户端，而报上来的人只会被告知"已存在"。
  // 门槛比新增条目更严：健康端点指纹 + 新地址真打得开 + 那页**看着像客户端本体**
  // （不然后续任何人都能把某台服的条目改成同 host 下任意能打开的路径，比如 /healthz）
  // + 当场签名自校验通过才改。匿名还额外吃每 IP 额度。
  const collide = listCollision(servers, entry.url);
  if (collide.kind === 'upgrade') {
    const dupIdx = collide.index;
    const existing = servers[dupIdx];
    const upgradeIp = clientIp(request);
    const clientPage = await looksLikeClientPage(entry.url);
    const why = !verdict.ok ? '新地址没通过健康校验'
      : gate.ok !== true ? '新地址打不开'
      : !clientPage && !isAdmin ? '新地址不像游戏客户端页面（不拿状态页/接口路径换掉入口）'
      : !canSign(env) ? '服务端签名未配置'
      : (await recentPublishes(env, upgradeIp, AUTO_WINDOW_MS)) >= AUTO_PER_IP ? '本机自动上线额度已用完' : '';
    if (why) {
      return json({ ok: false, error: `该服务器已在公共清单中（存的是 ${existing.url}；这次没能改成你给的地址：${why}）` }, 409);
    }
    const signed = await signServersDoc({ ...liveDoc,
      servers: servers.map((s, i) => (i === dupIdx ? { ...s, url: entry.url } : s)) }, env);
    const out = signed && await publishServersDoc(env, signed, {
      baseUpdated: liveDoc && liveDoc.updated, via: 'auto-submit', entryId: existing.id, entryUrl: entry.url,
      ip: upgradeIp, ua: request.headers.get('user-agent'), country: (request.cf && request.cf.country) || null,
    });
    if (out && out.ok) {
      return json({ ok: true, published: true, upgraded: true, id: existing.id, from: existing.url, to: entry.url,
        count: out.count, hint: '同一台服务器，清单里那条裸根地址已升级成你给的完整地址（没有新增条目）' });
    }
    return json({ ok: false, error: '该服务器已在公共清单中，且清单刚刚被别人改过（乐观并发挡住，没硬盖）' }, 409);
  }
  if (collide.kind === 'duplicate') {
    // 一台 host 只留一条：路径相同、清单里已经是更深的路径、或两边是不同子路径，都算同一家服
    return json({ ok: false, error: `该服务器已在公共清单中（${servers[collide.index].url}；同一个 host 只留一条，不同子路径也算同一台）` }, 409);
  }
  const pending = [];
  for (const raw of await Promise.all(index.map((id) => env.SERVER_REVIEW.get(`pending/${id}`)))) {
    if (!raw) continue;
    try { pending.push(JSON.parse(raw)); } catch { /* 坏记录跳过：它已经不在能读的范围里了 */ }
  }
  const canPublishNow = (verdict.ok && gate.ok === true) || probeBacked;
  for (const record of pending) {
    if (listCollision([{ url: record.url }], entry.url).kind === 'none') continue;
    // 队列里已经躺着同一条：现在这条**能直接上线**（边缘过了，或证书旁路探针读到了指纹），
    // 就用新证据顶掉旧的那条待审记录。否则玩家重投只会吃一句"已在队列中"，
    // 探针确认了也上不了线 —— 报料人没有义务回来第二次。
    if (canPublishNow && !isAdmin) {
      const drop = index.indexOf(record.id);
      if (drop >= 0) index.splice(drop, 1);
      await env.SERVER_REVIEW.delete(`pending/${record.id}`);
      await env.SERVER_REVIEW.put('pending_index', JSON.stringify(index));
      continue;
    }
    return json({ ok: false, error: '该服务器已在待审核队列中' }, 409);
  }
  const ip = clientIp(request);
  // 暂存区也会被打爆：边缘"看不见"的条目现在一律入队，所以给同一个 IP 一个每小时额度。
  // 直接数内存里已有的队列记录，不再另开存储 —— 队列本身就在 KV 里，写一次就够。
  const since = Date.now() - AUTO_WINDOW_MS;
  if (!isAdmin && pending.filter((r) => r.submittedBy === ip
      && Date.parse(r.submittedAt || '') >= since).length >= QUEUE_PER_IP) {
    return json({ ok: false, error: `本机一小时内送进暂存区的条数已达上限（${QUEUE_PER_IP} 条），请等一会儿再提交` }, 429);
  }
  // 上线的两条正当路径：① 边缘两道闸都过；② 边缘"看不见"但证书旁路探针拿到了完整协议指纹。
  // 两条都还要配着签名密钥、且本 IP 额度没用完。
  if (!isAdmin && canSign(env) && ((verdict.ok && gate.ok === true) || probeBacked)
      && (await recentPublishes(env, ip, AUTO_WINDOW_MS)) < AUTO_PER_IP) {
    const signed = await signServersDoc({ ...liveDoc, servers: servers.concat([entry]) }, env);
    if (signed) {
      const out = await publishServersDoc(env, signed, {
        baseUpdated: liveDoc && liveDoc.updated, via: 'auto-submit',
        entryId: entry.id, entryUrl: entry.url, ip,
        ua: request.headers.get('user-agent'), country: (request.cf && request.cf.country) || null,
      });
      if (out.ok) {
        return json({ ok: true, published: true, id: entry.id, count: out.count,
                      hint: probeBacked
                        ? `边缘被源站证书挡住（${verdict.error}），但证书旁路探针在 ${report.probePath || entry.probe} 读到完整协议指纹`
                          + `（${report.fingerprint.app || 'version ' + report.fingerprint.version}），已当场上线并标记 attested_by:tls-probe；后台每 30 分钟复查`
                        : '校验通过，已当场上线；后台校验每 30 分钟复查一次，入口或后端坏了会自动隐藏' });
      }
      // out.conflict：期间有人改过清单。不硬盖，退回队列让维护者看见最新状态。
    }
  }

  // 队列 id 要的是唯一性（它同时是审核键），不是保密；仍用 CSPRNG 而不是 Math.random。
  const random = new Uint8Array(4);
  crypto.getRandomValues(random);
  const queueId = Date.now().toString(36) + Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('');
  // 复核说明：把"为什么没能当场上线"翻成维护者一眼能判的话
  let reviewReason = '';
  if (verdict.ok && gate.ok === false) reviewReason = `入口地址打不开：${gate.error}`;
  else if (!verdict.ok && verdict.verdict === 'negative') reviewReason = `边缘确认它不像卫戍协议服务器：${verdict.error}（与访客浏览器证据冲突，需人工判）`;
  else if (!verdict.ok) reviewReason = `边缘探测看不见这台服务器：${verdict.error}`;
  // 有证书旁路探针的指纹却没当场发布，只可能是额度/并发/没配签名密钥 —— 说清楚，
  // 维护者看见这行就知道点「通过」不需要犹豫。
  if (report) reviewReason += `；证书旁路探针已在 ${report.probePath || '候选路径'} 读到完整协议指纹（${report.source}，${report.ageMin} 分钟前）`;

  const record = {
    // 先放队列键再展开：访客自带的 entry.id 不允许覆盖审核键。
    ...entry,
    id: queueId,
    submittedAt: new Date().toISOString(),
    submittedBy: ip,
    // 边缘探测结果原样入档：direct_cn 条目这里可能是 ok:false，审核时得看得见"是维护者担保的"
    verify: {
      ok: !!verdict.ok,
      verdict: verdict.ok ? 'pass' : (verdict.verdict || 'inconclusive'),
      variant: verdict.variant || null,
      rooms: verdict.rooms ?? null,
      humans: verdict.humans ?? null,
      probePath: verdict.probePath || null,
      error: verdict.ok ? undefined : verdict.error,
      at: new Date().toISOString(),
    },
    // 访客浏览器第二手证据：只供复核，**不参与放行**（任何人都能伪造它，见 sanitizeBrowserVerify）
    browserVerify: browserVerify || null,
    // 证书旁路探针的报告（我们自己那一链写的，见 site/probes.json）：有它维护者点「通过」就够，不用 force
    tlsProbe: report || null,
    // 暂存区标记：true = "边缘看不见它"，需要维护者带证据判；false = 额度满或并发冲突，
    // 校验本身是过的，点「通过」没有风险。
    needsReview: !verdict.ok || gate.ok === false,
    reviewReason: reviewReason || null,
    // 复核时要不要沿用访客填的那条路径：只有他**自己填过**才锁定，否则交给多候选逐个试
    // （validateEntries 的 '/healthz' 默认值不能当成"访客的指定"）。
    probeFromVisitor: !!rawProbe,
    attestedBy: isAdmin ? 'maintainer' : null,
  };
  await env.SERVER_REVIEW.put(`pending/${queueId}`, JSON.stringify(record));
  index.push(queueId);
  await env.SERVER_REVIEW.put('pending_index', JSON.stringify(index));
  // 登记给证书旁路探针：条目不在签名清单里，verify 轮永远不会再去敲它，所以要把地址写进
  // 公开的 site/recheck.json —— GitHub 那一链只拿 R2 的读写钥匙，不需要管理口令。
  if (record.needsReview) await rememberRecheck(env, entry.url, rawProbe || entry.probe);

  const edgeView = verdict.ok
    ? `边缘校验已通过（${verdict.probePath || entry.probe}，${verdict.variant || '未知'} 版）`
    : `边缘校验未通过：${verdict.error}`;
  const browserView = browserVerify
    ? `；访客浏览器侧证据：${browserVerify.level === 'protocol' ? '读到完整指纹' : '能连通'}${browserVerify.fingerprint && browserVerify.fingerprint.app ? '（' + browserVerify.fingerprint.app + '）' : ''}`
    : '';
  return json({
    ok: true,
    queued: true,
    review: record.needsReview,
    id: queueId,
    queuePosition: index.length,
    reason: reviewReason || null,
    hint: record.needsReview
      ? `已进暂存区，标注「需要复核」（${edgeView}${browserView}）。边缘看不见 ≠ 不是服务器：`
        + '自签证书、防火墙、探针路径自定义都会造成这种"看不见"，维护者会带两边证据判定后再上线。'
      : '已进入待审核队列（担保提交、本 IP 额度已满、或清单正在并发更新），维护者点「通过」即上线',
  });
}

export async function onRequestGet(context) {
  // 维护者视角看队列（密钥只能走 header，不进 URL）
  const key = context.request.headers.get('x-admin-key') || '';
  if (!context.env.PUBLISH_KEY || key !== context.env.PUBLISH_KEY) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  const env = context.env;
  const index = await readIndex(env);
  const records = (await Promise.all(index.map((id) => env.SERVER_REVIEW.get(`pending/${id}`))))
    .filter(Boolean).map((raw) => JSON.parse(raw));
  // 证书旁路探针每 15 分钟一轮，比队列记录新 —— 每次读队列都现取一份最新报告贴上，
  // 维护者看到"探针已确认"就该直接点通过，不需要 force 担保。
  const reports = await readProbeReports(env);
  for (const record of records) {
    const hit = reports[probeKey(record.url)];
    if (hit) record.tlsProbe = hit;
  }
  // 匿名上线已不再经过队列，所以顺手给出发布审计里最近 20 条 auto-submit：
  // 维护者要查"今天都有谁往清单里塞了什么"只需要这一个接口
  const autoPublished = await readPublishLog(env, 20, 'auto-submit');
  return json({ ok: true, pending: records, autoPublished, quotaPerIpPerHour: AUTO_PER_IP });
}
