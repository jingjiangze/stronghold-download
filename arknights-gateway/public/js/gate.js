/* ==========================================================================================
   gate.js — 三通道入口页的交互。

   两条数据流：
   - /api/status —— 服务器实时数值（在线/人数/房间/运行时长/内存/CPU）与访客地区。
     数值由盒子（服务器本机）每 5 分钟回传，Worker 只转发；访客地区由 Cloudflare 按访问 IP 给出。
   - 延迟 = **玩家浏览器自主探测**：对每条通道的 origin 做 no-cors 连接计时（取 3 次中位数）。
     这是玩家自己网络到该通道的真实往返，不再依赖任何公开探测服务（2026-10-09 改）。

   「重复内容合并」：三条通道指向同一台游戏服，所以通道卡只放「这条路径的状态 + 延迟」；
   人数/房间/运行时长/内存/CPU 这些服务器级数值只在「我的服务器」里出现一份。
   ========================================================================================== */
import { initNotices } from './notices.js';

const POLL_MS = 15000;
const LATENCY_SAMPLES = 3;          // 每条通道测 3 次取中位数
const LATENCY_GAP_MS = 900;         // 两次之间的间隔
const LATENCY_TIMEOUT_MS = 8000;    // 单次超时：超过就算不通

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

let channels = [];
const statusById = new Map();
// 玩家自测延迟：channelId -> { ms: number|null, fail: boolean }
const latencyById = new Map();
let visitorRegion = null;

/* ---- 玩家自主延迟探测 ---------------------------------------------------------------------- */
/**
 * 对通道 origin 做一次 no-cors 请求并计时。
 * - no-cors：响应是不透明的（读不到内容），但**连接成功与否、耗时**都能测到 —— 这正是我们要的。
 * - cache:'no-store'：每次都是真实往返，不吃浏览器缓存。
 * - 查询串塞随机数：绕开任何中间层缓存。
 * - 自签名证书的隧道（山东那条）：浏览器 TLS 握手会失败 → 如实标「需先接受证书」，
 *   玩家点「进入游戏」接受一次证书后，这里就能测到了。
 */
async function probeOnce(origin) {
  const url = `${origin}/healthz?_p=${Math.random().toString(36).slice(2)}`;
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LATENCY_TIMEOUT_MS);
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    return { ms: Math.round(performance.now() - started) };
  } catch {
    return { ms: null };
  } finally {
    clearTimeout(timer);
  }
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function probeChannelLatency(channel) {
  const samples = [];
  for (let i = 0; i < LATENCY_SAMPLES; i += 1) {
    if (document.hidden) return;                 // 页面切走了就停，别在后台耗玩家流量
    const result = await probeOnce(channel.origin);
    if (result.ms !== null) samples.push(result.ms);
    if (i < LATENCY_SAMPLES - 1) await new Promise((r) => setTimeout(r, LATENCY_GAP_MS));
  }
  latencyById.set(channel.id, { ms: samples.length ? median(samples) : null, fail: samples.length === 0 });
  applyStatus();
}

function startLatencyProbes() {
  for (const channel of channels) {
    void probeChannelLatency(channel);
  }
}

