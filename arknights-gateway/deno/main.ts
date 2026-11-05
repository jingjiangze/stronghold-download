/* ==========================================================================================
   arknights-gateway — 「当前仓库指向的服务器」入口页 · Deno Deploy 版

   2026-10-13 从 Cloudflare Worker 移植（原实现保留在 src/index.js 作对照）。逐项对应关系：
   - 运行时：Deno Deploy（`Deno.serve`）；静态资源从部署包内 public/ 直接读文件
     （原 CF 版是 ASSETS 绑定 + run_worker_first）。
   - 存储：Deno KV（原 NODES / FEEDBACK 两套命名空间合并为一个 KV，用键前缀区分）。
     注意 Deno KV 单值上限 64KiB：反馈截图（base64 最大约 4MB）按 48KB 分块存。
   - 定时任务：Deno.cron 取代 wrangler triggers.crons（每天 4 次转交反馈到 GitHub Issue）。
   - 访客地区：读 Cloudflare 注入的 cf-ipcountry / cf-region / cf-ipcity 头
     （本站前面仍是 CF 边缘·橙色云；直连 deno.net 默认域时这些头为空）。
   - 出网 fetch、白名单清洗、CSP、缓存头策略与 CF 版逐条对齐。

   路由与行为约定（与 CF 版一致）：
     /api/status、/api/ingest、/api/lobby、/api/feedback、/api/feedback/pending、
     /api/announcements/game(+ /admin)、/api/settings/game、/api/game/status、/api/game/redeploy，
     其余 GET/HEAD 走静态资源，非 GET/HEAD 一律 405。
   ========================================================================================== */

/* ==========================================================================================
   实例身份（2026-10-13）：
   同一份代码跑两个实例 —— 「创空间服」与「盒子服」，域名相同、对外形状一致，
   但 /api/status 读的数据源不同，后台页顶部显示各自的实例名与数据源，避免误操作。

     INSTANCE_ID     实例标识，只影响展示（如 'ms-studio' / 'box'）
     INSTANCE_LABEL  后台页显示的中文名（如 '魔搭创空间服' / '盒子服'）
     HEALTHZ_URL     该实例 /api/status 的数据源：
                       A（创空间）= https://studio-….api-inference.modelscope.net/healthz
                       B（盒子）  = http://127.0.0.1:3000/healthz
     MS_PLATFORM_TOKEN 只有 A 需要（控制面/一键重建）；B 留空即可，
                       /api/game/* 会返回 503 而不是乱动别的服务。
   ========================================================================================== */
const INSTANCE_ID = Deno.env.get('INSTANCE_ID') || 'ms-studio';
const INSTANCE_LABEL = Deno.env.get('INSTANCE_LABEL') || '魔搭创空间服';
// 注意：这里不能引用下方才定义的 MS_HEALTH 常量（TDZ），默认值直接写字面量。
const HEALTHZ_URL = Deno.env.get('HEALTHZ_URL') ||
  'https://studio-jingjiangze-stronghold-protocol.api-inference.modelscope.net/healthz';

const kv = await Deno.openKv();

const STATUS_CACHE_SECONDS = 15;

const SECURITY_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), camera=(), microphone=(), payment=()',
  'x-frame-options': 'DENY',
};

/* ---- 键空间（原为两个 KV 命名空间，现值统一进一个 Deno KV） -------------------------------- */
const KEY_PROBE = ['probe', 'latest'] as const;
const KEY_ANN = ['announce', 'game'] as const;
const KEY_SETTINGS = ['settings', 'game'] as const;
const KEY_FB_INDEX = ['feedback-index', 'latest'] as const;

/* ---- 静态资源（部署包内 public/，等价原 ASSETS 绑定） ---------------------------------------- */
const PUBLIC_BASE = new URL('./public/', import.meta.url);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function contentTypeFor(pathname: string): string {
  const i = pathname.lastIndexOf('.');
  const ext = i >= 0 ? pathname.slice(i).toLowerCase() : '';
  return MIME[ext] ?? 'application/octet-stream';
}

function cacheControlFor(pathname: string): string {
  if (pathname.startsWith('/fonts/')) return 'public, max-age=604800, immutable';
  if (pathname.startsWith('/css/') || pathname.startsWith('/js/')) return 'public, max-age=31536000, immutable';
  if (pathname.startsWith('/data/')) return 'public, max-age=300, stale-while-revalidate=3600';
  // HTML 不留缓存：CSP 与页面结构都跟着它走，留 max-age 会让「部署完还是旧页面」。
  return 'public, max-age=0, must-revalidate';
}

async function readPublic(pathname: string): Promise<Uint8Array | null> {
  if (!/^\/[A-Za-z0-9._\-\/]*$/.test(pathname) || pathname.includes('..')) return null;
  try {
    return await Deno.readFile(new URL('.' + pathname, PUBLIC_BASE));
  } catch {
    return null;
  }
}

async function serveStatic(pathname: string): Promise<Response | null> {
  let p = pathname;
  if (p.endsWith('/')) p += 'index.html';
  let data = await readPublic(p);
  if (!data) {
    // 无扩展名的路径（如 /admin）回退到同名 .html —— 后台页就是靠这条命中的。
    if (!/\.[A-Za-z0-9]+$/.test(p)) {
      const withHtml = p + '.html';
      data = await readPublic(withHtml);
      if (data) p = withHtml;
    }
  }
  if (!data) return null;
  return new Response(data as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': contentTypeFor(p),
      'cache-control': cacheControlFor(p),
    },
  });
}

/* ---- 通道清单（唯一真源是静态文件，避免与前端两份配置漂移） -------------------------------- */
async function loadChannels(): Promise<{ list: Record<string, unknown>[] }> {
  const raw = await readPublic('/data/channels.json');
  if (!raw) throw new Error('通道清单读取失败');
  const data = JSON.parse(new TextDecoder().decode(raw));
  const list = Array.isArray(data.channels) ? data.channels : [];
  return { list };
}

/* ---- 公共小工具 -------------------------------------------------------------------------- */
function jsonResponse(payload: unknown, status = 200, cacheControl = 'no-store'): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheControl,
      'access-control-allow-origin': '*',
    },
  });
}

/** CF（橙色云）注入的访客地区头；直连 deno.net 时为空。 */
function visitorFrom(request: Request) {
  const h = request.headers;
  return {
    country: h.get('cf-ipcountry') ?? null,
    region: h.get('cf-region') ?? null,
    city: h.get('cf-ipcity') ?? null,
  };
}

