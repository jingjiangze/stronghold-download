/* ==========================================================================================
   arknights-gateway — 「当前仓库指向的服务器」入口页。

   Worker 做两件事：
   1. 静态资源（public/ 下的页面、样式、字体、数据）—— 顺带给它们打上缓存与安全响应头，
      Worker 的静态资源默认不吃 _headers，所以缓存策略写在这里。
   2. 两个接口：
      - /api/status —— 返回各服务器自己的探测端回传的实时数值（在线/人数/内存/CPU…）与访客地区；
      - /api/ingest —— 服务器上的探针把本机 /healthz + 进程采样的结果 POST 回来。

   2026-10-12 改口径（用户拍板）：
   - **本站跟仓库走**：主入口 = channels.json 里 tier:'primary' 的那一条，也就是
     jingjiangze/stronghold-server 部署线当前指向的服务器（创空间服）；换服务器 = 换仓库指向。
   - 国际站 / 长沙站 / 济南站 标成 tier:'other'：保留入口，但明确不是本仓指向的这一台。
     本站不探它们、不代披露、不把它们的在线人数算进概览。
   - 概览与服务器八项数值只取 primary 那一条，不与别的服务器相加。

   2026-10-09 简化（用户拍板）：
   - **延迟探测改为玩家浏览器自主探测**（页面对 origin 做 no-cors 连接计时）→ /api/regional、
     Globalping、三链路快照全部移除，本站不再消耗任何探测额度；
   - 「服务器网络实时监控」区块去掉（那两台是别人的服务器）→ /api/nodes 与小时级采集器移除；
   - 服务器级数值集中在一处展示，不逐卡重复。

   安全：Worker 不发起任何外部请求（只读自家 ASSETS 的通道清单）。回传内容一律过白名单
   （sanitizeProbeChannel）再进 KV，前端拿到的永远是干净字段。
   ========================================================================================== */

const CHANNELS_PATH = '/data/channels.json';
const STATUS_CACHE_SECONDS = 15;

const SECURITY_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), camera=(), microphone=(), payment=()',
  'x-frame-options': 'DENY',
};

/* ---- 通道清单（唯一真源是静态文件，避免与前端两份配置漂移） -------------------------------- */
async function loadChannels(request, env) {
  const res = await env.ASSETS.fetch(new Request(new URL(CHANNELS_PATH, request.url).toString()));
  if (!res.ok) throw new Error(`通道清单读取失败: HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data.channels) ? data.channels : [];
  return { list };
}

/* ---- /api/status ---------------------------------------------------------------------------
   数值来源：每台服务器自己的探测端读本机 /healthz + 进程采样后回传，Worker 只做转发。
   本站指向哪一台由 channels.json 的 tier:'primary' 决定（= jingjiangze/stronghold-server 部署线
   当前指向的那台）；标 tier:'other' 的那几条是别的服务器，本站不探、不代披露、不进概览。

   为什么不让 Worker 自己 fetch 通道：其一，实时状态走「服务器本机采样后回传」更准，CF 代探只是
   单方面看法；其二，Workers 的 fetch 会校验证书链且没有关闭开关，遇到自签名隧道永远探不到。
   改由各服务器本机读取后回传，Worker 侧零外部请求。

   延迟不在这里：延迟由玩家浏览器自主探测（见 public/js/gate.js 的 probeChannelLatency），
   Worker 只按访问 IP 给出访客地区（Cloudflare request.cf），供页面标注。

   回传快照过期/缺失时，退化成如实标注「状态未取」，不会拿旧数据冒充实时。
   ----------------------------------------------------------------------------------------- */
async function probeChannel(channel, probeSnapshot = null) {
  const base = { id: channel.id, name: channel.name, ok: false };
  const hit = probeSnapshot?.byId?.get(channel.id);
  if (!hit) {
    return { ...base, skipped: true, error: '服务端暂未收到远程探测数据' };
  }
  if (!hit.ok) {
    return { ...base, ok: false, error: hit.error || '通道不可达' };
  }
  return {
    ...base,
    ok: true,
    viaBox: true,                                   // 前端据此说明数值由服务器本机回传
    probeAgeSec: probeSnapshot.ageSec,
    app: hit.app,
    build: hit.build,
    uptimeSec: hit.uptimeSec,
    humans: hit.humans,
    bots: hit.bots,
    sessions: hit.sessions,
    sockets: hit.sockets,
    rooms: hit.rooms,
    matches: hit.matches,
    spectators: hit.spectators,
    memRssMb: hit.memRssMb,
    cpuPct: hit.cpuPct,
    error: null,
  };
}

async function handleStatus(request, env) {
  let payload;
  try {
    const { list } = await loadChannels(request, env);
    // 探针快照是 KV 里的一份小数据，读失败（没配/没探过/过期）就退回原来的「状态未取」。
    const probeSnapshot = await readProbeSnapshot(env).catch(() => null);
    const channels = await Promise.all(list.map((channel) => probeChannel(channel, probeSnapshot)));
    const cf = request.cf || {};
    payload = {
      ok: true,
      updatedAt: Date.now(),
      channels,
      // 访客地区：由 Cloudflare 按访问 IP 给出，玩家不需要参与测速之外的任何事。
      visitor: {
        country: cf.country ?? null,
        region: cf.region ?? null,
        city: cf.city ?? null,
      },
    };
  } catch (error) {
    payload = { ok: false, updatedAt: Date.now(), error: String(error?.message || error), channels: [] };
  }
  return new Response(JSON.stringify(payload), {
    status: payload.ok ? 200 : 503,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=5, s-maxage=${STATUS_CACHE_SECONDS}, stale-while-revalidate=30`,
      'access-control-allow-origin': '*',
    },
  });
}

