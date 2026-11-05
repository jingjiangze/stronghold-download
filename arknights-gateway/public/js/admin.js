/* ==========================================================================================
   admin.js — 服务器后台：实时状态 + 游戏服公告管理。

   两件事，各自独立、互不阻塞：
   1. 状态表：GET /api/status，把接口能返回的字段**全部**列出来（按通道分列）。
      字段表是手写清单而不是遍历 JSON —— 遍历会漏掉「本次恰好是 null 的字段」，
      而这里的目的正是让人看清有哪些字段、各自现在是什么值。
   2. 公告：PUT /api/announcements/game/admin（Bearer 令牌）整体替换，游戏服 60 秒内自动拉取。

   令牌只留在内存里：不写 localStorage，不拼进 URL，刷新即失效。

   页面逻辑（2026-10-12 重排，解决旧版「登录和编辑是两个框、刷新就丢草稿」的问题）：
   - 公告区只有**一个** DOM 容器，靠 hidden 切换登录态 / 编辑态，不再两套结构来回换；
   - 草稿按通道存 localStorage（不含令牌），刷新页面后仍在，只提示「未发布」；
   - 状态轮询在页面隐藏时暂停（visibilitychange），切回来立即补一次，不做无用请求。
   ========================================================================================== */

/** /api/status 每个通道的全部字段：键 → [标签, 格式化, 健康度]。与 Worker 的 probeChannel() 一一对应。 */
const FIELDS = [
  ['ok', '可达', (v) => (v ? '是' : '否'), (v) => (v ? 'ok' : 'bad')],
  ['id', '通道 id', (v) => v ?? '—'],
  ['name', '名称', (v) => v ?? '—'],
  ['viaBox', '数值来源', (v) => (v ? '服务器本机回传' : '—')],
  ['probeAgeSec', '回传距今（秒）', (v) => (v == null ? '—' : String(v))],
  ['app', '版本 app', (v) => v ?? '—'],
  ['build', '构建 build', (v) => v ?? '—'],
  ['uptimeSec', '运行时长', (v) => (v == null ? '—' : formatDuration(v))],
  ['humans', '真人玩家', (v) => num(v)],
  ['bots', 'AI 玩家', (v) => num(v)],
  ['sessions', '会话数', (v) => num(v)],
  ['sockets', '连接数', (v) => num(v)],
  ['rooms', '房间数', (v) => num(v)],
  ['matches', '进行中对局', (v) => num(v)],
  ['spectators', '观战者', (v) => num(v)],
  ['memRssMb', '内存 RSS（MB）', (v) => (v == null ? '—' : String(v))],
  ['cpuPct', 'CPU（%）', (v) => (v == null ? '—' : String(v))],
  ['skipped', '本次跳过', (v) => (v ? '是' : '否')],
  ['error', '错误', (v) => (v ?? '（无）'), (v) => (v ? 'bad' : '')],
];

const num = (v) => (v == null ? '—' : String(v));

