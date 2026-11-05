// box-admin/server.mjs — 盒子上跑的「arknights.jiangjiangze.icu/admin」最小服务（Node 24 stdlib，无依赖）。
//
// 范围（用户 2026-10-13 指令）：**仅 /admin**，**只读魔搭（ModelScope）那台游戏服的数据**；
// 不含另外三个服务器的数据（旧站的 probe/channels 面板不在本服务里）。
//
// 为什么在盒子上：站点原来的 CF Worker 已删、域名 NXDOMAIN；方舟网关的整体迁移（Deno/EdgeOne
// 评估）在另一条线上走。本服务是「admin-only 恢复」：盒子已有 Node 24 + 常驻隧道（wk-platform），
// 把 127.0.0.1:<port> 挂到 arknights.jiangjiangze.icu 即可让管理面和游戏服的公告拉取一起恢复。
//
// 对外面（与旧网关逐字段一致，别改形状）：
//   GET  /api/announcements/game        公开，裸数组（游戏服 SP_ANNOUNCEMENTS_URL 每 60s 拉的就是它）
//   GET  /api/announcements/game/admin  要 Bearer INGEST_TOKEN；回 { ok, updatedAt, count, entries }
//   PUT  /api/announcements/game/admin  整体替换（数组或 { entries }），与旧实现的校验常量一致
//   GET  /api/settings/game             公开只读 { ok, hotMods, updatedAt, updatedBy }
//   PUT  /api/settings/game             要 Bearer；body { hotMods: boolean }
//   GET  /api/game/status               要 Bearer；魔搭创空间的 health + commit/check-changed 快照
//   POST /api/game/redeploy             要 Bearer；占用不为 0 拒绝，否则 PUT reset_restart
//   GET  /admin                         管理页（自包含；令牌存 localStorage）
//   GET  /healthz                       { ok: true }
//
// 凭据只在本目录的 config.json（已 gitignore）或环境变量里，永不进 git：
//   { "ingestToken": "...", "msToken": "...", "port": 8910, "host": "127.0.0.1" }
//   env 覆盖：ARKADMIN_INGEST_TOKEN / ARKADMIN_MS_TOKEN / ARKADMIN_PORT / ARKADMIN_HOST

import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
mkdirSync(DATA, { recursive: true });

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { cfg = {}; }
  return {
    ingestToken: process.env.ARKADMIN_INGEST_TOKEN || cfg.ingestToken || '',
    msToken: process.env.ARKADMIN_MS_TOKEN || cfg.msToken || '',
    port: Number(process.env.ARKADMIN_PORT || cfg.port || 8910),
    host: process.env.ARKADMIN_HOST || cfg.host || '127.0.0.1',
  };
}
const CONFIG = loadConfig();

// ---- ModelScope（魔搭）那台游戏服 -------------------------------------------------------------------
const MS_NS = 'jingjiangze';
const MS_NAME = 'Stronghold-Protocol';
const MS_API = 'https://www.modelscope.cn/api/v1/studio';
/** 健康检查走 api-inference 专用域（ms.show 只认浏览器会话，脚本访问会被 403）。 */
const MS_HEALTH = 'https://studio-jingjiangze-stronghold-protocol.api-inference.modelscope.net/healthz';

async function msFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { authorization: `Bearer ${CONFIG.msToken}`, ...(init.headers || {}) }, signal: AbortSignal.timeout(15000) });
}

/** 管理页用的快照：health（占用/版本/开销）+ 平台侧提交对比。 */
async function gameStatus() {
  const out = { ok: true, health: null, deploy: null, settings: readSettings(), error: null };
  try {
    const r = await msFetch(MS_HEALTH);
    if (r.ok) {
      const h = await r.json();
      out.health = {
        app: h.app ?? null, build: h.build ?? null, uptimeSec: h.uptimeSec ?? null,
        rooms: h.rooms ?? 0, humans: h.humans ?? 0, matches: h.matches ?? 0, online: h.online ?? null,
        performance: h.performance ?? null,
      };
    } else out.error = `healthz ${r.status}`;
  } catch (e) { out.error = String(e?.message || e).slice(0, 160); }
  try {
    const r = await msFetch(`${MS_API}/${MS_NS}/${MS_NAME}/commit/check-changed`);
    if (r.ok) {
      const d = (await r.json())?.Data || {};
      out.deploy = { current: String(d.CurrentCommitId || '').slice(0, 8), deployed: String(d.LastDeployCommitId || '').slice(0, 8), changed: d.HasChanged === true };
    }
  } catch { /* 平台读不到不影响占用判断 */ }
  return out;
}

