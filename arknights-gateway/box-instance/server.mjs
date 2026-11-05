/* ==========================================================================================
   arknights-gateway · 实例 B「盒子服」（Node 24 stdlib，零依赖）

   2026-10-13：与 Deno Deploy 上的实例 A「魔搭创空间服」是**同一套对外形状、两个独立实例**：
     - 域名相同（arknights.jiangjiangze.icu），玩家看到同样的入口页与后台；
     - 但 /api/status 读的数据源不同：A 读创空间，B 读**盒子本机** 127.0.0.1:3000/healthz；
     - 公告与设置各自独立存储（用户明确要求「两个独立」），互不同步；
     - /healthz 会自报实例身份，后台页据此显示「盒子服 / 创空间服」避免误操作。

   为什么是 Node：盒子上没有 Deno（实测 deno: NOT INSTALLED），只有 Node v24.19.0，
   且盒子本机就能读游戏服 healthz —— 这也是 /api/status 最准的数据源（零出网、零额度）。

   端口：8911（8910 已被现有 ark-admin 占用；8911/8912 实测空闲）。

   对外形状（与实例 A 逐字段一致）：
     GET  /api/status                     { ok, channels[], instance{id,label,healthzUrl,app,build}, visitor }
     GET  /api/announcements/game         裸数组（游戏服 SP_ANNOUNCEMENTS_URL 每 60s 拉的就是它）
     GET|PUT /api/announcements/game/admin  要 Bearer；PUT 整体替换
     GET|PUT /api/settings/game           公开读 / Bearer 写
     GET  /admin                          后台页（复用仓库 public/admin.html）
     GET  /healthz                        { ok, service, instance, target }

   配置：本目录 config.json（已 gitignore）或环境变量
     ARK_GW_PORT / ARK_GW_HOST / ARK_GW_INGEST_TOKEN / ARK_GW_INSTANCE_ID / ARK_GW_INSTANCE_LABEL / ARK_GW_HEALTHZ_URL
   ========================================================================================== */

import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
mkdirSync(DATA, { recursive: true });

/** 静态站点目录：与仓库 public/ 同构（部署时把 public/ 拷到 ./public） */
const PUBLIC = path.join(ROOT, 'public');

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { cfg = {}; }
  return {
    ingestToken: process.env.ARK_GW_INGEST_TOKEN || cfg.ingestToken || '',
    port: Number(process.env.ARK_GW_PORT || cfg.port || 8911),
    host: process.env.ARK_GW_HOST || cfg.host || '127.0.0.1',
    instanceId: process.env.ARK_GW_INSTANCE_ID || cfg.instanceId || 'box',
    instanceLabel: process.env.ARK_GW_INSTANCE_LABEL || cfg.instanceLabel || '盒子服',
    healthzUrl: process.env.ARK_GW_HEALTHZ_URL || cfg.healthzUrl || 'http://127.0.0.1:3000/healthz',
  };
}
const CONFIG = loadConfig();