function formatDuration(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 0) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d} 天`);
  if (h) parts.push(`${h} 小时`);
  parts.push(`${m} 分`);
  return parts.join(' ');
}

const $ = (id) => document.getElementById(id);
const text = (el, v) => { if (el) el.textContent = v; };
const when = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—');

/* ---- 状态表 ------------------------------------------------------------------------------- */

let statusTimer = null;

async function loadStatus() {
  const pill = $('status-pill');
  try {
    const res = await fetch('/api/status', { headers: { accept: 'application/json' } });
    const data = await res.json();
    const channels = Array.isArray(data.channels) ? data.channels : [];
    renderCards(channels);
    text($('status-updated'), `更新于 ${when(data.updatedAt)}`);
    const v = data.visitor || {};
    text($('status-visitor'), `访客 ${[v.country, v.region, v.city].filter(Boolean).join(' / ') || '—'}`);

    // 实例标识：告诉操作者当前这台后台对应哪台游戏服（同一域名下有两个独立实例）。
    const badge = $('instance-badge');
    const inst = data.instance;
    if (badge && inst) {
      badge.hidden = false;
      text($('instance-chip'), inst.label || inst.id || '—');
      const parts = [];
      if (inst.id) parts.push(`实例 ${inst.id}`);
      if (inst.app) parts.push(`app ${inst.app}`);
      if (inst.build) parts.push(`build ${String(inst.build).slice(0, 8)}`);
      if (inst.healthzUrl) parts.push(`数据源 ${inst.healthzUrl}`);
      text($('instance-detail'), parts.join(' · '));
    }

    const online = channels.filter((c) => c?.ok).length;
    text($('hero-channels'), `${online}/${channels.length}`);
    text($('hero-humans'), num(channels.reduce((s, c) => s + (c?.humans || 0), 0)));
    text($('hero-matches'), num(channels.reduce((s, c) => s + (c?.matches || 0), 0)));

    pill.textContent = data.ok ? `${online} / ${channels.length} 在线` : '接口报错';
    pill.dataset.state = data.ok ? 'ok' : 'err';
    const note = $('status-note');
    note.textContent = data.ok
      ? `共 ${channels.length} 条通道，每 15 秒自动刷新`
      : '接口返回 ok=false，数值可能不是最新的';
    note.dataset.state = data.ok ? 'ok' : 'err';
  } catch (err) {
    // 失败时保留上一次的表不清空 —— 刷掉整张表会让「网络抖一下」看起来像服务全挂了。
    pill.textContent = '读取失败';
    pill.dataset.state = 'err';
    const note = $('status-note');
    note.textContent = String(err?.message || err);
    note.dataset.state = 'err';
  }
}

/** 卡片式实时状态：一张卡 = 一台服务器；卡面给关键数值，展开后列出全部字段。
    字段清单是手写的（不遍历 JSON），这样「本次恰好为空的字段」也不会被漏掉。 */
function renderCards(channels) {
  const wrap = $('status-cards');
  if (!wrap) return;
  if (!channels.length) {
    wrap.replaceChildren(mk('p', 'spad-empty', '接口没有返回任何通道。'));
    return;
  }
  wrap.replaceChildren(...channels.map(buildStatusCard));
}

function buildStatusCard(ch) {
  const online = Boolean(ch?.ok);
  const card = mk('article', 'panel spad-card');
  card.dataset.online = online ? '1' : '0';

  // 卡头：状态点 + 名称 + 状态胶囊
  const head = mk('div', 'spad-card-head');
  const dot = mk('span', 'spad-dot');
  dot.dataset.state = online ? 'up' : (ch?.skipped ? 'idle' : 'down');
  dot.setAttribute('aria-hidden', 'true');
  const name = mk('h3', 'spad-card-name', ch?.name || ch?.id || '通道');
  const pill = mk('span', 'spad-state', online ? '在线' : (ch?.skipped ? '不探' : '离线'));
  pill.dataset.state = online ? 'up' : (ch?.skipped ? 'idle' : 'down');
  head.append(dot, name, pill);
  card.append(head);

  // 关键数值（卡面）：只放运维最常看的几项，其余在「全部字段」里
  const KEY = [
    ['humans', '真人玩家'],
    ['rooms', '房间'],
    ['matches', '对局'],
    ['uptimeSec', '运行时长', (v) => (v == null ? '—' : formatDuration(v))],
  ];
  const grid = mk('dl', 'spad-metrics');
  for (const [key, label, fmt] of KEY) {
    const cell = mk('div');
    cell.append(mk('dt', null, label), mk('dd', 'num', (fmt || num)(ch?.[key])));
    grid.append(cell);
  }
  card.append(grid);

  // 身份行：app / build（两个实例靠这两个值天然区分）
  const ident = mk('p', 'spad-ident micro');
  ident.textContent = `app ${ch?.app ?? '—'} · build ${ch?.build ? String(ch.build).slice(0, 12) : '—'}`;
  card.append(ident);

  // 全部字段（默认折叠）
  const details = mk('details', 'spad-fields');
  const sum = mk('summary', null, `全部字段（${FIELDS.length}）`);
  const dl = mk('dl', 'spad-fields-list');
  for (const [key, label, fmt, tone] of FIELDS) {
    const row = mk('div', 'spad-field-row');
    row.append(mk('dt', null, `${label} · ${key}`));
    const dd = mk('dd', 'num', fmt(ch?.[key]));
    const t = tone?.(ch?.[key]);
    if (t) dd.dataset.tone = t;
    row.append(dd);
    dl.append(row);
  }
  details.append(sum, dl);
  card.append(details);

  return card;
}

function mk(tag, cls, textContent) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (textContent != null) node.textContent = textContent;
  return node;
}

/** 页面隐藏时停轮询，切回来立刻补一次（省请求，也避免回到页面看到一片陈旧读数）。 */
function startPolling() {
  if (statusTimer) return;
  loadStatus();
  statusTimer = window.setInterval(loadStatus, 15_000);
}
function stopPolling() {
  window.clearInterval(statusTimer);
  statusTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else startPolling();
});

/* ---- 公告管理 ----------------------------------------------------------------------------- */

/** 令牌只在内存里，页面一刷新就没了（不落 localStorage、不进 URL）。 */
let token = '';
let entries = [];
let dirty = false;

const DRAFT_KEY = 'gk-announcement-draft-v1';

const authHeaders = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ entries, savedAt: Date.now() }));
  } catch { /* 隐私模式下 localStorage 会抛错，草稿存不了不影响正式功能 */ }
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return Array.isArray(obj?.entries) ? obj : null;
  } catch { return null; }
}

async function adminGet() {
  const res = await fetch('/api/announcements/game/admin', { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('令牌无效');
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function adminPut(list) {
  const res = await fetch('/api/announcements/game/admin', {
    method: 'PUT', headers: authHeaders(), body: JSON.stringify(list),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('令牌无效');
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function renderList() {
  const list = $('ann-list');
  list.replaceChildren();
  entries.forEach((entry, i) => {
    const li = document.createElement('li');
    li.className = 'gk-card';

    const head = document.createElement('div');
    head.className = 'gk-card-head';

    const idx = document.createElement('span');
    idx.className = 'gk-card-idx micro';
    idx.textContent = `#${i + 1}`;
    head.appendChild(idx);

    const title = document.createElement('input');
    title.className = 'gk-input gk-input--title';
    title.type = 'text';
    title.placeholder = '标题';
    title.value = entry.title || '';
    title.addEventListener('input', () => { entry.title = title.value; markDirty(); });
    head.appendChild(title);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn--danger';
    del.textContent = '删除';
    // 用 indexOf 而不是闭包里的 i —— 删掉上面一条后下面的按钮不会错位删错
    del.addEventListener('click', () => {
      entries.splice(entries.indexOf(entry), 1);
      markDirty();
      renderList();
    });
    head.appendChild(del);
    li.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'gk-row';

    const date = document.createElement('input');
    date.className = 'gk-input gk-input--date';
    date.type = 'text';
    date.placeholder = '日期（可留空）';
    date.value = entry.date || '';
    date.addEventListener('input', () => { entry.date = date.value; markDirty(); });
    meta.appendChild(date);

    const level = document.createElement('select');
    level.className = 'gk-input gk-input--level';
    for (const v of ['info', 'warning', 'critical']) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = { info: '普通', warning: '维护提醒', critical: '重要' }[v];
      if ((entry.level || 'info') === v) opt.selected = true;
      level.appendChild(opt);
    }
    level.addEventListener('change', () => { entry.level = level.value; markDirty(); });
    meta.appendChild(level);
    li.appendChild(meta);

    const body = document.createElement('textarea');
    body.className = 'gk-input gk-input--body';
    body.rows = 4;
    body.placeholder = '正文：一段一行，空行分段';
    body.value = (entry.paragraphs || []).join('\n\n');
    body.addEventListener('input', () => {
      entry.paragraphs = body.value.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
      markDirty();
    });
    li.appendChild(body);

    list.appendChild(li);
  });
  $('ann-empty').hidden = entries.length > 0;
}