/* ---- /api/status -------------------------------------------------------------------------
   本实例只报「自己这台服务器」的状态：primary 通道的数值直接来自本实例的 HEALTHZ_URL
   （创空间实例读创空间、盒子实例读本机 3000）——零出网探测、零额度消耗。
   tier:'other' 的通道是别的服务器，本站不探它们（如实标注，不冒充成离线故障）。
   读不到就如实标「读不到服务器状态」，不拿旧数据冒充。 */
function buildChannel(channel: Record<string, any>, health: any) {
  const base = { id: channel.id, name: channel.name, ok: false };
  if (channel.tier !== 'primary') {
    return { ...base, skipped: true, error: '别的服务器：本站不探它' };
  }
  if (!health) {
    return { ...base, error: '读不到服务器状态（healthz 不可达）' };
  }
  return {
    ...base,
    ok: true,
    viaBox: false,
    probeAgeSec: 0,
    app: health.app ?? null,
    build: health.build ?? null,
    uptimeSec: health.uptimeSec ?? null,
    humans: health.humans ?? null,
    bots: health.bots ?? null,
    sessions: health.sessions ?? null,
    sockets: health.sockets ?? null,
    rooms: health.rooms ?? null,
    matches: health.matches ?? null,
    spectators: health.spectators ?? null,
    memRssMb: health.memRssMb ?? null,
    cpuPct: health.cpuPct ?? null,
    error: null,
  };
}

/* ---- 本实例的数据源快照（供 /api/status 使用） ----------------------------------------------
   盒子实例：直接读本机游戏服 127.0.0.1:3000/healthz（零出网、零额度、最准）。
   创空间实例：读创空间 api-inference 域的 healthz。
   两者都由 HEALTHZ_URL 决定；读不到就如实返回 ok:false，不拿旧数据冒充。 */