/* ---- 通道卡片 ------------------------------------------------------------------------------ */
function buildCard(channel) {
  const card = el('article', 'panel channel-card');
  card.dataset.channel = channel.id;

  const head = el('div', 'channel-head');
  const title = el('div', 'channel-title');
  const dot = el('span', 'channel-dot');
  dot.dataset.state = 'pending';
  dot.setAttribute('aria-hidden', 'true');
  title.append(dot, el('h3', null, channel.name), el('span', `channel-tag${channel.tier === 'primary' ? ' channel-tag--primary' : ''}`, channel.tag));
  // 地域徽标：这条通道是给哪个方向的玩家用的（山东 / 湖南 / 海外）
  if (channel.region?.label) {
    const badge = el('span', 'channel-region', channel.region.label);
    badge.title = `${channel.region.label}方向的入口`;
    title.append(badge);
  }
  const state = el('span', 'channel-state', '探测中');
  state.dataset.state = 'pending';
  state.dataset.field = 'state';
  head.append(title, state);

  // 通道卡只放「这条路径」的信息：你的延迟 + 服务器状态。
  // 人数/房间/运行时长是服务器级的（三条通道同一份），统一放「我的服务器」，不在这里重复。
  const metrics = el('dl', 'channel-metrics');
  const latencyCell = el('div');
  const latencyDd = el('dd', 'num', '—');
  latencyDd.dataset.field = 'latency';
  latencyCell.append(el('dt', null, '你的延迟'), latencyDd);
  const statusCell = el('div');
  const statusDd = el('dd', 'num', '—');
  statusDd.dataset.field = 'serverState';
  statusCell.append(el('dt', null, '服务器'), statusDd);
  metrics.append(latencyCell, statusCell);

  const url = el('p', 'channel-url num', channel.host + (new URL(channel.origin).port ? ':' + new URL(channel.origin).port : ''));
  const note = el('p', 'channel-note', channel.note);
  const warn = el('p', 'channel-warn');
  warn.dataset.field = 'warn';
  warn.hidden = true;

  const actions = el('div', 'channel-actions');
  const enter = el('a', `btn ${channel.tier === 'primary' ? 'btn--primary' : 'btn--secondary'}`, '进入游戏');
  enter.href = channel.origin + '/';
  enter.target = '_blank';
  enter.rel = 'noopener noreferrer';
  enter.referrerPolicy = 'no-referrer';
  const copy = el('button', 'btn btn--ghost', '复制链接');
  copy.type = 'button';
  copy.addEventListener('click', () => copyText(enter.href, copy));
  actions.append(enter, copy);

  card.append(head, metrics, url, note, warn, actions);
  return card;
}

function renderChannels() {
  const grid = $('channelGrid');
  grid.replaceChildren(...channels.map(buildCard));
  grid.setAttribute('aria-busy', 'false');
}