/** 有未保存改动时给发布按钮加视觉提示，离开页面再问一次。 */
function markDirty() {
  dirty = true;
  saveDraft();
  $('publish-btn').dataset.dirty = '1';
}

/** 只清「有未发布改动」这个状态，**不动 localStorage**。
 *  早先这里也顺手 saveDraft()，结果每次「重新载入」都会把服务端内容写进草稿键，
 *  等用户点「恢复草稿」时，恢复出来的已经是服务端那份了 —— 按钮还在，草稿却没了。 */
function clearDirty() {
  dirty = false;
  delete $('publish-btn').dataset.dirty;
}

/** 发布成功后调：草稿内容已等于线上内容，留着只会让「恢复草稿」恢复一份多余的东西。 */
function dropDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* 同上 */ }
  dirty = false;
  delete $('publish-btn').dataset.dirty;
}

async function login() {
  token = ($('token-input').value || '').trim();
  if (!token) { flash('请先填令牌', 'err'); return; }
  try {
    const data = await adminGet();
    const draft = loadDraft();
    // 先载入服务端内容；若浏览器里另有未发布草稿，只提示并给一个「恢复」按钮，
    // 不静默覆盖 —— 否则那句提示等于谎话。
    entries = Array.isArray(data.entries) ? data.entries : [];
    setLoggedIn(true);
    renderList();
    clearDirty();
    const btn = $('draft-btn');
    if (btn) btn.hidden = !draft;
    flash(draft ? '已载入服务端内容；浏览器里另有一份未发布草稿，可点「恢复未发布草稿」' : `已载入 ${entries.length} 条公告`, '');
  } catch (err) {
    setLoggedIn(false);
    flash(String(err?.message || err), 'err');
  }
}