async function readLocalHealth(): Promise<any | null> {
  try {
    // 创空间的 healthz 匿名返回 401，必须带 MS_PLATFORM_TOKEN；
    // 盒子实例读本机 127.0.0.1:3000/healthz 不需要（也没配）令牌，带上是无害的。
    const ms = Deno.env.get('MS_PLATFORM_TOKEN');
    const headers: Record<string, string> = ms ? { authorization: `Bearer ${ms}` } : {};
    const r = await fetch(HEALTHZ_URL, { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function handleStatus(request: Request): Promise<Response> {
  let payload;
  try {
    const { list } = await loadChannels();
    const health = await readLocalHealth();
    const channels = list.map((channel) => buildChannel(channel, health));
    payload = {
      ok: true,
      updatedAt: Date.now(),
      channels,
      // 本实例是谁、数据从哪来 —— 前端与后台据此区分两个实例
      instance: {
        id: INSTANCE_ID,
        label: INSTANCE_LABEL,
        healthzUrl: HEALTHZ_URL,
        app: health?.app ?? null,
        build: health?.build ?? null,
      },
      visitor: visitorFrom(request),
    };
  } catch (error) {
    payload = { ok: false, updatedAt: Date.now(), error: String((error as Error)?.message || error), channels: [] };
  }
  return new Response(JSON.stringify(payload), {
    status: (payload as any).ok ? 200 : 503,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=5, s-maxage=${STATUS_CACHE_SECONDS}, stale-while-revalidate=30`,
      'access-control-allow-origin': '*',
    },
  });
}

/** 实例自述：探活 + 身份（隧道/监控用，也用于确认你访问的是哪个实例）。 */
async function handleHealthz(): Promise<Response> {
  const health = await readLocalHealth();
  return jsonResponse({
    ok: true,
    service: 'arknights-gateway',
    instance: { id: INSTANCE_ID, label: INSTANCE_LABEL, healthzUrl: HEALTHZ_URL },
    target: health ? { app: health.app ?? null, build: health.build ?? null } : null,
  }, 200, 'no-store');
}

/* ---- 通道探针快照（服务器本机回传 → KV → /api/status） ------------------------------------- */

const PROBE_MAX_BYTES = 64 * 1024;
const PROBE_STALE_SECONDS = 900;

function sanitizeProbeChannel(raw: any) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.slice(0, 48) : null;
  if (!id) return null;
  const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
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

async function readProbeSnapshot() {
  const entry = await kv.get<string>(KEY_PROBE as unknown as Deno.KvKey);
  const raw = entry.value;
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
  if (!Number.isFinite(ageSec) || ageSec > PROBE_STALE_SECONDS) return null;
  const list = Array.isArray(snapshot.channels) ? snapshot.channels : [];
  const byId = new Map<string, any>();
  for (const item of list.map(sanitizeProbeChannel).filter(Boolean)) byId.set(item.id, item);
  return { generatedAt, ageSec, byId };
}

async function handleIngest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  }
  const token = Deno.env.get('INGEST_TOKEN');
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
    await kv.set(KEY_PROBE as unknown as Deno.KvKey, JSON.stringify(snapshot));
    return jsonResponse({ ok: true, storedAt: snapshot.generatedAt, probed: snapshot.channels.length });
  }

  return jsonResponse({ error: '未知 collector' }, 400);
}

/* ---- 线上大厅（只读代理房间牌） --------------------------------------------------------------
   数据源：sp-lobby.jiangjiangze.icu 的 /api/rooms（rainya 兼容结构）。
   进程内 20 秒缓存（原 CF 版用 caches.default；Deno 侧用模块级 Map 即可）。 */
const LOBBY_BOARD_URL = 'https://sp-lobby.jiangjiangze.icu/api/rooms';
const LOBBY_TTL_MS = 20_000;
let lobbyCache: { at: number; body: string } | null = null;

async function proxyLobby(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const now = Date.now();
  if (lobbyCache && now - lobbyCache.at < LOBBY_TTL_MS) {
    return new Response(lobbyCache.body, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=10, s-maxage=20, stale-while-revalidate=60',
        'access-control-allow-origin': '*',
      },
    });
  }
  try {
    const upstream = await fetch(LOBBY_BOARD_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const body = await upstream.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* 解析失败按空房间处理 */ }
    const rooms = Array.isArray(parsed?.rooms) ? parsed.rooms.slice(0, 60) : [];
    const slim = rooms.map((r: any) => ({
      code: typeof r.code === 'string' ? r.code.slice(0, 8) : '',
      note: typeof r.note === 'string' ? r.note.slice(0, 40) : '',
      serverName: typeof r.serverName === 'string' ? r.serverName.slice(0, 64) : '',
      ageSec: typeof r.ageSec === 'number' ? Math.round(r.ageSec) : null,
      leftSec: typeof r.leftSec === 'number' ? Math.round(r.leftSec) : null,
      occupied: typeof r.occupied === 'number' ? r.occupied : null,
      capacity: typeof r.capacity === 'number' ? r.capacity : null,
      status: typeof r.status === 'string' ? r.status.slice(0, 12) : null,
      difficulty: typeof r.difficulty === 'string' ? r.difficulty.slice(0, 12) : null,
    })).filter((r: any) => r.code);
    const payload = { ok: true, now: Date.now(), rooms: slim };
    const out = JSON.stringify(payload);
    lobbyCache = { at: now, body: out };
    return new Response(out, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=10, s-maxage=20, stale-while-revalidate=60',
        'access-control-allow-origin': '*',
      },
    });
  } catch {
    return new Response(JSON.stringify({ ok: true, now: Date.now(), rooms: [], error: '房间牌暂不可达' }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=5, s-maxage=5',
        'access-control-allow-origin': '*',
      },
    });
  }
}

/* ---- bug 反馈提交通道 ------------------------------------------------------------------------
   描述 + 可选截图（≤3MB）经本站同源写入 KV。截图 base64 按 48KB 分块
   （Deno KV 单值上限 64KiB），元数据与分块分别存键。 */
const FEEDBACK_MAX_DESC = 2000;
const FEEDBACK_MAX_IMG_BYTES = 3 * 1024 * 1024;
const FB_CHUNK_CHARS = 48_000;

function sanitizeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, max);
}

function sanitizeChannel(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, 32);
}

async function saveFeedbackRecord(record: { id: string; imageB64: string | null } & Record<string, unknown>) {
  const { imageB64, ...meta } = record as any;
  const b64 = typeof imageB64 === 'string' ? imageB64 : '';
  const chunks = b64 ? Math.ceil(b64.length / FB_CHUNK_CHARS) : 0;
  const writes: Promise<unknown>[] = [];
  writes.push(kv.set(['feedback', record.id, 'meta'], JSON.stringify({ ...meta, hasImage: Boolean(b64), chunks })));
  for (let i = 0; i < chunks; i++) {
    writes.push(kv.set(['feedback', record.id, 'c', i], b64.slice(i * FB_CHUNK_CHARS, (i + 1) * FB_CHUNK_CHARS)));
  }
  await Promise.all(writes);
}

/** KV 里的 meta 是 saveFeedbackRecord 写进去的 JSON **字符串**，读回来必须自己 parse。
 *  2026-11-03：少了这一步导致 `{...meta}` 把字符串按字符展开，转交出去的 Issue 全部是
 *  `undefined`（#190–#195 全空壳）。历史上被删掉的记录无法追回，但新写入立刻正确。 */
function parseFeedbackMeta(value: unknown): any | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function readFeedbackRecord(id: string): Promise<any | null> {
  const metaEntry = await kv.get<string>(['feedback', id, 'meta']);
  const meta = parseFeedbackMeta(metaEntry.value);
  if (!meta) return null;
  let b64 = '';
  for (let i = 0; i < (meta.chunks || 0); i++) {
    const c = await kv.get<string>(['feedback', id, 'c', i]);
    if (typeof c.value !== 'string') return null;
    b64 += c.value;
  }
  return { ...meta, imageB64: b64 || null };
}

async function deleteFeedbackRecord(id: string) {
  const metaEntry = await kv.get<string>(['feedback', id, 'meta']);
  const meta = parseFeedbackMeta(metaEntry.value);
  const chunks = meta?.chunks || 0;
  const dels: Promise<unknown>[] = [kv.delete(['feedback', id, 'meta'])];
  for (let i = 0; i < chunks; i++) dels.push(kv.delete(['feedback', id, 'c', i]));
  await Promise.all(dels);
}

async function readFeedbackIndex(): Promise<string[]> {
  const entry = await kv.get<string>(KEY_FB_INDEX as unknown as Deno.KvKey);
  if (!entry.value) return [];
  try {
    const parsed = JSON.parse(entry.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 往「最新 N 条」索引里加一个 id（§Q4d：原来的 read-modify-write 在并发下会互相覆盖，
 *  被覆盖掉的记录既不会被 cron 转交、也永远不被删除 → 静默丢数据且永久占 KV）。
 *  用 kv.atomic() 的 check-and-set，冲突就重读重试。 */
async function appendFeedbackIndex(id: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const entry = await kv.get<string>(KEY_FB_INDEX as unknown as Deno.KvKey);
    let index: string[] = [];
    try { const p = JSON.parse(entry.value || '[]'); if (Array.isArray(p)) index = p; } catch { index = []; }
    const next = [id, ...index.filter((x) => x !== id)].slice(0, 200);
    const res = await kv.atomic()
      .check(entry)
      .set(KEY_FB_INDEX as unknown as Deno.KvKey, JSON.stringify(next))
      .commit();
    if (res.ok) return;
  }
  console.error('[index] 追加失败（持续竞争），id=', id);
}

/** 服务端崩溃指纹：对解密后的 kind/message/栈前若干行取 SHA-256（不信客户端给的明文 fp）。 */
async function crashFingerprint(rep: any): Promise<string> {
  const stackHead = typeof rep.stack === 'string'
    ? rep.stack.split('\n').slice(0, 5).join('\n')
    : '';
  const src = `${rep.kind ?? ''}\u0000${rep.message ?? ''}\u0000${stackHead}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(src));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function handleFeedback(request: Request): Promise<Response> {
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

  let imageB64: string | null = null;
  let imageType: string | null = null;
  const file = form.get('screenshot');
  if (file && typeof file === 'object' && typeof (file as File).arrayBuffer === 'function') {
    const buf = new Uint8Array(await (file as File).arrayBuffer());
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
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK) as unknown as number[]);
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
    forwarded: false,
    meta: {
      country: request.headers.get('cf-ipcountry') ?? null,
      city: request.headers.get('cf-ipcity') ?? null,
      ua: request.headers.get('user-agent')?.slice(0, 200) ?? null,
    },
  };
  await saveFeedbackRecord(record);
  await appendFeedbackIndex(id);

  return jsonResponse({ ok: true, id }, 201);
}

/* ---- APK 崩溃上报（公钥加密，2026-11-03）-----------------------------------------------------
   链路：APK 原生层捕获未捕获异常 → 用内置 **公钥** 做 RSA-OAEP(SHA-256) 包裹一把一次性 AES-256
   密钥 → AES-GCM 加密正文 → POST 到这里 → 本实例用 env 里的 **私钥** 解密 → 落 KV（与表单反馈
   同一条流水线，Cron 自动转交成 GitHub Issue）。

   为什么是公钥：APK 里的任何东西都能被反编译取出。只放公钥时，攻击者能伪造上报（噪音），但**不能**
   解密别人的上报；私钥只存在本实例的 env 里，反编译 APK 拿不到。要真正防伪造还需签名，但当前
   威胁模型是「防明文泄露」而非「防伪造」，故用公钥 + 限流 + 指纹去重组合。

   请求体（JSON，字段名短以省流量）：
     { v:1, ek:"<base64 RSA-OAEP 包裹的 32 字节 AES key>", iv:"<base64 12 字节>",
       ct:"<base64 AES-GCM 密文||16 字节 tag>", fp:"<崩溃指纹，明文，用于去重>" }
   ct 里是 UTF-8 JSON：{ kind, thread, message, stack, app, vc, vn, dev, ts, log }。
   ----------------------------------------------------------------------------------------- */
const CRASH_MAX_BODY = 64 * 1024;        // 单次上报上限（密文）
const CRASH_RATE_PER_IP = 20;            // 每 IP 每小时最多接受条数
const CRASH_DEDUPE_MS = 6 * 60 * 60 * 1000;   // 同一指纹 6 小时内只建一条 issue

/** base64 → 字节。返回 Uint8Array 的 .buffer（ArrayBuffer），因为 WebCrypto 的
 *  BufferSource 参数在 TS 5 的 lib 下不接受 Uint8Array<ArrayBufferLike>。 */
function b64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** 用实例私钥解开一次上报；任何一步失败都抛错（调用方记日志，不把细节回给客户端）。 */
async function decryptCrashPayload(body: any): Promise<any> {
  const privB64 = Deno.env.get('CRASH_PRIV_KEY');
  if (!privB64) throw new Error('CRASH_PRIV_KEY 未配置');
  if (typeof body?.ek !== 'string' || typeof body?.iv !== 'string' || typeof body?.ct !== 'string') {
    throw new Error('字段缺失');
  }
  const priv = await crypto.subtle.importKey(
    'pkcs8', b64ToBytes(privB64), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const aesRaw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, b64ToBytes(body.ek));
  const aes = await crypto.subtle.importKey('raw', aesRaw, { name: 'AES-GCM' }, false, ['decrypt']);
  // WebCrypto 的 AES-GCM 期待 ct||tag 拼接——Android Cipher.doFinal() 的返回就是这个形状。
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(body.iv) }, aes, b64ToBytes(body.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

/* ---- 脱敏（2026-11-03，验收 §Q5/Q8）--------------------------------------------------------
   崩溃报告的 log 字段来自 APK 的 diag.log，里面**已证实**含房间号（join-404 写的
   `step N -> /?room=CODE`）与服务器地址（`host=...`）。而这些正文最终会进**公开** GitHub issue。
   所以转交前必须脱敏——与 diag.js 的 secretsOf/redact 同一目标，但这里是服务端最后一道闸：
   玩家名之类拿不到，只能按**形态**削掉高熵标识。

   规则（宁可多削，不可漏削）：
     · `?room=` / `&room=` 的值 → <room>
     · `room=XXXX` 形态 → <room>
     · `token=...` / `Bearer ...` → <token>
     · 任意 http(s)://host 的主机名 → 保留 scheme，削成 <host>
     · IPv4 地址 → <ip>
     · 长 hex / 长 base64 串（>=24 字符）→ <blob>
   ------------------------------------------------------------------------------------------ */
const REDACT_RULES: [RegExp, string][] = [
  [/([?&]room=)[^\s&#"'<>]+/gi, '$1<room>'],
  [/(\broom[=:]\s*)[A-Za-z0-9_-]{1,}/gi, '$1<room>'],           // 1 字符起的房间号也削（§13）
  [/(\btoken[=:]\s*)[^\s&"'<>]+/gi, '$1<token>'],
  [/(Bearer\s+)[^\s"'<>]+/gi, '$1<token>'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s"'<>)]+)/gi, '$1<host>'],
  // 裸域名形态。§6 实测漏网的两条真实 diag 行：
  //   `art-srv not same-origin: cdn.example.com`（无 host= 前缀）
  //   `art-cdn blocked host: cdn.somewhere.cc`（.cc 不在 TLD 白名单）
  // 所以这里不再依赖 TLD 白名单，改成「任何带点的 hostname 形态」，并排除已脱敏的占位符。
  // 前缀情形（host=/from:/origin:/same-origin:）先走这条更精确的规则。
  [/(\b(?:host|from|origin|same-origin|blocked\s+host)[=:]\s*)[A-Za-z0-9.-]+(?::\d+)?/gi, '$1<host>'],
  // 任意裸 hostname（≥2 段，末段 2-8 位字母）：`cdn.example.com`、`cdn.somewhere.cc`。
  // 用负向前瞻避开已经是占位符/常见非主机词（<host>、.js、.mjs、.json、.html、.css）。
  [/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?\b(?<!\.(?:js|mjs|json|html|css|png|webp|jpg|ogg|mp3|woff2|spine)) /gi,
    '<host> '],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>'],
  [/\b[A-Fa-f0-9]{24,}\b/g, '<blob>'],
  [/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, '<blob>'],
];

function redactCrashText(text: unknown): string {
  if (typeof text !== 'string') return '';
  let out = text;
  for (const [re, to] of REDACT_RULES) {
    try { out = out.replace(re, to); } catch { /* 单条规则失效不影响其余 */ }
  }
  return out;
}

/** 把崩溃报告排成一段人能读的正文（写进 KV 的 description，最终成为 Issue 正文）。
 *  §Q6/§7：**分区限额 + 取尾部**。
 *  两个坑都要避开：① 拼接后一次 slice(2000) 会让 stack 稍长就把「最近日志」整段切掉；
 *  ② `log` 已经是 APK 侧 diag.log 的**尾部**窗口，若再 `.slice(0,600)` 取开头，拿到的反而是
 *  更旧的行——崩溃前最后几行（最有用）全丢。所以日志取**尾部** 600 字，且总长按剩余预算分配。 */
function crashToDescription(rep: any): string {
  const r = rep && typeof rep === 'object' ? rep : {};
  // 设备型号粗化（§6 LOW）：机型+系统版本+应用版本+精确时刻 = 可长期跟踪的设备指纹。
  // 只保留厂商与 Android 大版本，足够定位「某类设备」但不构成唯一标识。
  const devRaw = typeof r.dev === 'string' ? r.dev : '';
  const devVendor = devRaw.split(/\s+/)[0] || '?';
  const devAndroid = (devRaw.match(/Android\s+\d+/i) || [''])[0] || '';
  const dev = `${devVendor}${devAndroid ? ' / ' + devAndroid : ''}`.trim() || '?';
  const head = `APK 崩溃报告\n应用: ${r.app ?? '?'} (vc${r.vc ?? '?'} / ${r.vn ?? '?'})\n` +
    `线程: ${r.thread ?? '?'}  类型: ${r.kind ?? '?'}\n时间: ${r.ts ?? '?'}\n设备: ${dev}`;
  const message = redactCrashText(r.message).slice(0, 300);
  const stack = redactCrashText(r.stack).slice(0, 1000);
  const logTail = redactCrashText(r.log);
  const LOG_BUDGET = 600;
  const log = logTail.length > LOG_BUDGET ? logTail.slice(-LOG_BUDGET) : logTail;   // 取尾部
  const parts = [head, '', message];
  if (stack) parts.push(stack);
  if (log.trim()) parts.push('', '--- 最近日志（已脱敏，取末尾）---', log.trim());
  // 兜底仍按 2000 收口，但上面各段已按预算分配，正常情况不会触发（head 134 + 300 + 1000 + 600 ≈ 2040 略超，故再收一次）
  return parts.join('\n').slice(0, FEEDBACK_MAX_DESC);
}

/** 崩溃标题：从**结构化字段**取，不从扁平字符串按行号掏（§Q5 实测 [3] 取到的是「时间: …」）。 */
function crashTitle(rep: any): string {
  const r = rep && typeof rep === 'object' ? rep : {};
  const kind = typeof r.kind === 'string' && r.kind ? r.kind : 'apk';
  const msg = redactCrashText(r.message).replace(/\s+/g, ' ').slice(0, 60);
  return `崩溃[${kind}]：${msg || '无摘要'}`;
}

/** 原子自增计数（§Q4a：原 get→+1→set 非原子，并发时全部读到同值，限流形同虚设）。 */
async function bumpCounter(key: Deno.KvKey, ttlMs: number): Promise<number> {
  for (let i = 0; i < 4; i++) {
    const cur = await kv.get<number>(key);
    const next = (cur.value || 0) + 1;
    const res = await kv.atomic().check(cur).set(key, next, { expireIn: ttlMs }).commit();
    if (res.ok) return next;
  }
  return Number.MAX_SAFE_INTEGER;   // 竞争失败：放行（宁可少拦，不误杀真实崩溃）
}

/** 限流键：优先平台注入的真实对端地址（Deno.serve 的 info.remoteAddr，见 route 的调用方），
 *  其次 CF 头；**空值不再共用 'unknown' 桶**——那会让全体设备共享 20 条/小时（§Q4b）。
 *  取不到真实地址时退到「全局低频桶」，额度单独且更小。 */
const GLOBAL_CRASH_BUCKET_LIMIT = 200;   // 全局兜底额度（防打爆 KV），远高于单机

async function crashRateOk(ip: string | null): Promise<boolean> {
  const hour = Math.floor(Date.now() / 3600000).toString();
  try {
    if (ip && ip !== 'unknown') {
      const n = await bumpCounter(['crash-rate', ip, hour] as unknown as Deno.KvKey, 2 * 3600 * 1000);
      return n <= CRASH_RATE_PER_IP;
    }
    // 没有真实 IP（直连 deno.net 时常见）：只挡极端洪峰，不拿真实用户当攻击者。
    const n = await bumpCounter(['crash-rate-global', hour] as unknown as Deno.KvKey, 2 * 3600 * 1000);
    return n <= GLOBAL_CRASH_BUCKET_LIMIT;
  } catch {
    return true;   // 计数失败不该挡住真实崩溃上报
  }
}

async function handleCrashReport(request: Request, remoteIp: string | null): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  }
  // §Q7.8：先看 content-length，别把 64KB+ 的体全读进内存再拒。
  const declared = Number(request.headers.get('content-length') || '0');
  if (declared > CRASH_MAX_BODY) return jsonResponse({ error: '内容过大' }, 413);

  // §4/§6：`cf-connecting-ip` 在直连 deno.net 时**由客户端自带**，可被随意伪造 → 绝不能当 IP 用。
  // 只用平台注入的 info.remoteAddr（客户端改不了）；CF 头仅在确认有 cf-ray（即真过了 CF 边缘）时才采信。
  const viaCfEdge = !!request.headers.get('cf-ray');
  const ip = viaCfEdge ? (request.headers.get('cf-connecting-ip') || remoteIp) : remoteIp;
  if (!(await crashRateOk(ip))) return jsonResponse({ error: '请求过于频繁' }, 429);

  const raw = await request.text();
  if (raw.length > CRASH_MAX_BODY) return jsonResponse({ error: '内容过大' }, 413);

  let body: any;
  try { body = JSON.parse(raw); } catch { return jsonResponse({ error: '不是合法 JSON' }, 400); }

  let rep: any;
  try {
    rep = await decryptCrashPayload(body);
  } catch (e) {
    console.error('[crash] 解密失败:', String((e as Error)?.message || e));
    return jsonResponse({ error: '无法解密' }, 400);
  }
  if (!rep || typeof rep !== 'object') return jsonResponse({ error: '载荷不是对象' }, 400);

  // 指纹去重（§Q4c）：用服务端对**解密后内容**取哈希，不信客户端给的 fp（那只是明文可换的）。
  const fp = await crashFingerprint(rep);
  const fpKey = ['crash-fp', fp] as unknown as Deno.KvKey;
  try {
    const seen = await kv.get<string>(fpKey);
    if (seen.value) return jsonResponse({ ok: true, deduped: true }, 200);
    const res = await kv.atomic().check(seen).set(fpKey, new Date().toISOString(), { expireIn: CRASH_DEDUPE_MS }).commit();
    if (!res.ok) return jsonResponse({ ok: true, deduped: true }, 200);
  } catch { /* KV 失败不阻塞上报 */ }

  const id = `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    submittedAt: new Date().toISOString(),
    description: crashToDescription(rep),
    title: crashTitle(rep),                    // 结构化标题：转交时直接取，不再从正文按行号掏
    channel: 'apk-crash',
    contact: null,
    imageType: null,
    imageB64: null,
    forwarded: false,
    meta: {
      country: request.headers.get('cf-ipcountry') ?? null,
      city: request.headers.get('cf-ipcity') ?? null,
      ua: request.headers.get('user-agent')?.slice(0, 200) ?? null,
      transportEncrypted: true,                // 传输加密；KV 里存的是明文 description
    },
  };
  await saveFeedbackRecord(record);
  await appendFeedbackIndex(id);

  return jsonResponse({ ok: true, id }, 201);
}

/* ---- 反馈管理接口（机器对机器，不面向浏览器） ------------------------------------------------ */
function requireSvcAuth(request: Request): boolean {
  const token = Deno.env.get('FEEDBACK_SVC_TOKEN');
  if (!token) return false;
  const auth = request.headers.get('authorization') || '';
  return auth === `Bearer ${token}`;
}

async function listPendingFeedback(): Promise<any[]> {
  const index = await readFeedbackIndex();
  const pending: any[] = [];
  for (const id of index) {
    const rec = await readFeedbackRecord(id);
    if (!rec) continue;
    if (rec.forwarded) continue;
    pending.push(rec);
  }
  return pending;
}

/** 删记录并从索引移除。索引侧同样用 check-and-set（§9：`kv.set` 覆盖会在并发
 *  appendFeedbackIndex 期间丢 id —— 那条记录既不转交也永不清理）。 */
async function markFeedbackDone(id: string) {
  await deleteFeedbackRecord(id);
  for (let i = 0; i < 6; i++) {
    const entry = await kv.get<string>(KEY_FB_INDEX as unknown as Deno.KvKey);
    let index: string[] = [];
    try { const p = JSON.parse(entry.value || '[]'); if (Array.isArray(p)) index = p; } catch { index = []; }
    const next = index.filter((x) => x !== id);
    const res = await kv.atomic()
      .check(entry)
      .set(KEY_FB_INDEX as unknown as Deno.KvKey, JSON.stringify(next))
      .commit();
    if (res.ok) return;
  }
  console.error('[index] 移除失败（持续竞争），id=', id);
}

async function handleFeedbackPending(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  if (!requireSvcAuth(request)) return jsonResponse({ error: '未授权' }, 401);
  const pending = await listPendingFeedback();
  return jsonResponse({ ok: true, count: pending.length, items: pending });
}

/* ---- 反馈 → GitHub Issue（Deno.cron 自动转交） ------------------------------------------------
   每天在常玩时段（北京时间 12:00 / 17:00 / 21:00 / 24:00 = UTC 04/09/13/16）批量触发一次。
   高权限 GH_TOKEN 仅在此处使用，从不经过任何面向浏览器的响应。 */
const GH_REPO = 'jingjiangze/Stronghold-Protocol';

function feedbackToIssueBody(rec: any): string {
  // 崩溃上报（/api/crash）走同一个转交器，但正文已排好版（crashToDescription），不再套表单模板。
  if (rec.channel === 'apk-crash') {
    return `${rec.description}\n\n> 本反馈由 arknights-gateway 自动转交（来源：APK 崩溃自动上报，公钥加密）。反馈 ID：${rec.id}`;
  }
  const lines: string[] = [];
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

async function uploadScreenshotGist(rec: any, ghToken: string): Promise<string | null> {
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
  const files = data?.files as Record<string, { raw_url?: string }> | undefined;
  return files ? Object.values(files)[0]?.raw_url ?? null : null;
}

async function forwardFeedbackToGitHub(rec: any, ghToken: string) {
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
      // 标题用记录里的结构化 title（崩溃）或描述首行（表单）；不再按行号从正文掏（§Q5）。
      title: rec.channel === 'apk-crash'
        ? String(rec.title || 'APK 崩溃报告').replace(/\s+/g, ' ').slice(0, 80)
        : `反馈：${(rec.description || '').slice(0, 60).replace(/\s+/g, ' ')}`,
      body,
      labels: rec.channel === 'apk-crash' ? ['bug', 'feedback', 'crash'] : ['bug', 'feedback'],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`GitHub 返回 ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

/* ---- 游戏服公告管理 --------------------------------------------------------------------------
   链路：admin 页 PUT → 存 KV → GET /api/announcements/game 对外暴露成一份纯 JSON →
   游戏服设 SP_ANNOUNCEMENTS_URL 指向它，每 60 秒拉一次。读取公开，写入必须 Bearer token。 */

const GAME_ANN_MAX_BYTES = 64 * 1024;
const GAME_ANN_MAX_ENTRIES = 50;
const GAME_ANN_MAX_TITLE = 120;
const GAME_ANN_MAX_PARAGRAPHS = 40;
const GAME_ANN_MAX_PARA_CHARS = 10000;
const GAME_ANN_MAX_TOTAL_CHARS = 200000;

const LEVELS = new Set(['info', 'warning', 'critical']);

function normalizeAnnouncement(raw: any): { entry?: any; error?: string } {
  if (!raw || typeof raw !== 'object') return { error: '条目必须是对象' };
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return { error: '标题不能为空' };
  if (title.length > GAME_ANN_MAX_TITLE) return { error: `标题超过 ${GAME_ANN_MAX_TITLE} 字` };
  const date = typeof raw.date === 'string' && raw.date.trim() ? raw.date.trim().slice(0, 40) : '';
  if (!Array.isArray(raw.paragraphs) || !raw.paragraphs.length) return { error: '正文至少一段' };
  if (raw.paragraphs.length > GAME_ANN_MAX_PARAGRAPHS) return { error: `正文超过 ${GAME_ANN_MAX_PARAGRAPHS} 段` };
  const paragraphs: string[] = [];
  for (const p of raw.paragraphs) {
    if (typeof p !== 'string' || !p.trim()) return { error: '正文段落不能为空' };
    if (p.length > GAME_ANN_MAX_PARA_CHARS) return { error: '正文单段过长' };
    paragraphs.push(p);
  }
  const level = LEVELS.has(raw.level) ? raw.level : 'info';
  return { entry: { title, date, paragraphs, level } };
}

async function readGameAnnouncements() {
  const entry = await kv.get<string>(KEY_ANN as unknown as Deno.KvKey);
  let parsed: any = null;
  try { parsed = JSON.parse(entry.value || 'null'); } catch { parsed = null; }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  return { updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null, entries };
}

async function handleGameAnnouncements(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const { entries } = await readGameAnnouncements();
  // 直接给数组（不是包装对象）：游戏服的 SP_ANNOUNCEMENTS_URL 期望的就是
  // data/announcements.json 那份结构，少一层包装就少一处要解释的差异。
  return jsonResponse(entries, 200, 'public, max-age=0, must-revalidate');
}

async function handleGameAnnouncementsAdmin(request: Request): Promise<Response> {
  const token = Deno.env.get('INGEST_TOKEN');
  if (!token) return jsonResponse({ error: '未配置 INGEST_TOKEN' }, 503);
  const auth = request.headers.get('authorization') || '';
  if (auth !== `Bearer ${token}`) return jsonResponse({ error: '未授权' }, 401);

  if (request.method === 'GET' || request.method === 'HEAD') {
    const { updatedAt, entries } = await readGameAnnouncements();
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

    const entries: any[] = [];
    let chars = 0;
    for (const [i, item] of list.entries()) {
      const res = normalizeAnnouncement(item);
      if (res.error) return jsonResponse({ error: `第 ${i + 1} 条：${res.error}` }, 400);
      chars += res.entry.title.length + res.entry.paragraphs.reduce((n: number, p: string) => n + p.length, 0);
      if (chars > GAME_ANN_MAX_TOTAL_CHARS) return jsonResponse({ error: '公告总量超过上限' }, 400);
      entries.push(res.entry);
    }
    const updatedAt = new Date().toISOString();
    await kv.set(KEY_ANN as unknown as Deno.KvKey, JSON.stringify({ updatedAt, entries }));
    return jsonResponse({ ok: true, updatedAt, count: entries.length });
  }
  return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD, PUT' } });
}

/* ---- 游戏服的运行开关与一键重新部署（后台面板用） ---------------------------------------------
   MS_PLATFORM_TOKEN 是创空间平台凭据（Deno 侧走 env，永不回给浏览器）。
   重建会清空内存里的对局，所以先查占用，场上有局就拒绝。 */

const MS_NS = 'jingjiangze';
const MS_NAME = 'Stronghold-Protocol';
const MS_API = 'https://www.modelscope.cn/api/v1/studio';
const MS_HEALTH = 'https://studio-jingjiangze-stronghold-protocol.api-inference.modelscope.net/healthz';

async function readGameSettings() {
  try {
    const entry = await kv.get<string>(KEY_SETTINGS as unknown as Deno.KvKey);
    const parsed = JSON.parse(entry.value || 'null');
    if (parsed && typeof parsed === 'object') {
      return { hotMods: parsed.hotMods === true, updatedAt: parsed.updatedAt || null, updatedBy: parsed.updatedBy || null };
    }
  } catch { /* 坏 JSON 当没写过 */ }
  return { hotMods: false, updatedAt: null, updatedBy: null };
}

async function handleGameSettings(request: Request): Promise<Response> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return jsonResponse({ ok: true, ...(await readGameSettings()) }, 200, 'public, max-age=0, must-revalidate');
  }
  const token = Deno.env.get('INGEST_TOKEN');
  if (!token) return jsonResponse({ error: '未配置 INGEST_TOKEN' }, 503);
  if ((request.headers.get('authorization') || '') !== `Bearer ${token}`) return jsonResponse({ error: '未授权' }, 401);
  if (request.method !== 'PUT') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD, PUT' } });
  let body;
  try { body = JSON.parse((await request.text()) || '{}'); } catch { return jsonResponse({ error: '请求体不是 JSON' }, 400); }
  if (typeof body.hotMods !== 'boolean') return jsonResponse({ error: 'hotMods 必须是布尔值' }, 400);
  const next = { hotMods: body.hotMods, updatedAt: new Date().toISOString(), updatedBy: 'admin' };
  await kv.set(KEY_SETTINGS as unknown as Deno.KvKey, JSON.stringify(next));
  return jsonResponse({ ok: true, ...next });
}

/* GET 公开：后台不填令牌也要能看到游戏服状态（写侧 —— PUT /api/settings/game、
   POST /api/game/redeploy —— 各自仍要 Bearer）。公开意味着任何人都能借本站去打创空间控制面
   （这里每次两发：healthz + commit/check-changed），所以结果进 15 秒缓存，把上游请求量
   钉死在每分钟 4 次，不随访问量放大 —— 与 /api/status 同一口径。 */
const KEY_GAME_STATUS = ['game-status', 'latest'] as const;
const GAME_STATUS_CACHE_MS = 15000;
const GAME_STATUS_CACHE_HEADER = `public, max-age=5, s-maxage=${STATUS_CACHE_SECONDS}, stale-while-revalidate=30`;

async function handleGameStatus(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const ms = Deno.env.get('MS_PLATFORM_TOKEN');
  if (!ms) return jsonResponse({ error: '未配置 MS_PLATFORM_TOKEN' }, 503);
  try {
    const cached = await kv.get<{ at: number; out: unknown }>(KEY_GAME_STATUS as unknown as Deno.KvKey);
    if (cached.value && Date.now() - Number(cached.value.at) < GAME_STATUS_CACHE_MS) {
      return jsonResponse(cached.value.out as Record<string, unknown>, 200, GAME_STATUS_CACHE_HEADER);
    }
  } catch { /* KV 读不到就现采一次 */ }
  const out: any = { ok: true, health: null, deploy: null, settings: await readGameSettings(), error: null };
  try {
    const r = await fetch(MS_HEALTH, { headers: { authorization: `Bearer ${ms}` }, signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const h = await r.json();
      out.health = {
        app: h.app ?? null, build: h.build ?? null, rooms: h.rooms ?? 0, humans: h.humans ?? 0,
        matches: h.matches ?? 0, uptimeSec: h.uptimeSec ?? null,
        performance: h.performance ?? null,
      };
    } else out.error = `healthz ${r.status}`;
  } catch (e) { out.error = String((e as Error)?.message || e).slice(0, 160); }
  try {
    const r = await fetch(`${MS_API}/${MS_NS}/${MS_NAME}/commit/check-changed`, { headers: { authorization: `Bearer ${ms}` }, signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const d = (await r.json())?.Data || {};
      out.deploy = {
        current: String(d.CurrentCommitId || '').slice(0, 8),
        deployed: String(d.LastDeployCommitId || '').slice(0, 8),
        changed: d.HasChanged === true,
      };
    }
  } catch { /* 平台读不到不影响占用判断 */ }
  try { await kv.set(KEY_GAME_STATUS as unknown as Deno.KvKey, { at: Date.now(), out }); } catch { /* 缓存写失败不影响这一次响应 */ }
  return jsonResponse(out, 200, GAME_STATUS_CACHE_HEADER);
}

async function handleGameRedeploy(request: Request): Promise<Response> {
  const token = Deno.env.get('INGEST_TOKEN');
  if (!token) return jsonResponse({ error: '未配置 INGEST_TOKEN' }, 503);
  if ((request.headers.get('authorization') || '') !== `Bearer ${token}`) return jsonResponse({ error: '未授权' }, 401);
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  const ms = Deno.env.get('MS_PLATFORM_TOKEN');
  if (!ms) return jsonResponse({ error: '未配置 MS_PLATFORM_TOKEN' }, 503);

  // 门：重建会清空内存对局，场上有局就不动它。读不到占用也拒绝。
  let health;
  try {
    const r = await fetch(MS_HEALTH, { headers: { authorization: `Bearer ${ms}` }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return jsonResponse({ error: `读不到游戏服占用（healthz ${r.status}），先确认它在跑` }, 502);
    health = await r.json();
  } catch (e) {
    return jsonResponse({ error: '读不到游戏服占用（健康检查失败）: ' + String((e as Error)?.message || e).slice(0, 120) }, 502);
  }
  const busy = { rooms: health.rooms ?? 0, humans: health.humans ?? 0, matches: health.matches ?? 0 };
  if (Number(busy.rooms) + Number(busy.humans) + Number(busy.matches) > 0) {
    return jsonResponse({ error: '场上有局，重建会清空对局', busy }, 409);
  }

  const r = await fetch(`${MS_API}/${MS_NS}/${MS_NAME}/reset_restart`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${ms}`, 'content-type': 'application/json' },
    body: JSON.stringify({ Path: MS_NS, Name: MS_NAME }),
    signal: AbortSignal.timeout(20000),
  });
  let data: any = null;
  try { data = await r.json(); } catch { /* 平台可能给空体 */ }
  if (!r.ok || data?.Success === false) {
    return jsonResponse({ error: `平台拒绝重建（HTTP ${r.status}）`, detail: String(data?.Message || '').slice(0, 160) }, 502);
  }
  return jsonResponse({ ok: true, message: '已触发重建，2–4 分钟后生效；期间 ms.show 会短暂不可用', triggeredAt: new Date().toISOString() });
}

/* ---- 安全头 / CSP / 404 ---------------------------------------------------------------------- */

/**
 * CSP 的 connect-src：除了 'self'，还要放行清单里各 origin —— 延迟由玩家浏览器自主探测
 * （对 origin 做 no-cors 连接计时）。主机清单来自 channels.json（构建期 check.mjs 校验过）。
 */
async function cspFor(): Promise<string> {
  let connectExtra = '';
  try {
    const { list } = await loadChannels();
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
    "script-src 'self' 'unsafe-inline'",
    `connect-src 'self'${connectExtra}`,
    'upgrade-insecure-requests',
  ].join('; ');
}

function decorate(response: Response, csp: string): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  headers.set('content-security-policy', csp);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function notFound(): Response {
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

/* ---- 诊断（Bearer INGEST_TOKEN 保护；排查 Deno→外部出网） ------------------------------------ */
async function handleDiag(request: Request): Promise<Response> {
  const token = Deno.env.get('INGEST_TOKEN');
  if (!token || (request.headers.get('authorization') || '') !== `Bearer ${token}`) {
    return jsonResponse({ error: '未授权' }, 401);
  }
  const ms = Deno.env.get('MS_PLATFORM_TOKEN');
  const out: any = { msToken: ms ? `set(len=${ms.length})` : 'unset', kvOk: false, probes: [] };
  try { await kv.get(['diag', 'probe']); out.kvOk = true; } catch (e) { out.kvOk = String(e); }
  const targets: [string, string, string | undefined][] = [
    ['MS_HEALTH', 'https://studio-jingjiangze-stronghold-protocol.api-inference.modelscope.net/healthz', ms],
    ['MS_API', 'https://www.modelscope.cn/api/v1/studio/jingjiangze/Stronghold-Protocol/commit/check-changed', ms],
    ['GITHUB', 'https://api.github.com/zen', undefined],
    ['LOBBY', 'https://sp-lobby.jiangjiangze.icu/api/rooms', undefined],
  ];
  for (const [name, url, tok] of targets) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { headers: tok ? { authorization: `Bearer ${tok}` } : {}, signal: AbortSignal.timeout(12000) });
      out.probes.push({ name, code: r.status, ms: Date.now() - t0 });
    } catch (e) {
      out.probes.push({ name, error: `${(e as Error)?.name}: ${(e as Error)?.message}`.slice(0, 160), ms: Date.now() - t0 });
    }
  }
  return jsonResponse(out);
}

/* ---- 路由 ------------------------------------------------------------------------------------ */

async function route(request: Request, remoteIp: string | null = null): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === '/api/_diag') return handleDiag(request);
  if (pathname === '/healthz') return handleHealthz();
  if (pathname === '/api/ingest') return handleIngest(request);

  if (pathname === '/api/status') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    return handleStatus(request);
  }

  if (pathname === '/api/lobby') return proxyLobby(request);
  if (pathname === '/api/feedback') return handleFeedback(request);
  if (pathname === '/api/feedback/pending') return handleFeedbackPending(request);
  if (pathname === '/api/crash') return handleCrashReport(request, remoteIp);

  if (pathname === '/api/announcements/game') return handleGameAnnouncements(request);
  if (pathname === '/api/announcements/game/admin') return handleGameAnnouncementsAdmin(request);

  if (pathname === '/api/settings/game') return handleGameSettings(request);
  if (pathname === '/api/game/status') return handleGameStatus(request);
  if (pathname === '/api/game/redeploy') return handleGameRedeploy(request);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const csp = await cspFor();
  const asset = await serveStatic(pathname);
  if (!asset) return decorate(notFound(), csp);
  return decorate(asset, csp);
}

/* ---- 定时任务（原 wrangler triggers.crons 的等价物） ------------------------------------------ */
Deno.cron('feedback-forward', '0 4,9,13,16 * * *', async () => {
  const ghToken = Deno.env.get('GH_TOKEN');
  if (!ghToken) {
    console.error('[cron] GH_TOKEN 未配置，跳过');
    return;
  }
  let pending: any[] = [];
  try {
    pending = await listPendingFeedback();
  } catch (e) {
    console.error('[cron] 读取待转交反馈失败:', String((e as Error)?.message || e));
    return;
  }
  for (const rec of pending) {
    try {
      const issue = await forwardFeedbackToGitHub(rec, ghToken);
      await markFeedbackDone(rec.id);
      console.log(`[cron] forwarded ${rec.id} -> ${issue?.html_url ?? ''}`);
    } catch (err) {
      console.error(`[cron] ${rec.id} 转交失败:`, String((err as Error)?.message || err));
    }
  }
  console.log(`[cron] checked=${pending.length}`);
});

/* ---- 启动 ------------------------------------------------------------------------------------ */
// Deno.serve 的第二个参数带 info.remoteAddr —— 这是平台给的真实对端地址，客户端改不了。
// 直连 deno.net 时没有 CF 头（cf-connecting-ip 为空），限流只能靠它（见 crashRateOk 的注释）。
Deno.serve((request, info) => route(request, info?.remoteAddr?.hostname ?? null));