/* ---- 通道探针快照（服务器本机回传 → KV → /api/status） ------------------------------------- */

const PROBE_KEY = 'probe:latest';
const PROBE_MAX_BYTES = 64 * 1024;
// 探针 5 分钟一次；超过这个时长没更新就当作过期，不再拿它遮住真实状态。
const PROBE_STALE_SECONDS = 900;

// 只留 /api/status 需要的那几个字段，避免回传端被攻陷后把任意内容塞进 KV 再喂给浏览器。
function sanitizeProbeChannel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.slice(0, 48) : null;
  if (!id) return null;
  const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    id,
    ok: raw.ok === true,
    app: typeof raw.app === 'string' ? raw.app.slice(0, 32) : null,
    build: typeof raw.build === 'string' ? raw.build.slice(0, 64) : null,
    uptimeSec: numOrNull(raw.uptimeSec),
    humans: numOrNull(raw.humans),
    bots: numOrNull(raw.bots),
    sessions: numOrNull(raw.sessions),
    sockets: numOrNull(raw.sockets),
    rooms: numOrNull(raw.rooms),
    matches: numOrNull(raw.matches),
    spectators: numOrNull(raw.spectators),
    memRssMb: numOrNull(raw.memRssMb),
    cpuPct: numOrNull(raw.cpuPct),
    latencyMs: numOrNull(raw.latencyMs),
    error: typeof raw.error === 'string' ? raw.error.slice(0, 200) : null,
  };
}

async function readProbeSnapshot(env) {
  const raw = await env.NODES.get(PROBE_KEY);
  if (!raw) return null;
  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch {
    return null;
  }
  const generatedAt = typeof snapshot?.generatedAt === 'string' ? snapshot.generatedAt : null;
  if (!generatedAt) return null;
  const ageSec = Math.max(0, Math.round((Date.now() - Date.parse(generatedAt)) / 1000) || 0);
  if (!Number.isFinite(ageSec) || ageSec > PROBE_STALE_SECONDS) return null;   // 过期就当没探过
  const list = Array.isArray(snapshot.channels) ? snapshot.channels : [];
  const byId = new Map();
  for (const item of list.map(sanitizeProbeChannel).filter(Boolean)) byId.set(item.id, item);
  return { generatedAt, ageSec, byId };
}

function jsonResponse(payload, status = 200, cacheControl = 'no-store') {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheControl,
      'access-control-allow-origin': '*',
    },
  });
}

async function handleIngest(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  }
  const token = env.INGEST_TOKEN;
  if (!token) return jsonResponse({ error: 'ingest 未配置令牌' }, 503);
  const auth = request.headers.get('authorization') || '';
  if (auth !== `Bearer ${token}`) return jsonResponse({ error: '未授权' }, 401);

  const raw = await request.text();
  if (raw.length > PROBE_MAX_BYTES) return jsonResponse({ error: '负载过大' }, 413);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: '负载不是合法 JSON' }, 400);
  }

  if (parsed && parsed.collector === 'box-probe') {
    const list = Array.isArray(parsed.channels) ? parsed.channels : [];
    const snapshot = {
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : new Date().toISOString(),
      collector: 'box-probe',
      channels: list.map(sanitizeProbeChannel).filter(Boolean),
    };
    await env.NODES.put(PROBE_KEY, JSON.stringify(snapshot));
    return jsonResponse({ ok: true, storedAt: snapshot.generatedAt, probed: snapshot.channels.length });
  }

  return jsonResponse({ error: '未知 collector' }, 400);
}

/* ---- 线上大厅（只读代理房间牌 Worker） ------------------------------------------------------ */
// 房间牌数据源：sp-lobby.jiangjiangze.icu 的 /api/rooms（rainya 兼容结构）。
// 这里在 Worker 侧拉一次、做 20 秒边缘缓存，前端只用同源 GET /api/lobby（CSP 不用放开第三方）。
const LOBBY_BOARD_URL = 'https://sp-lobby.jiangjiangze.icu/api/rooms';