/** 一键重新部署：占用不为 0 就拒绝；否则 PUT reset_restart（2–4 分钟）。 */
async function redeploy() {
  if (!CONFIG.msToken) return { status: 503, body: { error: '未配置 MS 平台令牌（本服务 config.json 的 msToken）' } };
  let health;
  try {
    const r = await msFetch(MS_HEALTH);
    if (!r.ok) return { status: 502, body: { error: `读不到游戏服占用（healthz ${r.status}），先确认它在跑` } };
    health = await r.json();
  } catch (e) {
    return { status: 502, body: { error: '读不到游戏服占用（健康检查失败）: ' + String(e?.message || e).slice(0, 120) } };
  }
  const busy = { rooms: health.rooms ?? 0, humans: health.humans ?? 0, matches: health.matches ?? 0 };
  if (Number(busy.rooms) + Number(busy.humans) + Number(busy.matches) > 0) {
    return { status: 409, body: { error: '场上有局，重建会清空对局', busy } };
  }
  try {
    const r = await msFetch(`${MS_API}/${MS_NS}/${MS_NAME}/reset_restart`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ Path: MS_NS, Name: MS_NAME }),
    });
    let data = null; try { data = await r.json(); } catch { /* 平台可能给空体 */ }
    if (!r.ok || data?.Success === false) {
      return { status: 502, body: { error: `平台拒绝重建（HTTP ${r.status}）`, detail: String(data?.Message || '').slice(0, 160) } };
    }
    return { status: 200, body: { ok: true, message: '已触发重建，2–4 分钟后生效', triggeredAt: new Date().toISOString() } };
  } catch (e) {
    return { status: 502, body: { error: '触发重建失败: ' + String(e?.message || e).slice(0, 120) } };
  }
}

// ---- 公告（游戏服每 60s 拉的公告板） ---------------------------------------------------------------
const ANN_FILE = path.join(DATA, 'announcements.json');
const SET_FILE = path.join(DATA, 'settings.json');
const GAME_ANN_MAX_BYTES = 64 * 1024;
const GAME_ANN_MAX_ENTRIES = 50;
const GAME_ANN_MAX_TITLE = 120;
const GAME_ANN_MAX_PARAGRAPHS = 40;
const GAME_ANN_MAX_PARA_CHARS = 10000;
const GAME_ANN_MAX_TOTAL_CHARS = 200000;
const LEVELS = new Set(['info', 'warning', 'critical']);