/* ---- 实例自述（两个实例的区分点） --------------------------------------------------------- */
async function readLocalHealth() {
  try {
    const r = await fetch(CONFIG.healthzUrl, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function instanceInfo(health) {
  return {
    id: CONFIG.instanceId,
    label: CONFIG.instanceLabel,
    healthzUrl: CONFIG.healthzUrl,
    app: health?.app ?? null,
    build: health?.build ?? null,
  };
}

/* ---- 公告与设置的持久化（各自独立，与实例 A 不同步） --------------------------------------- */
const ANN_FILE = path.join(DATA, 'announcements.json');
const SET_FILE = path.join(DATA, 'settings.json');

const GAME_ANN_MAX_TITLE = 120;
const GAME_ANN_MAX_PARAGRAPHS = 40;
const GAME_ANN_MAX_PARA_CHARS = 10000;
const GAME_ANN_MAX_TOTAL_CHARS = 200000;
const GAME_ANN_MAX_ENTRIES = 50;
const LEVELS = new Set(['info', 'warning', 'critical']);

function readAnnouncements() {
  try {
    const j = JSON.parse(readFileSync(ANN_FILE, 'utf8'));
    return { updatedAt: j?.updatedAt ?? null, entries: Array.isArray(j?.entries) ? j.entries : [] };
  } catch { return { updatedAt: null, entries: [] }; }
}
function writeAnnouncements(entries) {
  const doc = { updatedAt: new Date().toISOString(), entries };
  writeFileSync(ANN_FILE, JSON.stringify(doc));
  return doc;
}
function readSettings() {
  try {
    const j = JSON.parse(readFileSync(SET_FILE, 'utf8'));
    return { hotMods: j?.hotMods === true, updatedAt: j?.updatedAt ?? null, updatedBy: j?.updatedBy ?? null };
  } catch { return { hotMods: false, updatedAt: null, updatedBy: null }; }
}
function writeSettings(hotMods) {
  const doc = { hotMods, updatedAt: new Date().toISOString(), updatedBy: 'admin' };
  writeFileSync(SET_FILE, JSON.stringify(doc));
  return doc;
}

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
  const level = LEVELS.has(raw.level) ? raw.level : 'info';
  return { entry: { title, date, paragraphs, level } };
}

/* ---- HTTP 小工具 --------------------------------------------------------------------------- */
function json(res, status, payload, cacheControl = 'no-store') {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cacheControl,
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function bearerOk(req) {
  const expected = CONFIG.ingestToken;
  if (!expected) return false;
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return false;
  const got = Buffer.from(auth.slice(7));
  const exp = Buffer.from(expected);
  return got.length === exp.length && timingSafeEqual(got, exp);
}

/* ---- 静态资源（入口页 + 后台页） ------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};
function cacheControlFor(p) {
  if (p.startsWith('/fonts/')) return 'public, max-age=604800, immutable';
  if (p.startsWith('/css/') || p.startsWith('/js/')) return 'public, max-age=31536000, immutable';
  if (p.startsWith('/data/')) return 'public, max-age=300, stale-while-revalidate=3600';
  return 'public, max-age=0, must-revalidate';
}
function serveStatic(res, p) {
  // 防目录穿越
  let rel = p.replace(/^\/+/, '');
  if (rel.includes('..')) return false;
  let file = path.join(PUBLIC, rel);
  if (rel === '' || rel.endsWith('/')) file = path.join(PUBLIC, rel, 'index.html');
  if (!existsSync(file)) {
    // 无扩展名 → 追加 .html（/admin 就是靠这条命中的）
    if (!/\.[A-Za-z0-9]+$/.test(rel)) {
      const alt = path.join(PUBLIC, rel + '.html');
      if (existsSync(alt)) file = alt; else return false;
    } else return false;
  }
  const data = readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': cacheControlFor('/' + rel),
    'content-length': data.length,
  });
  res.end(data);
  return true;
}

/* ---- 路由 ----------------------------------------------------------------------------------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    if (p === '/healthz') {
      const health = await readLocalHealth();
      return json(res, 200, {
        ok: true,
        service: 'arknights-gateway',
        instance: instanceInfo(health),
        target: health ? { app: health.app ?? null, build: health.build ?? null } : null,
      });
    }

    if (p === '/api/status') {
      const health = await readLocalHealth();
      let channels = [];
      // 盒子实例：本机 healthz 就是权威数据，直接映射成一条通道记录
      if (health) {
        channels = [{
          id: 'box-local',
          name: CONFIG.instanceLabel,
          ok: true,
          viaBox: true,
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
        }];
      }
      return json(res, 200, {
        ok: true,
        updatedAt: Date.now(),
        channels,
        instance: instanceInfo(health),
        visitor: { country: null, region: null, city: null },
      }, 'public, max-age=5, s-maxage=15, stale-while-revalidate=30');
    }

    if (p === '/api/announcements/game') {
      const { entries } = readAnnouncements();
      return json(res, 200, entries, 'public, max-age=0, must-revalidate');
    }

    if (p === '/api/announcements/game/admin') {
      if (!(req.method === 'GET' || req.method === 'HEAD' || req.method === 'PUT')) {
        res.writeHead(405, { allow: 'GET, HEAD, PUT' }); return res.end();
      }
      if (!bearerOk(req)) return json(res, 401, { error: '未授权' });
      if (req.method === 'GET' || req.method === 'HEAD') {
        const { updatedAt, entries } = readAnnouncements();
        return json(res, 200, { ok: true, updatedAt, count: entries.length, entries });
      }
      let parsed;
      try { parsed = JSON.parse(await readBody(req, 65536)); } catch { return json(res, 400, { error: '不是合法 JSON' }); }
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : null;
      if (!list) return json(res, 400, { error: '需要一个数组，或 { entries: [...] }' });
      if (list.length > GAME_ANN_MAX_ENTRIES) return json(res, 400, { error: `最多 ${GAME_ANN_MAX_ENTRIES} 条` });
      const entries = [];
      let chars = 0;
      for (const [i, item] of list.entries()) {
        const r = normalizeAnnouncement(item);
        if (r.error) return json(res, 400, { error: `第 ${i + 1} 条：${r.error}` });
        chars += r.entry.title.length + r.entry.paragraphs.reduce((n, s) => n + s.length, 0);
        if (chars > GAME_ANN_MAX_TOTAL_CHARS) return json(res, 400, { error: '公告总量超过上限' });
        entries.push(r.entry);
      }
      const doc = writeAnnouncements(entries);
      return json(res, 200, { ok: true, updatedAt: doc.updatedAt, count: doc.entries.length });
    }

    if (p === '/api/settings/game') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        return json(res, 200, { ok: true, ...readSettings() }, 'public, max-age=0, must-revalidate');
      }
      if (req.method !== 'PUT') { res.writeHead(405, { allow: 'GET, HEAD, PUT' }); return res.end(); }
      if (!bearerOk(req)) return json(res, 401, { error: '未授权' });
      let body;
      try { body = JSON.parse(await readBody(req, 4096) || '{}'); } catch { return json(res, 400, { error: '请求体不是 JSON' }); }
      if (typeof body.hotMods !== 'boolean') return json(res, 400, { error: 'hotMods 必须是布尔值' });
      return json(res, 200, { ok: true, ...writeSettings(body.hotMods) });
    }

    // 静态：入口页、后台页、css/js/字体
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (serveStatic(res, p)) return;
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e?.message || e).slice(0, 200) });
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`[arknights-gateway] instance=${CONFIG.instanceId} (${CONFIG.instanceLabel}) listening on http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`[arknights-gateway] healthz=${CONFIG.healthzUrl} token=${CONFIG.ingestToken ? 'set' : 'MISSING'}`);
});