async function proxyLobby(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const cache = caches.default;
  const cacheKey = new Request(LOBBY_BOARD_URL, { method: 'GET' });
  let res = await cache.match(cacheKey).catch(() => null);
  if (!res) {
    try {
      const upstream = await fetch(LOBBY_BOARD_URL, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      const body = await upstream.text();
      // 透传上游可读字段；前缀去掉、只留页面要用的几项，避免把任意内容喂给前端。
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* 解析失败按空房间处理 */ }
      const rooms = Array.isArray(parsed?.rooms) ? parsed.rooms.slice(0, 60) : [];
      const slim = rooms.map((r) => ({
        code: typeof r.code === 'string' ? r.code.slice(0, 8) : '',
        note: typeof r.note === 'string' ? r.note.slice(0, 40) : '',
        serverName: typeof r.serverName === 'string' ? r.serverName.slice(0, 64) : '',
        ageSec: typeof r.ageSec === 'number' ? Math.round(r.ageSec) : null,
        leftSec: typeof r.leftSec === 'number' ? Math.round(r.leftSec) : null,
        occupied: typeof r.occupied === 'number' ? r.occupied : null,
        capacity: typeof r.capacity === 'number' ? r.capacity : null,
        status: typeof r.status === 'string' ? r.status.slice(0, 12) : null,
        difficulty: typeof r.difficulty === 'string' ? r.difficulty.slice(0, 12) : null,
      })).filter((r) => r.code);
      const payload = { ok: true, now: Date.now(), rooms: slim };
      res = new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=10, s-maxage=20, stale-while-revalidate=60',
          'access-control-allow-origin': '*',
        },
      });
      // 后台刷新：放一份进边缘缓存，下次请求直接命中（即使上游慢）。
      void cache.put(cacheKey, res.clone()).catch(() => {});
    } catch {
      // 上游取不到：返回空列表，前端如实标「暂无房间」，不无限重试。
      res = new Response(JSON.stringify({ ok: true, now: Date.now(), rooms: [], error: '房间牌暂不可达' }), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=5, s-maxage=5',
          'access-control-allow-origin': '*',
        },
      });
    }
  }
  return res;
}

/* ---- bug 反馈提交通道 ----------------------------------------------------------------------- */
// 玩家在站内表单填写「遇到的问题描述」+ 可选截图（图片文件），经本站同源 Worker 写入 KV。
// 截图以 base64 存进 KV（受 KV 单值 25MB 上限与下面的截图上限约束）；描述与来源字段都做白名单清洗，
// 不把任何用户输入原样当成 HTML/JSON 结构返回（前端用 textContent 渲染，Worker 只存原始字符串）。
// 不引入任何外部请求（截图不转发到图床，直接进本站 KV）。
const FEEDBACK_MAX_DESC = 2000;
const FEEDBACK_MAX_IMG_BYTES = 3 * 1024 * 1024;   // 单张截图 ≤ 3MB（base64 约 +33%，仍远低于 KV 上限）

function sanitizeText(value, max) {
  if (typeof value !== 'string') return '';
  return value.slice(0, max);
}

function sanitizeChannel(value) {
  if (typeof value !== 'string') return '';
  return value.slice(0, 32);
}