function readAnnouncements() {
  try {
    const parsed = JSON.parse(readFileSync(ANN_FILE, 'utf8'));
    return { updatedAt: parsed.updatedAt || null, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch { return { updatedAt: null, entries: [] }; }
}
function writeAnnouncements(entries) {
  const doc = { updatedAt: new Date().toISOString(), entries };
  writeFileSync(ANN_FILE, JSON.stringify(doc, null, 1), 'utf8');
  return doc;
}
/** 与游戏服 parseAnnouncements() 的接受面一致（超限即无效内容）。 */
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

function readSettings() {
  try {
    const parsed = JSON.parse(readFileSync(SET_FILE, 'utf8'));
    return { hotMods: parsed.hotMods === true, updatedAt: parsed.updatedAt || null, updatedBy: parsed.updatedBy || null };
  } catch { return { hotMods: false, updatedAt: null, updatedBy: null }; }
}
function writeSettings(hotMods) {
  const next = { hotMods, updatedAt: new Date().toISOString(), updatedBy: 'admin' };
  writeFileSync(SET_FILE, JSON.stringify(next, null, 1), 'utf8');
  return next;
}

// ---- HTTP -------------------------------------------------------------------------------------------
const json = (res, status, payload, cache = 'no-store') => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, 'access-control-allow-origin': '*' });
  res.end(body);
};
const readBody = (req, limit = GAME_ANN_MAX_BYTES) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('内容过大')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});
function authorized(req) {
  if (!CONFIG.ingestToken) return false;
  const auth = req.headers.authorization || '';
  const expected = Buffer.from(`Bearer ${CONFIG.ingestToken}`);
  const got = Buffer.from(auth);
  return got.length === expected.length && timingSafeEqual(got, expected);
}
const bearerOnly = (req, res) => {
  if (!CONFIG.ingestToken) { json(res, 503, { error: '未配置 ingestToken（本服务 config.json）' }); return false; }
  if (!authorized(req)) { json(res, 401, { error: '未授权' }); return false; }
  return true;
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  // 访问日志（排障用：游戏服的 60s 公告拉取、admin 的写操作都会在这里留痕）
  console.log(`${new Date().toISOString()} ${req.method} ${p} ua=${String(req.headers['user-agent'] || '').slice(0, 60)}`);
  try {
    // 静态：管理页自包含
    if (p === '/' || p === '/admin' || p === '/admin/') {
      const html = readFileSync(path.join(ROOT, 'admin.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (p === '/healthz') return json(res, 200, { ok: true, service: 'ark-admin', scope: 'modelscope-only' });

    // 公告：公开读（游戏服 60s 拉取的就是这条）
    if (p === '/api/announcements/game') {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); return res.end(); }
      const { entries } = readAnnouncements();
      return json(res, 200, entries, 'public, max-age=0, must-revalidate');
    }
    // 公告：管理读写
    if (p === '/api/announcements/game/admin') {
      if (!(req.method === 'GET' || req.method === 'HEAD' || req.method === 'PUT')) { res.writeHead(405, { allow: 'GET, HEAD, PUT' }); return res.end(); }
      const auth = req.headers.authorization || '';
      const expected = CONFIG.ingestToken ? `Bearer ${CONFIG.ingestToken}` : null;
      if (!expected) return json(res, 503, { error: '未配置 ingestToken' });
      const ok = auth.length === expected.length && timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
      if (!ok) return json(res, 401, { error: '未授权' });
      if (req.method === 'GET' || req.method === 'HEAD') {
        const { updatedAt, entries } = readAnnouncements();
        return json(res, 200, { ok: true, updatedAt, count: entries.length, entries });
      }
      const raw = await readBody(req);
      let parsed; try { parsed = JSON.parse(raw); } catch { return json(res, 400, { error: '不是合法 JSON' }); }
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : null;
      if (!list) return json(res, 400, { error: '需要一个数组，或 { entries: [...] }' });
      if (list.length > GAME_ANN_MAX_ENTRIES) return json(res, 400, { error: `最多 ${GAME_ANN_MAX_ENTRIES} 条` });
      const entries = []; let chars = 0;
      for (const [i, item] of list.entries()) {
        const r = normalizeAnnouncement(item);
        if (r.error) return json(res, 400, { error: `第 ${i + 1} 条：${r.error}` });
        chars += r.entry.title.length + r.entry.paragraphs.reduce((n, x) => n + x.length, 0);
        if (chars > GAME_ANN_MAX_TOTAL_CHARS) return json(res, 400, { error: '公告总量超过上限' });
        entries.push(r.entry);
      }
      const doc = writeAnnouncements(entries);
      return json(res, 200, { ok: true, updatedAt: doc.updatedAt, count: entries.length });
    }

    // 游戏服开关（热载）：公开读，写要令牌
    if (p === '/api/settings/game') {
      if (req.method === 'GET' || req.method === 'HEAD') return json(res, 200, { ok: true, ...readSettings() });
      if (req.method !== 'PUT') { res.writeHead(405, { allow: 'GET, HEAD, PUT' }); return res.end(); }
      if (!bearerOnly(req, res)) return;
      let body; try { body = JSON.parse(await readBody(req, 4096) || '{}'); } catch { return json(res, 400, { error: '请求体不是 JSON' }); }
      if (typeof body.hotMods !== 'boolean') return json(res, 400, { error: 'hotMods 必须是布尔值' });
      return json(res, 200, { ok: true, ...writeSettings(body.hotMods) });
    }

    // 魔搭游戏服：状态 / 一键重新部署
    if (p === '/api/game/status') {
      if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); return res.end(); }
      if (!bearerOnly(req, res)) return;
      if (!CONFIG.msToken) return json(res, 503, { error: '未配置 MS 平台令牌（本服务 config.json 的 msToken）' });
      return json(res, 200, await gameStatus());
    }
    if (p === '/api/game/redeploy') {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
      if (!bearerOnly(req, res)) return;
      const r = await redeploy();
      return json(res, r.status, r.body);
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e?.message || e).slice(0, 200) });
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`[ark-admin] listening on http://${CONFIG.host}:${CONFIG.port} — scope: ModelScope game server only`);
  console.log(`[ark-admin] tokens: ingest=${CONFIG.ingestToken ? 'set' : 'MISSING'} ms=${CONFIG.msToken ? 'set' : 'MISSING'}`);
});