async function publish() {
  const note = $('publish-note');
  note.textContent = '发布中…';
  note.dataset.state = '';
  try {
    // 提交前按客户端规则自检一遍，省得把「发出去玩家也看不到」的内容当成成功。
    const clean = entries
      .map((e) => ({ title: (e.title || '').trim(), date: (e.date || '').trim(), level: e.level || 'info',
        paragraphs: (e.paragraphs || []).map((p) => String(p).trim()).filter(Boolean) }))
      .filter((e) => e.title && e.paragraphs.length);
    const data = await adminPut(clean);
    entries = clean;
    renderList();
    dropDraft();
    note.textContent = `已发布 ${data.count} 条 · ${when(data.updatedAt)} —— 游戏服最多 60 秒内生效`;
    note.dataset.state = 'ok';
  } catch (err) {
    note.textContent = String(err?.message || err);
    note.dataset.state = 'err';
  }
}

function flash(msg, state = '') {
  const note = $('publish-note');
  note.textContent = msg;
  note.dataset.state = state;
}

function setLoggedIn(on) {
  $('login-view').hidden = on;
  $('editor-view').hidden = !on;
  const pill = $('ann-pill');
  pill.textContent = on ? '已登录' : '未登录';
  pill.dataset.state = on ? 'ok' : '';
}

/* ---- 启动 --------------------------------------------------------------------------------- */

startPolling();