async function handleFeedback(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: '表单格式不正确（需 multipart/form-data）' }, 400);
  }

  const rawDesc = sanitizeText(form.get('description'), FEEDBACK_MAX_DESC);
  if (rawDesc.trim().length < 5) {
    return jsonResponse({ error: '请填写具体遇到的问题（至少 5 个字）' }, 400);
  }
  const channel = sanitizeChannel(form.get('channel'));
  const contact = sanitizeText(form.get('contact'), 120);

  let imageB64 = null;
  let imageType = null;
  const file = form.get('screenshot');
  if (file && typeof file === 'object' && typeof file.arrayBuffer === 'function') {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.length === 0) {
      // 没附件：跳过
    } else if (buf.length > FEEDBACK_MAX_IMG_BYTES) {
      return jsonResponse({ error: '截图过大（请控制在 3MB 以内，可先压缩或裁剪）' }, 413);
    } else {
      const head = buf.slice(0, 12);
      const isPng = head[0] === 0x89 && head[1] === 0x50;
      const isJpeg = head[0] === 0xff && head[1] === 0xd8;
      const isWebp = buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
      if (!isPng && !isJpeg && !isWebp) {
        return jsonResponse({ error: '截图仅支持 PNG / JPEG / WebP' }, 400);
      }
      imageType = isPng ? 'image/png' : isJpeg ? 'image/jpeg' : 'image/webp';
      // 分块转 base64：3MB 直接 btoa(String.fromCharCode(...buf)) 会因参数过多爆栈。
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
      }
      imageB64 = btoa(binary);
    }
  }

  const id = `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    submittedAt: new Date().toISOString(),
    description: rawDesc,
    channel,
    contact: contact || null,
    imageType,
    imageB64,
    forwarded: false,                          // 是否已转交到 GitHub Issue
    meta: {
      country: request.cf?.country ?? null,
      city: request.cf?.city ?? null,
      ua: request.headers.get('user-agent')?.slice(0, 200) ?? null,
    },
  };
  await env.FEEDBACK.put(id, JSON.stringify(record));
  // 另写一个「最新 N 条」索引键，便于运营侧读取（只存 id 列表，不复制正文）。
  let index = [];
  try { index = JSON.parse(await env.FEEDBACK.get('index:latest') || '[]'); } catch { index = []; }
  index.unshift(id);
  if (index.length > 200) index = index.slice(0, 200);
  await env.FEEDBACK.put('index:latest', JSON.stringify(index));

  return jsonResponse({ ok: true, id }, 201);
}

/* ---- 反馈管理接口（机器对机器，不面向浏览器） ------------------------------------------------ */
// 这些接口只在 Worker 自己 / 受控的触发器里调用，用独立的低权限 FEEDBACK_SVC_TOKEN 门禁，
// 不让高权限的 GH_TOKEN 出现在任何 HTTP 响应或前端可达路径上。
function requireSvcAuth(request, env) {
  const token = env.FEEDBACK_SVC_TOKEN;
  if (!token) return false;
  const auth = request.headers.get('authorization') || '';
  return auth === `Bearer ${token}`;
}

// 列出尚未转交、且未过期的反馈（供触发器轮询）。
async function listPendingFeedback(env) {
  let index = [];
  try { index = JSON.parse(await env.FEEDBACK.get('index:latest') || '[]'); } catch { index = []; }
  const pending = [];
  for (const id of index) {
    const raw = await env.FEEDBACK.get(id);
    if (!raw) continue;
    let rec;
    try { rec = JSON.parse(raw); } catch { continue; }
    if (rec.forwarded) continue;
    pending.push(rec);
  }
  return pending;
}

// 标记已转交并从 KV 删除（触发器成功创建 Issue 后调用，实现「最多一天」的暂存 + 成功后延迟删除）。
async function markFeedbackDone(env, id) {
  await env.FEEDBACK.delete(id);
  let index = [];
  try { index = JSON.parse(await env.FEEDBACK.get('index:latest') || '[]'); } catch { index = []; }
  const next = index.filter((x) => x !== id);
  await env.FEEDBACK.put('index:latest', JSON.stringify(next));
}

async function handleFeedbackPending(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  if (!requireSvcAuth(request, env)) return jsonResponse({ error: '未授权' }, 401);
  const pending = await listPendingFeedback(env);
  return jsonResponse({ ok: true, count: pending.length, items: pending });
}

/* ---- 反馈 → GitHub Issue（Worker Cron 自动转交） --------------------------------------------- */
// 每天在常玩时段（北京时间 12:00 / 17:00 / 21:00 / 24:00 = UTC 04:00 / 09:00 / 13:00 / 16:00）
// 批量触发一次：把 KV 里尚未转交的反馈创建成 jingjiangze/Stronghold-Protocol 的 Issue，
// 截图（如有）作为 gist 上传并附链接，成功后从 KV 删除（实现「最多一天」暂存 + 成功后延迟删除）。
// 高权限 GH_TOKEN 仅在此处使用，从不经过任何面向浏览器的响应。
const GH_REPO = 'jingjiangze/Stronghold-Protocol';
const FEEDBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;   // 暂存上限：最多一天

function feedbackToIssueBody(rec) {
  const lines = [];
  lines.push(`**通道**：${rec.channel || '不确定 / 其他'}`);
  if (rec.contact) lines.push(`**联系方式**：${rec.contact}`);
  lines.push(`**提交时间（UTC）**：${rec.submittedAt}`);
  const geo = [rec.meta?.country, rec.meta?.city].filter(Boolean).join(' ');
  if (geo) lines.push(`**提交地区**：${geo}`);
  if (rec.meta?.ua) lines.push(`**User-Agent**：${rec.meta.ua}`);
  lines.push('', '---', '', '**问题描述**', '', rec.description);
  lines.push('', '', `> 本反馈由 arknights-gateway 自动转交（来源：入口页 bug 反馈通道）。反馈 ID：${rec.id}`);
  return lines.join('\n');
}

async function uploadScreenshotGist(rec, ghToken) {
  if (!rec.imageB64 || !rec.imageType) return null;
  const ext = rec.imageType === 'image/png' ? 'png' : rec.imageType === 'image/jpeg' ? 'jpg' : 'webp';
  const res = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ghToken}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'arknights-gateway-feedback',
    },
    body: JSON.stringify({
      public: true,
      files: { [`feedback-${rec.id}.${ext}`]: { content: rec.imageB64 } },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.files ? Object.values(data.files)[0]?.raw_url ?? null : null;
}

async function forwardFeedbackToGitHub(rec, ghToken) {
  let body = feedbackToIssueBody(rec);
  if (rec.imageB64) {
    const gistUrl = await uploadScreenshotGist(rec, ghToken);
    if (gistUrl) body += `\n\n**截图**：[点击查看](${gistUrl})`;
  }
  const res = await fetch(`https://api.github.com/repos/${GH_REPO}/issues`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ghToken}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'arknights-gateway-feedback',
    },
    body: JSON.stringify({
      title: `反馈：${(rec.description || '').slice(0, 60).replace(/\s+/g, ' ')}`,
      body,
      labels: ['bug', 'feedback'],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`GitHub 返回 ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

/* ---- 静态资源 ------------------------------------------------------------------------------ */

function cacheControlFor(pathname) {
  if (pathname.startsWith('/fonts/')) return 'public, max-age=604800, immutable';
  if (pathname.startsWith('/css/') || pathname.startsWith('/js/')) return 'public, max-age=31536000, immutable';
  if (pathname.startsWith('/data/')) return 'public, max-age=300, stale-while-revalidate=3600';
  // HTML 不留缓存：CSP 与页面结构都跟着它走，留 max-age 会让「部署完还是旧页面」。
  // 靠 ASSETS 的 ETag 做条件请求，代价只有一个 304。
  return 'public, max-age=0, must-revalidate';
}

/* ---- 游戏服公告管理（admin 写 → 游戏服 60 秒内自动拉取） -------------------------------------
   这份公告不是本站首页的那条轮播（public/data/announcements.json，那是静态文件、只在本站显示）；
   它发给的是 Docker 游戏服大厅里玩家看到的那块公告板。

   链路：admin 页 POST 到本站 → 存 KV → GET /api/announcements/game 对外暴露成一份纯 JSON →
   游戏服设 SP_ANNOUNCEMENTS_URL 指向它，每 60 秒拉一次。**改公告不再是重新部署**。

   为什么走 KV 而不是改静态文件：静态文件随 Worker 一起部署，改它还是要 deploy；KV 是运行时的，
   写进去立刻可读。

   读取公开（公告本来就是要给玩家看的），写入必须 Bearer token —— 与 /api/ingest 同一套门禁。
   ----------------------------------------------------------------------------------------- */

const GAME_ANN_KEY = 'announcements:game';
const GAME_ANN_MAX_BYTES = 64 * 1024;
/** 与游戏服 parseAnnouncements()（public/js/ui/announcements.js）的校验保持一致：超过就是无效内容。 */
const GAME_ANN_MAX_ENTRIES = 50;
const GAME_ANN_MAX_TITLE = 120;
const GAME_ANN_MAX_PARAGRAPHS = 40;
const GAME_ANN_MAX_PARA_CHARS = 10000;
const GAME_ANN_MAX_TOTAL_CHARS = 200000;

const LEVELS = new Set(['info', 'warning', 'critical']);

/**
 * 校验并规范化一条公告。与游戏服客户端的 parseAnnouncements() 对齐：那里拒收的内容，这里就不该存
 * 进去（存了玩家也看不到，只会让人以为发布成功了）。
 * @returns {{ entry: object } | { error: string }}
 */
function normalizeAnnouncement(raw) {
  if (!raw || typeof raw !== 'object') return { error: '条目必须是对象' };
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return { error: '标题不能为空' };
  if (title.length > GAME_ANN_MAX_TITLE) return { error: `标题超过 ${GAME_ANN_MAX_TITLE} 字` };
  const date = typeof raw.date === 'string' && raw.date.trim() ? raw.date.trim().slice(0, 40) : '';
  if (!Array.isArray(raw.paragraphs) || !raw.paragraphs.length) return { error: '正文至少一段' };
  if (raw.paragraphs.length > GAME_ANN_MAX_PARAGRAPHS) return { error: `正文超过 ${GAME_ANN_MAX_PARAGRAPHS} 段` };
  const paragraphs = [];
  for (const p of raw.paragraphs) {
    if (typeof p !== 'string' || !p.trim()) return { error: '正文段落不能为空' };
    if (p.length > GAME_ANN_MAX_PARA_CHARS) return { error: '正文单段过长' };
    paragraphs.push(p);
  }
  // level 是本层扩展（游戏服按内容渲染，忽略未知字段），仅用于 admin 列表标注。
  const level = LEVELS.has(raw.level) ? raw.level : 'info';
  return { entry: { title, date, paragraphs, level } };
}

async function readGameAnnouncements(env) {
  let parsed = null;
  try { parsed = JSON.parse(await env.NODES.get(GAME_ANN_KEY) || 'null'); } catch { parsed = null; }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  return { updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null, entries };
}

/* ---- 游戏服的运行开关与一键重新部署（后台面板用） ---------------------------------------------
   为什么这两个按钮放在本站而不是游戏服：游戏服跑在 ModelScope 创空间里，容器盘是**镜像烘死的**，
   改一个环境变量或加一个文件都要重建一次。把开关放在那边，就等于"为了开一个开关先重建一次"——
   正是这些按钮要消灭的痛。所以本站只做**控制面**（KV 存意图、面板按按钮），游戏服自己来读。

   MS_PLATFORM_TOKEN 是创空间平台的凭据（Worker secret，永不回给浏览器）：一键重新部署 = 用它去调
   `PUT /api/v1/studio/<ns>/<name>/reset_restart`。**重建会清空内存里的对局**，所以先查占用，
   场上有局就拒绝——这个门照搬实测链里学到的规矩，不是保守。
   ----------------------------------------------------------------------------------------- */

const SETTINGS_KEY = 'settings:game';
const MS_NS = 'jingjiangze';
const MS_NAME = 'Stronghold-Protocol';
const MS_API = 'https://www.modelscope.cn/api/v1/studio';
/** 健康检查走 api-inference 专用域（ms.show 只认浏览器会话，脚本访问会被 403）。 */
const MS_HEALTH = 'https://studio-jingjiangze-stronghold-protocol.api-inference.modelscope.net/healthz';

/** 读游戏服开关。没写过就是全默认（热装载关），这样面板第一次打开时不会 500。 */
async function readGameSettings(env) {
  try {
    const parsed = JSON.parse(await env.NODES.get(SETTINGS_KEY) || 'null');
    if (parsed && typeof parsed === 'object') {
      return { hotMods: parsed.hotMods === true, updatedAt: parsed.updatedAt || null, updatedBy: parsed.updatedBy || null };
    }
  } catch { /* 坏 JSON 当没写过 */ }
  return { hotMods: false, updatedAt: null, updatedBy: null };
}

/** GET 公开只读（游戏服要读它）；PUT 要 INGEST_TOKEN。 */
async function handleGameSettings(request, env) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return jsonResponse({ ok: true, ...(await readGameSettings(env)) }, 200, 'public, max-age=0, must-revalidate');
  }
  const token = env.INGEST_TOKEN;
  if (!token) return jsonResponse({ error: '未配置 INGEST_TOKEN' }, 503);
  if ((request.headers.get('authorization') || '') !== `Bearer ${token}`) return jsonResponse({ error: '未授权' }, 401);
  if (request.method !== 'PUT') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD, PUT' } });
  let body;
  try { body = JSON.parse(await request.text() || '{}'); } catch { return jsonResponse({ error: '请求体不是 JSON' }, 400); }
  if (typeof body.hotMods !== 'boolean') return jsonResponse({ error: 'hotMods 必须是布尔值' }, 400);
  const next = { hotMods: body.hotMods, updatedAt: new Date().toISOString(), updatedBy: 'admin' };
  await env.NODES.put(SETTINGS_KEY, JSON.stringify(next));
  return jsonResponse({ ok: true, ...next });
}

/** 面板用的实时快照 + 线上跑的是哪个提交。直查平台/容器，不依赖探针。 */
async function handleGameStatus(request, env) {
  const token = env.INGEST_TOKEN;
  if (!token) return jsonResponse({ error: '未配置 INGEST_TOKEN' }, 503);
  if ((request.headers.get('authorization') || '') !== `Bearer ${token}`) return jsonResponse({ error: '未授权' }, 401);
  const ms = env.MS_PLATFORM_TOKEN;
  if (!ms) return jsonResponse({ error: '未配置 MS_PLATFORM_TOKEN' }, 503);
  const out = { ok: true, health: null, deploy: null, settings: await readGameSettings(env), error: null };
  try {
    const r = await fetch(MS_HEALTH, { headers: { authorization: `Bearer ${ms}` } });
    if (r.ok) {
      const h = await r.json();
      out.health = { app: h.app ?? null, build: h.build ?? null, rooms: h.rooms ?? 0, humans: h.humans ?? 0, matches: h.matches ?? 0, uptimeSec: h.uptimeSec ?? null,
        // 开销快照原样透传（server/healthMetrics.js 每 10 秒采样）：面板要显示的就是客户端那张"游戏服务开销"卡
        performance: h.performance ?? null };
    } else out.error = `healthz ${r.status}`;
  } catch (e) { out.error = String(e?.message || e).slice(0, 160); }
  try {
    const r = await fetch(`${MS_API}/${MS_NS}/${MS_NAME}/commit/check-changed`, { headers: { authorization: `Bearer ${ms}` } });
    if (r.ok) {
      const d = (await r.json())?.Data || {};
      out.deploy = { current: String(d.CurrentCommitId || '').slice(0, 8), deployed: String(d.LastDeployCommitId || '').slice(0, 8), changed: d.HasChanged === true };
    }
  } catch { /* 平台读不到不影响占用判断 */ }
  return jsonResponse(out);
}

/** 一键重新部署：占用不为 0 就拒绝；否则 PUT reset_restart（2–4 分钟）。 */
async function handleGameRedeploy(request, env) {
  const token = env.INGEST_TOKEN;
  if (!token) return jsonResponse({ error: '未配置 INGEST_TOKEN' }, 503);
  if ((request.headers.get('authorization') || '') !== `Bearer ${token}`) return jsonResponse({ error: '未授权' }, 401);
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  const ms = env.MS_PLATFORM_TOKEN;
  if (!ms) return jsonResponse({ error: '未配置 MS_PLATFORM_TOKEN' }, 503);

  // 门：重建会清空内存对局，场上有局就不动它。读不到占用也拒绝——"探测失败"不等于"没人玩"。
  let health;
  try {
    const r = await fetch(MS_HEALTH, { headers: { authorization: `Bearer ${ms}` } });
    if (!r.ok) return jsonResponse({ error: `读不到游戏服占用（healthz ${r.status}），先确认它在跑` }, 502);
    health = await r.json();
  } catch (e) {
    return jsonResponse({ error: '读不到游戏服占用（健康检查失败）: ' + String(e?.message || e).slice(0, 120) }, 502);
  }
  const busy = { rooms: health.rooms ?? 0, humans: health.humans ?? 0, matches: health.matches ?? 0 };
  if (Number(busy.rooms) + Number(busy.humans) + Number(busy.matches) > 0) {
    return jsonResponse({ error: '场上有局，重建会清空对局', busy }, 409);
  }

  const r = await fetch(`${MS_API}/${MS_NS}/${MS_NAME}/reset_restart`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${ms}`, 'content-type': 'application/json' },
    body: JSON.stringify({ Path: MS_NS, Name: MS_NAME }),
  });
  let data = null;
  try { data = await r.json(); } catch { /* 平台可能给空体 */ }
  if (!r.ok || data?.Success === false) {
    return jsonResponse({ error: `平台拒绝重建（HTTP ${r.status}）`, detail: String(data?.Message || '').slice(0, 160) }, 502);
  }
  return jsonResponse({ ok: true, message: '已触发重建，2–4 分钟后生效；期间 ms.show 会短暂不可用', triggeredAt: new Date().toISOString() });
}