/* ---- 渲染 ---------------------------------------------------------------------------------- */
function formatUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 时`;
  if (h > 0) return `${h} 时 ${m} 分`;
  return `${m} 分`;
}

function setField(card, field, value) {
  const node = card.querySelector(`[data-field="${field}"]`);
  if (node) node.textContent = value;
}

function applyStatus() {
  for (const channel of channels) {
    const card = $('channelGrid').querySelector(`[data-channel="${channel.id}"]`);
    if (!card) continue;
    const s = statusById.get(channel.id);
    const lat = latencyById.get(channel.id);

    // 服务器状态（同一台服，三条通道一致；来自盒子本机回传）
    let state = 'down';
    let label = '不可达';
    if (!s) {
      state = 'pending';
      label = '探测中';
    } else if (s.skipped) {
      state = 'warn';
      label = '状态未取';
    } else if (s.ok) {
      state = 'up';
      label = '在线';
    } else if (s.error) {
      state = 'warn';
      label = '探测失败';
    }
    const dot = card.querySelector('.channel-dot');
    const stateNode = card.querySelector('[data-field="state"]');
    dot.dataset.state = state;
    stateNode.dataset.state = state;
    stateNode.textContent = label;
    setField(card, 'serverState', s && s.ok ? '在线' : '—');
    card.title = s && s.error ? s.error : '';

    // 玩家自测延迟
    const latencyNode = card.querySelector('[data-field="latency"]');
    if (!lat) {
      latencyNode.textContent = '测量中…';
      latencyNode.title = '正在从你的网络实测到这条通道的往返延迟';
    } else if (lat.ms !== null) {
      latencyNode.textContent = `${lat.ms} ms`;
      latencyNode.title = '从你的设备到这条通道的实测往返（含 HTTPS 握手，3 次取中位数）';
    } else {
      latencyNode.textContent = '不通';
      latencyNode.title = '你的浏览器连不上这条通道';
    }

    const warn = card.querySelector('[data-field="warn"]');
    if (lat && lat.fail && channel.cert === 'self-signed') {
      warn.textContent = '这条隧道是自签名证书：先点「进入游戏」在浏览器里接受一次证书，'
        + '回到本页就能测到延迟。';
      warn.hidden = false;
    } else if (lat && lat.fail) {
      warn.textContent = '你的网络暂时连不上这条通道，换一条试试。';
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
  }
  applyOverview();
  applyServerStats();
}

/* ---- 我的服务器（数值只在这里出现一份，不在三张通道卡上重复） -------------------------------- */
const SERVER_STAT_FIELDS = [
  ['srvHumans', 'humans'],
  ['srvSessions', 'sessions'],
  ['srvRooms', 'rooms'],
  ['srvMatches', 'matches'],
  ['srvSockets', 'sockets'],
  ['srvUptime', 'uptimeSec'],
  ['srvMem', 'memRssMb'],
  ['srvCpu', 'cpuPct'],
];

function applyServerStats() {
  const box = $('serverStats');
  if (!box) return;

  // 三条通道同一台服：取在线通道里最新鲜的一份。
  let stats = null;
  for (const channel of channels) {
    const s = statusById.get(channel.id);
    if (s && s.ok && (!stats || (s.probeAgeSec ?? 1e9) < (stats.probeAgeSec ?? 1e9))) stats = s;
  }

  if (!stats) {
    for (const [field] of SERVER_STAT_FIELDS) {
      const node = box.querySelector(`[data-field="${field}"]`);
      if (node) node.textContent = '—';
    }
    const sub = $('serverStatsSub');
    if (sub) sub.textContent = '等待首次探测…';
    return;
  }

  for (const [field, key] of SERVER_STAT_FIELDS) {
    const node = box.querySelector(`[data-field="${field}"]`);
    if (!node) continue;
    const raw = stats[key];
    if (key === 'uptimeSec') node.textContent = formatUptime(raw);
    else if (key === 'memRssMb') node.textContent = Number.isFinite(raw) ? `${raw.toLocaleString('zh-CN')} MB` : '—';
    else if (key === 'cpuPct') node.textContent = Number.isFinite(raw) ? `${raw} %` : '—';
    else node.textContent = Number.isFinite(raw) ? raw.toLocaleString('zh-CN') : '—';
  }

  const sub = $('serverStatsSub');
  if (sub) {
    const parts = [];
    if (stats.app) parts.push(`APP ${stats.app}`);
    if (stats.build) parts.push(`build ${stats.build}`);
    if (Number.isFinite(stats.probeAgeSec)) parts.push(`采集于 ${Math.round(stats.probeAgeSec / 60) || 0} 分钟内`);
    sub.textContent = parts.join(' · ');
  }
}

/* ---- 概览（hero） -------------------------------------------------------------------------- */
function applyOverview() {
  let humans = null;
  let matches = null;
  for (const channel of channels) {
    const s = statusById.get(channel.id);
    if (s && s.ok) {
      humans = s.humans;
      matches = s.matches;
      break;
    }
  }
  const up = channels.filter((c) => statusById.get(c.id)?.ok).length;
  $('statChannels').textContent = channels.length ? `${up}/${channels.length}` : '—';
  $('statPlayers').textContent = humans !== null ? String(humans) : '—';
  $('statRooms').textContent = matches !== null ? String(matches) : '—';

  // 你所在地区延迟 = 主通道的自测值（玩家自己的网络，不是别的地域探测点的）。
  const primary = channels.find((channel) => channel.tier === 'primary') || channels[0];
  const lat = primary ? latencyById.get(primary.id) : null;
  $('statRegion').textContent = lat && lat.ms !== null ? String(lat.ms) : '—';

  const meta = $('baselineMeta');
  if (meta) {
    const parts = [];
    if (visitorRegion) {
      parts.push(`你的地区：${visitorRegion}（按访问 IP）`);
    }
    if (lat && lat.ms !== null) {
      parts.push(`主通道自你网络的实测延迟 ${lat.ms} ms`);
    } else if (lat) {
      parts.push('主通道自测未通过');
    } else {
      parts.push('正在从你的网络实测各通道延迟…');
    }
    meta.textContent = `${parts.join(' · ')} · 延迟由你的浏览器实测，不再依赖公开探测服务`;
    meta.hidden = false;
  }
}

/* ---- 数据轮询 ------------------------------------------------------------------------------ */
async function loadStatus() {
  try {
    const res = await fetch('./api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    statusById.clear();
    for (const item of data.channels || []) statusById.set(item.id, item);
    if (data.visitor) {
      const names = {
        CN: '中国大陆', HK: '中国香港', TW: '中国台湾', JP: '日本', KR: '韩国', SG: '新加坡',
        US: '美国', CA: '加拿大', DE: '德国', GB: '英国', FR: '法国', AU: '澳大利亚',
      };
      const country = data.visitor.country ? names[data.visitor.country] || data.visitor.country : null;
      visitorRegion = [country, data.visitor.city].filter(Boolean).join(' ');
    }
    const note = $('statusNote');
    if (note) note.textContent = `状态每 ${POLL_MS / 1000} 秒刷新 · 最后同步 ${new Date().toLocaleTimeString('zh-CN')}`;
  } catch {
    const note = $('statusNote');
    if (note) note.textContent = '状态读取失败，稍后自动重试';
  }
  applyStatus();
}

let pollTimer = null;
let latencyTimer = null;
const stopPoll = () => { clearInterval(pollTimer); pollTimer = null; };
const startPoll = () => {
  if (pollTimer !== null) return;
  void loadStatus();
  pollTimer = setInterval(loadStatus, POLL_MS);
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPoll();
    clearInterval(latencyTimer);
    latencyTimer = null;
  } else {
    startPoll();
    if (latencyTimer === null) latencyTimer = setInterval(startLatencyProbes, 5 * 60 * 1000);
    startLatencyProbes();
  }
});

/* ---- 复制 ---------------------------------------------------------------------------------- */
async function copyText(text, button) {
  const original = button.textContent;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    button.textContent = '已复制';
  } catch {
    button.textContent = '复制失败';
  }
  setTimeout(() => { button.textContent = original; }, 1600);
}

/* ---- 顶栏导航高亮（同 rainya 的 mountNavigation） ------------------------------------------ */
function mountNavigation() {
  const links = [...document.querySelectorAll('.navigation a')];
  const sections = links.map((link) => document.querySelector(link.getAttribute('href')));
  const topbar = document.querySelector('.gk-topbar');
  let frame = null;
  const update = () => {
    frame = null;
    const edge = topbar.getBoundingClientRect().bottom + 48;
    let current = 0;
    sections.forEach((section, index) => {
      if (section && section.getBoundingClientRect().top <= edge) current = index;
    });
    if (window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
      current = links.length - 1;
    }
    links.forEach((link, index) => {
      if (index === current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  };
  const schedule = () => { if (frame === null) frame = requestAnimationFrame(update); };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(document.querySelector('main'));
  schedule();
}

/* ---- 线上大厅（只读代理本站 /api/lobby → 房间牌 Worker） -------------------------------------- */
const LOBBY_POLL_MS = 20000;
let lobbyTimer = null;

// 玩家点「加入房间」：先挑出通的那几条通道里延迟最低的，带上房间码跳过去。
// 三通道是同一台服，区别只在网络路径；房间码格式对所有通道一致（?room=CODE）。
function bestChannelForJoin() {
  let best = null;
  for (const channel of channels) {
    const s = statusById.get(channel.id);
    if (!s || !s.ok) continue;                       // 不通的通道直接跳过
    const lat = latencyById.get(channel.id);
    const ms = lat && lat.ms != null ? lat.ms : Infinity;
    if (!best || ms < best.ms) best = { channel, ms };
  }
  return best ? best.channel : (channels[0] || null);
}

function joinRoom(code) {
  const channel = bestChannelForJoin();
  if (!channel) return;
  const url = `${channel.origin}/?room=${encodeURIComponent(code)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

// 没房间时也能先进游戏：同样挑最快通道，不带房间码。
function quickEnter() {
  const channel = bestChannelForJoin();
  if (!channel) return;
  window.open(`${channel.origin}/`, '_blank', 'noopener,noreferrer');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderLobby(rooms) {
  const list = $('lobbyList');
  if (!list) return;
  list.setAttribute('aria-busy', 'false');
  if (!rooms.length) {
    list.replaceChildren(el('p', 'lobby-empty', '当前没有开放的房间。先进游戏开一个，把房间码发给队友即可。'));
    return;
  }
  const rows = rooms.map((room) => {
    const card = el('article', 'lobby-card');
    const head = el('div', 'lobby-card-head');
    const title = el('div', 'lobby-card-title');
    const code = el('span', 'lobby-code', room.code);
    const name = el('span', 'lobby-name', room.serverName || room.note || '');
    title.append(code, name);
    head.append(title);
    if (room.difficulty || room.status) {
      const badge = el('span', 'lobby-badge', [room.difficulty, room.status].filter(Boolean).join(' · '));
      head.append(badge);
    }
    const meta = el('div', 'lobby-card-meta');
    const parts = [];
    if (room.occupied != null && room.capacity != null) parts.push(`人数 ${room.occupied}/${room.capacity}`);
    if (room.leftSec != null) parts.push(`剩 ${room.leftSec}s`);
    meta.textContent = parts.join(' · ') || '等待中';
    const actions = el('div', 'lobby-card-actions');
    const join = el('button', 'btn btn--primary', '加入');
    join.type = 'button';
    join.addEventListener('click', () => joinRoom(room.code));
    actions.append(join);
    card.append(head, meta, actions);
    return card;
  });
  list.replaceChildren(...rows);
}

async function loadLobby() {
  const note = $('lobbyNote');
  try {
    const res = await fetch('./api/lobby', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rooms = Array.isArray(data.rooms) ? data.rooms : [];
    renderLobby(rooms);
    if (note) note.textContent = data.error
      ? `房间牌暂不可达（${rooms.length} 个本地缓存房间）`
      : `房间列表每 ${LOBBY_POLL_MS / 1000} 秒刷新`;
  } catch {
    const list = $('lobbyList');
    if (list) {
      list.setAttribute('aria-busy', 'false');
      if (!list.children.length) list.replaceChildren(el('p', 'lobby-empty', '房间列表读取失败，稍后自动重试。'));
    }
    if (note) note.textContent = '房间列表读取失败，稍后自动重试';
  }
}

/* ---- bug 反馈提交（同源 /api/feedback，表单含描述 + 可选截图） ----------------------------- */
function mountFeedbackForm() {
  const form = $('feedbackForm');
  if (!form) return;
  const status = $('fbStatus');
  const submit = $('fbSubmit');
  const desc = $('fbDesc');
  if (!status || !submit || !desc) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = (desc.value || '').trim();
    if (text.length < 5) {
      status.textContent = '请填写具体遇到的问题（至少 5 个字）';
      status.dataset.state = 'err';
      desc.focus();
      return;
    }
    submit.disabled = true;
    status.dataset.state = '';
    status.textContent = '正在提交…';
    try {
      const payload = new FormData(form);
      const res = await fetch('./api/feedback', { method: 'POST', body: payload });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `提交失败（HTTP ${res.status}）`);
      }
      status.dataset.state = 'ok';
      status.textContent = '已收到，谢谢反馈！我们会尽快查看。';
      form.reset();
    } catch (err) {
      status.dataset.state = 'err';
      status.textContent = err.message || '提交失败，请稍后重试';
    } finally {
      submit.disabled = false;
    }
  });
}

/* ---- 启动 ---------------------------------------------------------------------------------- */
async function main() {
  mountNavigation();
  initNotices();
  mountFeedbackForm();
  try {
    const res = await fetch('./data/channels.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    channels = Array.isArray(data.channels) ? data.channels : [];
  } catch {
    channels = [];
  }
  if (channels.length === 0) {
    const grid = $('channelGrid');
    grid.replaceChildren(el('p', 'channel-hint', '通道清单读取失败，请刷新页面重试。'));
    grid.setAttribute('aria-busy', 'false');
    return;
  }
  renderChannels();
  startPoll();
  startLatencyProbes();
  latencyTimer = setInterval(() => {
    if (!document.hidden) startLatencyProbes();
  }, 5 * 60 * 1000);

  // 线上大厅：首屏拉一次，之后定时刷新（切后台停）。
  await loadLobby();
  const startLobby = () => {
    if (lobbyTimer != null) return;
    void loadLobby();
    lobbyTimer = setInterval(loadLobby, LOBBY_POLL_MS);
  };
  const stopLobby = () => { clearInterval(lobbyTimer); lobbyTimer = null; };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopLobby();
    else startLobby();
  });
  startLobby();
}

void main();