$('login-btn').addEventListener('click', login);
$('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
$('logout-btn').addEventListener('click', () => {
  token = '';
  entries = [];
  setLoggedIn(false);
  flash('已退出登录', '');
});
$('reload-btn').addEventListener('click', login);
$('draft-btn').addEventListener('click', () => {
  const draft = loadDraft();
  if (!draft?.entries) { flash('没有可恢复的草稿', 'err'); return; }
  entries = draft.entries;
  renderList();
  markDirty();
  $('draft-btn').hidden = true;
  flash(`已恢复草稿（${entries.length} 条）—— 确认后点「发布到游戏服」`, 'ok');
});
$('publish-btn').addEventListener('click', publish);
$('add-btn').addEventListener('click', () => {
  entries.unshift({ title: '', date: new Date().toISOString().slice(0, 10), level: 'info', paragraphs: [''] });
  renderList();
  $('ann-list').querySelector('.gk-input--title')?.focus();
  markDirty();
});

window.addEventListener('beforeunload', (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

// 有草稿就先恢复出来，省得刷新一下全丢
const draft = loadDraft();
if (draft?.entries?.length) {
  entries = draft.entries;
  renderList();
  markDirty();
}

/* ---- 游戏服：热装载开关 + 一键重新部署 ---------------------------------------------------------
   开关为什么在这里而不是游戏服：游戏服的容器盘是镜像烘死的，改一个环境变量或加一个文件都要重建一次。
   把开关放那边，就等于"为了开一个开关先重建一次"——正是这两个按钮要消灭的痛。所以本站只写**意图**
   （KV 里一个布尔），游戏服自己按 60 秒轮询去读。令牌还是页面里那一个，只留在内存。 */

const gsEl = (id) => document.getElementById(id);

/** 把一份 /api/game/status 的返回渲染成一行字。 */
function renderGame(d) {
  const h = d.health;
  const who = h ? `${h.app || '?'} · build ${String(h.build || '').slice(0, 8)} · 房间 ${h.rooms} 人 ${h.humans} 对局 ${h.matches}` : '（读不到游戏服）';
  const dep = d.deploy ? `线上 ${d.deploy.deployed || '?'}${d.deploy.changed ? ` → 待部署 ${d.deploy.current}` : '（已是最新）'}` : '';
  return `${who}${dep ? ' · ' + dep : ''}`;
}

function setHotLabel(on) {
  const b = gsEl('game-hot');
  b.textContent = on ? '热装载：已开启' : '热装载：已关闭';
  b.dataset.state = on ? 'on' : 'off';
}

/** 游戏服务开销：字段名与 server/healthMetrics.js 的快照一一对应（进程 CPU / RSS / 主线程 ELU / 事件循环 P95）。 */
function renderOverhead(perf) {
  const wrap = gsEl('game-over-wrap');
  if (!wrap) return;
  if (!perf) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const pct = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} %` : '—');
  const mib = (v) => (Number.isFinite(v) ? `${Math.round(v / 1024 / 1024)} MiB` : '—');
  const ms = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} ms` : '—');
  gsEl('game-over-cpu').textContent = pct(perf.process?.cpu?.percent ?? NaN);
  gsEl('game-over-rss').textContent = mib(perf.process?.rssBytes ?? NaN);
  gsEl('game-over-elu').textContent = pct((perf.mainThread?.eventLoopUtilization ?? NaN) * 100);
  gsEl('game-over-p95').textContent = ms(perf.mainThread?.eventLoopDelayMs?.p95 ?? NaN);
  gsEl('game-over-note').textContent = perf.status === 'ready'
    ? `进程 CPU：100% = 1 核 · 每 ${Math.round((perf.windowMs || 10000) / 1000)} 秒采样`
    : '采样还没攒够（状态 warming）';
}

function note(id, text, kind = '') {
  const el = gsEl(id);
  if (!el) return;
  el.textContent = text;
  el.dataset.state = kind;
}

async function loadGame() {
  if (!token) { note('game-note', '先在上面填令牌', 'err'); return; }
  note('game-note', '读取中…');
  try {
    const res = await fetch('/api/game/status', { headers: authHeaders() });
    const d = await res.json().catch(() => ({}));
    if (res.status === 401) { note('game-note', '未授权：令牌不对或已过期', 'err'); return; }
    if (!res.ok) { note('game-note', d.error || `HTTP ${res.status}`, 'err'); return; }
    setHotLabel(d.settings?.hotMods === true);
    renderOverhead(d.health?.performance ?? null);
    note('game-note', renderGame(d) + (d.error ? `（${d.error}）` : ''));
    if (d.health && Number(d.health.humans) + Number(d.health.matches) + Number(d.health.rooms) > 0) {
      note('game-result', '场上有局：现在点重新部署会被拒绝', '');
    }
  } catch (e) {
    note('game-note', '读取失败：' + String(e?.message || e).slice(0, 120), 'err');
  }
}

async function toggleHot() {
  if (!token) { note('game-result', '先在上面填令牌', 'err'); return; }
  const on = gsEl('game-hot').dataset.state !== 'on';
  note('game-result', '写入中…');
  try {
    const res = await fetch('/api/settings/game', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ hotMods: on }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { note('game-result', d.error || `HTTP ${res.status}`, 'err'); return; }
    setHotLabel(d.hotMods === true);
    note('game-result', `热装载已${d.hotMods ? '开启' : '关闭'}（游戏服最多 60 秒后跟上）`, 'ok');
  } catch (e) {
    note('game-result', '写入失败：' + String(e?.message || e).slice(0, 120), 'err');
  }
}

async function redeploy() {
  if (!token) { note('game-result', '先在上面填令牌', 'err'); return; }
  if (!confirm('重建会清空正在跑的对局（2–4 分钟）。确定现在重建？')) return;
  note('game-result', '已提交，等待平台…');
  try {
    const res = await fetch('/api/game/redeploy', { method: 'POST', headers: authHeaders() });
    const d = await res.json().catch(() => ({}));
    if (res.status === 409) { note('game-result', `${d.error}：房间 ${d.busy?.rooms} 人 ${d.busy?.humans} 对局 ${d.busy?.matches}`, 'err'); return; }
    if (!res.ok) { note('game-result', d.error || `HTTP ${res.status}`, 'err'); return; }
    note('game-result', d.message || '已触发重建', 'ok');
    setTimeout(loadGame, 20000);
  } catch (e) {
    note('game-result', '触发失败：' + String(e?.message || e).slice(0, 120), 'err');
  }
}

gsEl('game-load')?.addEventListener('click', loadGame);
gsEl('game-hot')?.addEventListener('click', toggleHot);
gsEl('game-deploy')?.addEventListener('click', redeploy);
// 登录成功后自动载入一次（登录函数把 token 写进内存，这里只需监听按钮的同一个动作）
gsEl('login-btn')?.addEventListener('click', () => setTimeout(loadGame, 400));