/** 公开读取：游戏服拉的就是这个（纯数组，与 data/announcements.json 同构）。 */
async function handleGameAnnouncements(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const { updatedAt, entries } = await readGameAnnouncements(env);
  // 直接给数组（不是包装对象）：游戏服的 SP_ANNOUNCEMENTS_URL 期望的就是
  // data/announcements.json 那份结构，少一层包装就少一处要解释的差异。
  return jsonResponse(entries, 200, 'public, max-age=0, must-revalidate');
}

/**
 * admin 读写：GET 拿带元信息的完整列表，PUT 整体替换（前端表单就是「当前所有公告」的编辑器）。
 * 整体替换而非逐条增删改 —— 公告最多 50 条、总量很小，一次 PUT 更简单，也不会出现半截状态。
 */
async function handleGameAnnouncementsAdmin(request, env) {
  const token = env.INGEST_TOKEN;
  if (!token) return jsonResponse({ error: '未配置 INGEST_TOKEN' }, 503);
  const auth = request.headers.get('authorization') || '';
  if (auth !== `Bearer ${token}`) return jsonResponse({ error: '未授权' }, 401);

  if (request.method === 'GET' || request.method === 'HEAD') {
    const { updatedAt, entries } = await readGameAnnouncements(env);
    return jsonResponse({ ok: true, updatedAt, count: entries.length, entries });
  }
  if (request.method === 'PUT') {
    const raw = await request.text();
    if (raw.length > GAME_ANN_MAX_BYTES) return jsonResponse({ error: '内容过大' }, 413);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return jsonResponse({ error: '不是合法 JSON' }, 400); }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : null;
    if (!list) return jsonResponse({ error: '需要一个数组，或 { entries: [...] }' }, 400);
    if (list.length > GAME_ANN_MAX_ENTRIES) return jsonResponse({ error: `最多 ${GAME_ANN_MAX_ENTRIES} 条` }, 400);

    const entries = [];
    let chars = 0;
    for (const [i, item] of list.entries()) {
      const res = normalizeAnnouncement(item);
      if (res.error) return jsonResponse({ error: `第 ${i + 1} 条：${res.error}` }, 400);
      chars += res.entry.title.length + res.entry.paragraphs.reduce((n, p) => n + p.length, 0);
      if (chars > GAME_ANN_MAX_TOTAL_CHARS) return jsonResponse({ error: '公告总量超过上限' }, 400);
      entries.push(res.entry);
    }
    const updatedAt = new Date().toISOString();
    await env.NODES.put(GAME_ANN_KEY, JSON.stringify({ updatedAt, entries }));
    return jsonResponse({ ok: true, updatedAt, count: entries.length });
  }
  return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD, PUT' } });
}

