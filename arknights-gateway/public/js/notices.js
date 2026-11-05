/* ==========================================================================================
   notices.js — 公告轮播 + 历史公告弹窗。

   布局与交互照搬 game.rainya.me 的 #announcements-section（单行省略 + 展开、圆点、
   上一条/下一条、6 秒自动轮播、鼠标悬停与键盘焦点暂停、到期本地剪除、历史弹窗），
   数据源换成本站的 /data/announcements.json（静态文件，无外部请求）。
   ========================================================================================== */

const ROTATE_MS = 6000;
const LEVELS = { info: '站点通知', warning: '维护提醒', critical: '重要通知' };

const $ = (id) => document.getElementById(id);

// 公告时间一律按北京时间显示，与访客时区无关（与 rainya 一致）。
const dayFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const yearFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const formatDay = (value) => dayFormat.format(value).replace(/\//g, '-');
const formatYear = (value) => yearFormat.format(value).replace(/\//g, '-');

let current = [];
let index = 0;
let revision = null;
let expiryTimer = null;
let rotateTimer = null;
let hovering = false;
let focusWithin = false;
let wired = false;

const activeSlide = () => $('announcementTrack')?.children[index] || null;

function syncExpand() {
  const card = $('announcement');
  const button = $('announcementExpand');
  if (!card || card.hidden || !button) {
    if (button) button.hidden = true;
    return;
  }
  const text = activeSlide()?.querySelector('.announcement-text');
  const expanded = card.classList.contains('expanded');
  button.hidden = expanded ? false : !text || text.scrollWidth <= text.clientWidth + 1;
  $('announcementControls').hidden = current.length <= 1 && button.hidden;
  button.setAttribute('aria-expanded', String(expanded));
  button.firstElementChild.textContent = expanded ? '收起' : '展开';
}

function applyIndex() {
  const track = $('announcementTrack');
  const total = track.children.length;
  if (total === 0) return;
  index = ((index % total) + total) % total;
  track.style.transform = `translateX(-${index * 100}%)`;
  [...track.children].forEach((slide, i) => {
    slide.classList.toggle('is-active', i === index);
    slide.setAttribute('aria-hidden', String(i !== index));
  });
  [...$('announcementDots').children].forEach((dot, i) => {
    dot.classList.toggle('is-active', i === index);
    dot.setAttribute('aria-current', i === index ? 'true' : 'false');
  });
  const level = activeSlide()?.dataset.level || 'info';
  const status = $('announcementStatus');
  status.textContent = LEVELS[level];
  status.className = `notice-status ${level}`;
  syncExpand();
}

function stopRotation() { clearInterval(rotateTimer); rotateTimer = null; }

function startRotation() {
  stopRotation();
  if (current.length <= 1) return;
  rotateTimer = setInterval(() => {
    const card = $('announcement');
    if (!card || card.hidden || document.hidden || card.classList.contains('expanded') || hovering || focusWithin) return;
    goTo(index + 1);
  }, ROTATE_MS);
}

function goTo(next) {
  const total = $('announcementTrack').children.length;
  if (total <= 1) return;
  index = ((next % total) + total) % total;
  applyIndex();
  startRotation();
}

function buildSlides(list) {
  const track = $('announcementTrack');
  const dots = $('announcementDots');
  const total = list.length;
  track.replaceChildren(...list.map((item, i) => {
    const level = Object.hasOwn(LEVELS, item.level) ? item.level : 'info';
    const li = document.createElement('li');
    li.className = `announcement-slide ${level}`;
    li.dataset.level = level;
    li.setAttribute('role', 'group');
    li.setAttribute('aria-roledescription', '公告');
    li.setAttribute('aria-label', `第 ${i + 1} 条，共 ${total} 条`);

    const header = document.createElement('header');
    header.className = 'announcement-header';
    const h3 = document.createElement('h3');
    h3.className = 'announcement-title';
    h3.textContent = item.title;
    const meta = document.createElement('div');
    meta.className = 'announcement-meta';
    const label = document.createElement('span');
    label.className = 'announcement-label';
    label.textContent = LEVELS[level];
    meta.append(label);
    if (Number.isFinite(item.publishedAt)) {
      const published = document.createElement('span');
      published.className = 'announcement-published';
      published.title = `${formatYear(item.publishedAt)}（北京时间）`;
      published.textContent = `发布于 ${formatDay(item.publishedAt)}`;
      meta.append(published);
    }
    if (Number.isFinite(item.endsAt)) {
      const until = document.createElement('span');
      until.className = 'announcement-until';
      until.textContent = `截至 ${formatDay(item.endsAt)}`;
      meta.append(until);
    }
    header.append(h3, meta);

    const body = document.createElement('div');
    body.className = 'announcement-body';
    const p = document.createElement('p');
    p.className = 'announcement-text';
    p.textContent = item.text;
    body.append(p);

    li.append(header, body);
    return li;
  }));
  dots.replaceChildren(...list.map((_, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'announcement-dot';
    button.dataset.index = String(i);
    button.setAttribute('aria-label', `查看第 ${i + 1} 条公告`);
    return button;
  }));
  const single = total <= 1;
  $('announcementPrev').hidden = single;
  $('announcementNext').hidden = single;
  $('announcementDots').hidden = single;
}

function wireInteractions() {
  if (wired) return;
  wired = true;
  const card = $('announcement');
  $('announcementExpand').addEventListener('click', () => {
    card.classList.toggle('expanded');
    syncExpand();
  });
  $('announcementPrev').addEventListener('click', () => goTo(index - 1));
  $('announcementNext').addEventListener('click', () => goTo(index + 1));
  $('announcementDots').addEventListener('click', (event) => {
    const dot = event.target.closest('.announcement-dot');
    if (dot) goTo(Number(dot.dataset.index));
  });
  card.addEventListener('mouseenter', () => { hovering = true; });
  card.addEventListener('mouseleave', () => { hovering = false; });
  // 只有键盘焦点才暂停轮播：鼠标点击也会让按钮获得焦点，但那不该永久冻结轮播。
  card.addEventListener('focusin', (event) => { focusWithin = event.target.matches?.(':focus-visible') === true; });
  card.addEventListener('focusout', () => { focusWithin = false; });
  window.addEventListener('resize', syncExpand);
  $('announcementHistoryBtn').addEventListener('click', () => $('announcementHistoryDialog').showModal());
  $('announcementHistoryClose').addEventListener('click', () => $('announcementHistoryDialog').close());
}

function renderHistory(history) {
  const items = Array.isArray(history)
    ? history.filter((item) => item && typeof item.title === 'string' && typeof item.text === 'string')
    : [];
  const list = $('announcementHistoryList');
  list.replaceChildren(...items.map((item) => {
    const level = Object.hasOwn(LEVELS, item.level) ? item.level : 'info';
    const li = document.createElement('li');
    li.className = `history-item ${level}`;
    const header = document.createElement('header');
    const label = document.createElement('span');
    label.className = 'announcement-label';
    label.textContent = LEVELS[level];
    const time = document.createElement('time');
    time.textContent = Number.isFinite(item.publishedAt) ? formatYear(item.publishedAt) : '发布时间未知';
    header.append(label, time);
    const h4 = document.createElement('h4');
    h4.textContent = item.title;
    const p = document.createElement('p');
    p.textContent = item.text;
    li.append(header, h4, p);
    return li;
  }));
  $('announcementHistoryEmpty').hidden = items.length > 0;
  list.hidden = items.length === 0;
}

function showEmpty(unavailable = false) {
  const card = $('announcement');
  card.hidden = true;
  $('announcementEmpty').hidden = false;
  clearTimeout(expiryTimer);
  stopRotation();
  current = [];
  index = 0;
  revision = null;
  $('announcementTrack').replaceChildren();
  $('announcementDots').replaceChildren();
  $('announcementControls').hidden = true;
  card.classList.remove('expanded');
  const status = $('announcementStatus');
  status.textContent = unavailable ? '读取失败' : '暂无公告';
  status.className = `notice-status${unavailable ? ' is-unavailable' : ''}`;
  $('announcementEmptyTitle').textContent = unavailable ? '公告暂时无法读取' : '当前没有公告';
  $('announcementEmptyText').textContent = unavailable
    ? '稍后会自动重试；通道状态不受影响，可以直接从下方进入游戏。'
    : '维护与更新通知会在这里显示。';
}

function normalize(data, now) {
  const pool = Array.isArray(data.announcements) && data.announcements.length > 0
    ? data.announcements
    : data.announcement ? [data.announcement] : [];
  return pool.filter((item) => item && typeof item.title === 'string' && typeof item.text === 'string'
    && (!Number.isFinite(item.endsAt) || item.endsAt > now));
}

function render(data) {
  wireInteractions();
  renderHistory(data.history);
  const card = $('announcement');
  clearTimeout(expiryTimer);
  const now = Date.now();
  const list = normalize(data, now);
  if (list.length === 0) {
    showEmpty(data.unavailable === true);
    return;
  }
  current = list;
  const fingerprint = list.map((item) => item.revision ?? item.title).join('|');
  if (fingerprint !== revision) {
    revision = fingerprint;
    card.classList.remove('expanded');
    index = 0;
    buildSlides(list);
  }
  $('announcementEmpty').hidden = true;
  card.hidden = false;
  applyIndex();
  startRotation();

  // 到期后就地剪除，不必等下一次拉取。
  const next = list.reduce((min, item) => (
    Number.isFinite(item.endsAt) && item.endsAt > now && (min === null || item.endsAt < min) ? item.endsAt : min
  ), null);
  if (next !== null) {
    const expire = () => {
      const left = next - Date.now();
      if (left > 0) {
        expiryTimer = setTimeout(expire, Math.min(2147483647, left));
        return;
      }
      current = current.filter((item) => !Number.isFinite(item.endsAt) || item.endsAt > next);
      if (current.length === 0) { showEmpty(); return; }
      revision = current.map((item) => item.revision ?? item.title).join('|');
      card.classList.remove('expanded');
      buildSlides(current);
      index = Math.min(index, current.length - 1);
      applyIndex();
    };
    expire();
  }
}

export function initNotices() {
  fetch('./data/announcements.json', { cache: 'no-cache' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((data) => render(data))
    .catch(() => render({ announcements: [], history: [], unavailable: true }));
}