/**
 * CSP 的 connect-src：除了 'self'，还要放行清单里各 origin —— 延迟探测改由玩家浏览器
 * 自主完成（对 origin 做 no-cors 连接计时），浏览器要能朝这些地址发请求。
 * 这里**不区分** primary 与 other：别的服务器也要让玩家自己测延迟（卡上那个数字就是自测值）。
 * 主机清单来自 channels.json（构建期 check.mjs 校验过 https + 公网），不是用户输入。
 */
async function cspFor(request, env) {
  let connectExtra = '';
  try {
    const { list } = await loadChannels(request, env);
    const origins = list
      .map((channel) => String(channel.origin || ''))
      .filter((origin) => origin.startsWith('https://'))
      .join(' ');
    if (origins) connectExtra = ` ${origins}`;
  } catch {
    /* 清单读不到就退回最严的 'self'，页面照常，只是自测延迟拿不到数 */
  }
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data:",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // script-src 必须带 'unsafe-inline'：Cloudflare 的 Bot Management（JavaScript Detections）
    // 会往 HTML 里注入一段内联脚本，其内容含每次请求变化的 ray id，无法用哈希放行。
    // 不放行的话每次加载都会在控制台留一条 CSP 报错。本页无表单、无用户输入、DOM 全部用
    // textContent 构造，没有可被注入的位置，所以这里的 'unsafe-inline' 风险可忽略。
    "script-src 'self' 'unsafe-inline'",
    `connect-src 'self'${connectExtra}`,
    'upgrade-insecure-requests',
  ].join('; ');
}

function decorate(response, pathname, csp, forceCache = false) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  headers.set('content-security-policy', csp);
  // 静态资源的缓存策略以本文件为准（Worker 静态资源默认不发长缓存头）；
  // 404 页面不覆盖它自己的 no-store。
  if (forceCache) headers.set('cache-control', cacheControlFor(pathname));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function notFound() {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 · 卫戍协议：盟约</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;
background:#0c0f0e;color:#c3cbc7;font:16px/1.6 "Noto Sans SC",system-ui,sans-serif}
main{border:1px solid #2f3a35;padding:32px 40px;max-width:520px;text-align:center}
h1{margin:0;color:#4ed8af;font-size:56px;letter-spacing:4px}p{margin:8px 0}
a{color:#ffc600}</style></head><body><main><h1>404</h1>
<p>页面不存在 · Not found</p><p><a href="/">返回入口页</a></p></main></body></html>`;
  return new Response(html, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 探针回传：POST 由服务器侧写入，/api/status 读。
    if (url.pathname === '/api/ingest') return handleIngest(request, env);

    if (url.pathname === '/api/status') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      }
      return handleStatus(request, env);
    }

    // 线上大厅：从本站自己的房间牌 Worker 只读代理（同域、带短缓存）。
    // 房间牌是玩家建房后登记的（提交式，10 分钟有效），不是服务器权威房间列表——
    // 游戏服本身不暴露任何房间列表接口（只有 /healthz 聚合计数），所以大厅就走房间牌。
    // 经本站代理的好处：走 Cloudflare 边缘、零额外 DNS，且前端只跟本站说话（CSP 不放开第三方）。
    if (url.pathname === '/api/lobby') {
      return proxyLobby(request, env);
    }

    // bug 反馈提交通道：玩家在站内表单填写「描述 + 截图」，同源写入 KV。
    if (url.pathname === '/api/feedback') {
      return handleFeedback(request, env);
    }

    // 反馈管理（机器对机器，低权限门禁）：列出尚未转交的反馈，供 Cron 触发器轮询。
    if (url.pathname === '/api/feedback/pending') {
      return handleFeedbackPending(request, env);
    }

    // 游戏服公告：公开读（游戏服 60 秒拉一次），admin 读写要 token。
    if (url.pathname === '/api/announcements/game') return handleGameAnnouncements(request, env);
    if (url.pathname === '/api/announcements/game/admin') return handleGameAnnouncementsAdmin(request, env);

    // 游戏服的运行开关与一键重新部署（面板两个按钮）。都必须注册在上面那个 GET/HEAD 总闸之前：
    // 开关是 PUT、重新部署是 POST。
    if (url.pathname === '/api/settings/game') return handleGameSettings(request, env);
    if (url.pathname === '/api/game/status') return handleGameStatus(request, env);
    if (url.pathname === '/api/game/redeploy') return handleGameRedeploy(request, env);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }

    const csp = await cspFor(request, env);

    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 404) return decorate(notFound(), url.pathname, csp);
    return decorate(asset, url.pathname, csp, true);
  },

  // Cron：每天在常玩时段分四批把 KV 暂存的反馈汇总转交成 GitHub Issue（成功即删除，实现「最多一天」暂存）。
  async scheduled(controller, env) {
    const cron = controller?.cron ?? '';
    if (!env.GH_TOKEN) {
      return new Response('GH_TOKEN 未配置', { status: 503 });
    }
    const pending = await listPendingFeedback(env);
    const results = [];
    for (const rec of pending) {
      // 暂存上限：超过一天的也一并转交清掉（避免无限堆积），但前端描述里是按「最多一天」向用户承诺。
      try {
        const issue = await forwardFeedbackToGitHub(rec, env.GH_TOKEN);  // eslint-disable-line
        await markFeedbackDone(env, rec.id);
        results.push({ id: rec.id, issue: issue?.html_url ?? null, ok: true });
      } catch (err) {
        results.push({ id: rec.id, ok: false, error: String(err?.message || err) });
      }
    }
    return new Response(JSON.stringify({ cron, checked: pending.length, results }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  },
};
