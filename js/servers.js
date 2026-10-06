/* ==========================================================================================
   servers.js — public server list with browser-measured latency.

   Probe mechanics: fetch(mode:'no-cors') is a simple request (no preflight), so third-party
   servers need no CORS to be timed; the response is opaque (no body/status readable), only
   the round-trip is measured. Each server gets one warm-up request (DNS/TLS cost) and then
   SAMPLES timed requests; the median of the successful ones is displayed. Every 5 minutes
   (±jitter) the whole list is re-measured while the page is visible; hidden pages pause.

   Safety: the list is hot-updatable JSON, so every entry is validated before any request —
   scheme must be http(s), credentials in the URL are refused, and localhost / loopback /
   private / link-local / reserved addresses are skipped (a hostile list entry must not turn
   visitors' browsers into intranet scanners).
   ========================================================================================== */
(function () {
  'use strict';

  var LIST_SOURCES = [
    'https://weishucdn.jiangjiangze.icu/site/servers.json', // hot copy (R2, CORS open)
    './data/servers.json'                                    // repository fallback snapshot
  ];
  var VERIFIED_URL = 'https://weishucdn.jiangjiangze.icu/site/verified.json';
  var VERIFY_REFRESH_MS = 30 * 60 * 1000; // 与后端档位一致：整体默认 30 分钟才真打一轮
  var PROBE_TIMEOUT_MS = 5000;
  var WARMUP_TIMEOUT_MS = 6000;
  var LIST_TIMEOUT_MS = 8000;
  var SAMPLES = 3;
  var CYCLE_MS = 30 * 60 * 1000; // 浏览器实测延迟也降到 30 分钟一轮（原来 5 分钟，玩家服务器扛不住）
  var JITTER_MS = 20 * 1000;
  var GOOD_MS = 150;
  var OK_MS = 400;
  var SLOW_MS = 1000;
  var ROOM_CAPACITY = 1000; // 满载房间数（负载条分母）
  // Results are cached per server in localStorage so the page opens with last round's
  // numbers instantly; a fresh measurement only runs on the 5-minute timer or when the
  // user hits 立即测速.
  var CACHE_KEY = 'sp.serverProbeCache.v1';
  var CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  // 玩家自己的「进不去」举报记在本地（按钮要变成可撤回态）。正向票已取消。
  var VOUCH_KEY = 'sp.vouchMine.v2';
  var VOUCH_LOCAL_TTL_MS = 24 * 60 * 60 * 1000;
  var VOUCH_URL = '/api/servers/vouch';
  var OPEN_URL = '/api/servers/open';
  var VOUCH_BAD_MIN = 2; // 与 verify.js 一致：负向要 2 个不同来源才隐藏，按钮提示要说实话
  var OPEN_LOCAL_KEY = 'sp.openLocal.v1';
  var PROBE_CONCURRENCY = 4; // 一次打满 29 台会把本机代理隧道挤死（页面自己的资源也走那条路）

  var state = { servers: [], updated: null, running: false, lastRun: 0, nextRun: 0, timer: null,
                fromCache: false, occupancy: {}, mine: {}, voteCounts: {}, opens: {}, openLocal: {} };

  var el = {
    list: document.getElementById('sv-list'),
    updated: document.getElementById('sv-updated'),
    timer: document.getElementById('sv-timer'),
    refresh: document.getElementById('sv-refresh'),
    note: document.getElementById('sv-note'),
    add: document.getElementById('sv-add'),
    modal: document.getElementById('sv-modal'),
    modalForm: document.getElementById('sv-modal-form'),
    addName: document.getElementById('sv-add-name'),
    addUrl: document.getElementById('sv-add-url'),
    addProbe: document.getElementById('sv-add-probe'),
    addNote: document.getElementById('sv-add-note'),
    addErr: document.getElementById('sv-add-err'),
    addGo: document.getElementById('sv-add-go')
  };

  function setText(node, text) { if (node) node.textContent = text; }

  /* ---- target validation ------------------------------------------------------------ */

  var PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
                    /^172\.(1[6-9]|2[0-9]|3[01])\./];

  function isUnsafeHostname(host) {
    var h = String(host || '').toLowerCase();
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
    if (h.charAt(0) === '[') {
      var v6 = h.slice(1, -1);
      if (v6 === '::1' || v6 === '::') return true;
      if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return true;
      return false;
    }
    if (h === '0.0.0.0') return true;
    return PRIVATE_V4.some(function (re) { return re.test(h); });
  }

  function targetUrl(raw, base) {
    var url;
    try { url = new URL(String(raw), base || undefined); } catch (err) { return null; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    if (isUnsafeHostname(url.hostname)) return null;
    return url;
  }

  /* ---- list loading ----------------------------------------------------------------- */

  function fetchJson(url) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, LIST_TIMEOUT_MS);
    return fetch(url, { signal: ctrl.signal, cache: 'no-store', headers: { accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) { clearTimeout(timer); return data; },
            function (err) { clearTimeout(timer); throw err; });
  }

  /**
   * 清单取数：三级。① localStorage 里上次的清单 —— 有就先画，首屏零等待；
   * ② 打包快照（同源、可缓存）；③ R2 现网值，到了就替换。
   * 以前是"先等 R2，失败才退回快照"，而这条链路首字节实测 1.5–26 秒，整页跟着空在那儿 ——
   * 清单"加载很慢"的主因不是数据量（7 KB），是把首屏挂在了一个跨源请求上。
   */
  var LIST_CACHE_KEY = 'sp.serverListCache.v1';
  var LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  function loadListCache() {
    try {
      var doc = JSON.parse(localStorage.getItem(LIST_CACHE_KEY) || 'null');
      if (!doc || !Array.isArray(doc.servers)) return null;
      if (Date.now() - (doc.at || 0) > LIST_CACHE_TTL_MS) return null;
      return doc;
    } catch (err) { return null; }
  }

  function saveListCache(data) {
    if (!data || !Array.isArray(data.servers)) return;
    try { localStorage.setItem(LIST_CACHE_KEY, JSON.stringify({ at: Date.now(), servers: data.servers, updated: data.updated || null })); } catch (err) { /* 满了就用不上，不影响功能 */ }
  }

  function loadList() {
    var cached = loadListCache();
    if (cached) { prepare(cached); render(); }
    var snap = fetchJson(LIST_SOURCES[1]).catch(function () { return null; });
    var live = fetchJson(LIST_SOURCES[0]).catch(function () { return null; });
    snap.then(function (data) { if (data) { prepare(data); render(); } });
    return Promise.all([snap, live]).then(function (r) {
      var data = r[1] || r[0] || null;
      if (data) saveListCache(data);
      return data;
    });
  }

  function prepare(data) {
    var raw = data && Array.isArray(data.servers) ? data.servers : [];
    state.updated = (data && data.updated) || null;
    state.servers = raw.filter(function (s) { return s && s.enabled !== false && s.url; }).map(function (s) {
      var target = targetUrl(s.url);
      var reason = '';
      if (!target) reason = '条目无效（仅允许公网 http/https 地址）';
      else if (location.protocol === 'https:' && target.protocol === 'http:') reason = 'http 地址在 https 页面不可探测';
      var candidates = [];
      if (target) {
        var probe = targetUrl(s.probe || '/healthz', target);
        candidates.push(probe || new URL('/healthz', target));
        var root = new URL('/', target);
        if (root.href !== candidates[0].href) candidates.push(root);
      }
      return {
        // 同一 host 可以挂多个实例，所以缺 id 时用 host+path 兜底，避免两行共用一份 occupancy
        id: String(s.id || (target && (target.hostname + (target.pathname === '/' ? '' : target.pathname))) || 'server'),
        name: String(s.name || (target && target.hostname) || '未命名'),
        url: target,
        candidates: candidates,
        probeable: !!target && !reason,
        reason: reason,
        ms: null,
        okCount: 0,
        offline: false,
        level: 'pending'
      };
    });
  }

  /* ---- server-side verification partition (valid vs quarantined) --------------------- */

  /** Occupancy (rooms / humans / version) stands on its own: the localStorage snapshot stores
   *  only {at, updated, occupancy}, and gating it behind the partition arrays made the cache
   *  path a no-op — so a first visit showed no version label and no load bar until the
   *  network answered. */
  function applyOccupancy(doc) {
    if (doc && doc.occupancy && typeof doc.occupancy === 'object') {
      state.occupancy = doc.occupancy;
      return true;
    }
    return false;
  }

  /* ---- 玩家匿名举报「进不去」+ 打开点击数 -------------------------------------------- */

  /** {id:{at:ms}} —— 只记自己报过「进不去」的条目（正向票已取消）。 */
  function loadMine() {
    var out = {};
    var cut = Date.now() - VOUCH_LOCAL_TTL_MS;
    try {
      var doc = JSON.parse(localStorage.getItem(VOUCH_KEY) || '{}');
      if (doc && typeof doc === 'object') {
        Object.keys(doc).forEach(function (k) {
          var at = Number((doc[k] || {}).at);
          if (at >= cut) out[k] = { at: at };
        });
      }
    } catch (err) { /* 隐私模式 / 坏数据：当没投过 */ }
    return out;
  }

  function markMine(id, on) {
    if (on) state.mine[id] = { at: Date.now() };
    else delete state.mine[id];
    try { localStorage.setItem(VOUCH_KEY, JSON.stringify(state.mine)); } catch (err) { /* 本次会话内记住 */ }
  }

  function reportedBad(id) { return !!state.mine[id]; }

  function applyVoteCounts(doc) {
    var out = {};
    var src = (doc && doc.vouches && typeof doc.vouches === 'object') ? doc.vouches : {};
    Object.keys(src).forEach(function (k) { out[k] = { bad: Number((src[k] || {}).bad) || 0 }; });
    state.voteCounts = out;
  }

  /** 打开点击数：服务端快照（verified.json 里的 opens）+ 本机自己刚点过的增量。 */
  function applyOpens(doc) {
    var src = (doc && doc.opens && typeof doc.opens === 'object') ? doc.opens : {};
    var out = {};
    Object.keys(src).forEach(function (k) {
      out[k] = { total: Number(src[k].total) || 0, today: Number(src[k].today) || 0 };
    });
    state.opens = out;
    var local = {};
    try {
      var cut = Date.now() - VOUCH_LOCAL_TTL_MS;
      var doc2 = JSON.parse(localStorage.getItem(OPEN_LOCAL_KEY) || '{}');
      Object.keys(doc2 || {}).forEach(function (k) {
        var rec = doc2[k] || {};
        if (Number(rec.at) >= cut) local[k] = { n: Number(rec.n) || 0, at: Number(rec.at) };
      });
    } catch (err) { /* 没本地增量就用服务端值 */ }
    state.openLocal = local;
  }

  function openCount(id) {
    var s = state.opens[id] || { total: 0, today: 0 };
    var l = state.openLocal[id];
    return { total: s.total + (l ? l.n : 0), today: s.today + (l ? l.n : 0) };
  }

  function bumpOpenLocal(id) {
    var l = state.openLocal[id] || { n: 0, at: Date.now() };
    l.n += 1; l.at = Date.now();
    state.openLocal[id] = l;
    try { localStorage.setItem(OPEN_LOCAL_KEY, JSON.stringify(state.openLocal)); } catch (err) { /* ignore */ }
  }

  function applyVerified(doc) {
    if (!doc) return 0;
    applyOccupancy(doc);
    applyVoteCounts(doc);
    applyOpens(doc);
    if (!Array.isArray(doc.valid) || !Array.isArray(doc.invalid)) return 0;
    var okIds = {};
    doc.valid.forEach(function (id) { okIds[id] = true; });
    var reasons = {};
    doc.invalid.forEach(function (item) { reasons[item.id] = item.reason || '校验未通过'; });
    var hidden = 0;
    state.servers.forEach(function (server) {
      // A published id must be in `valid` to stay visible; anything else quarantines.
      // 「进不去」一票**不**在本地隐藏 —— 门槛是两个不同来源，一个人说了不算。
      if (okIds[server.id]) {
        server.quarantined = false;
        // 靠玩家证据活着的条目必须继续回执，否则 24 小时后证据过期会被重新隐藏，来回抖
        server.viaBrowser = !!(doc.evidence && doc.evidence[server.id]);
        if (server.viaBrowser && server.ms != null && !server.offline) reportPing(server);
        return;
      }
      server.quarantined = true;
      server.quarantineReason = reasons[server.id] || '服务端校验未通过';
      // 已经有成绩、这一轮才发现它被隐藏：立刻回执，不等 30 分钟后的下一轮测速
      if (server.ms != null && !server.offline) reportPing(server);
      hidden += 1;
    });
    state.hiddenCount = hidden;
    return hidden;
  }

  function loadVerified() {
    return fetchJson(VERIFIED_URL).then(function (doc) {
      var hidden = applyVerified(doc);
      // Cache occupancy (rooms/humans/version) alongside the latency cache so the page
      // renders complete rows from the local snapshot even before the network answers.
      try { saveOccupancy(doc.occupancy, doc.updated); } catch (err) { /* ignore */ }
      // 探不到版本号的判死已经挪到服务端（verify.js 直接进 invalid），所以这里只报一个数：
      // 页面各自再判一次会出现"同一台在网页藏着、在客户端还亮着"两种口径，维护者复核时看不出差别
      if (hidden) {
        setText(el.note, hidden + ' 台服务器因服务端校验未通过已暂时隐藏（可在恢复后自动重新展示）。');
      }
      render();
      return hidden;
    }).catch(function () { return 0; /* no verdict yet: show everything */ });
  }

  /** Fire-and-forget: ask the backend to re-verify all servers now (shared result). */
  function triggerVerify() {
    fetch('/api/servers/verify', { cache: 'no-store' }).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (doc) {
      if (!doc || !doc.ok) return;
      return loadVerified();
    }).catch(function () { /* best-effort */ });
  }

  /* ---- result cache (localStorage) --------------------------------------------------- */

  var OCC_CACHE_KEY = 'sp.serverOccupancyCache.v1';

  function loadOccupancyCache() {
    try {
      var raw = localStorage.getItem(OCC_CACHE_KEY);
      if (!raw) return null;
      var doc = JSON.parse(raw);
      if (!doc || typeof doc.occupancy !== 'object') return null;
      if (Date.now() - (doc.at || 0) > CACHE_TTL_MS) return null;
      return doc;
    } catch (err) { return null; }
  }

  function saveOccupancy(occupancy, updated) {
    if (!occupancy || typeof occupancy !== 'object') return;
    localStorage.setItem(OCC_CACHE_KEY, JSON.stringify({ at: Date.now(), updated: updated || null, occupancy: occupancy }));
  }

  function applyOccupancyCache(doc) {
    if (!doc) return false;
    var hidden = applyVerified(doc);
    state.fromCache = true;
    return hidden >= 0;
  }

  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return {};
      var doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object' || !doc.entries) return {};
      if (Date.now() - (doc.at || 0) > CACHE_TTL_MS) return {};
      return doc.entries;
    } catch (err) { return {}; }
  }

  function saveCache(entries) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), entries: entries }));
    } catch (err) { /* storage unavailable */ }
  }

  function applyCache(entries) {
    var hits = 0;
    state.servers.forEach(function (server) {
      var hit = entries[server.id + '|' + (server.url ? server.url.host : '')];
      if (!hit || typeof hit.ms !== 'number') return;
      server.ms = hit.ms;
      server.okCount = SAMPLES;
      server.offline = !!hit.offline;
      server.cachedAt = hit.at || 0;
      server.level = server.offline ? 'bad'
        : server.ms < GOOD_MS ? 'good' : server.ms < OK_MS ? 'ok' : 'slow';
      hits += 1;
    });
    return hits;
  }

  function snapshotCache() {
    var entries = {};
    state.servers.forEach(function (server) {
      if (server.ms == null && !server.offline) return;
      entries[server.id + '|' + (server.url ? server.url.host : '')] =
        { ms: server.ms, offline: !!server.offline, at: server.probedAt || server.cachedAt || Date.now() };
    });
    return entries;
  }

  function cacheAge() {
    var oldest = 0;
    state.servers.forEach(function (server) {
      if (server.cachedAt && (!oldest || server.cachedAt < oldest)) oldest = server.cachedAt;
    });
    if (!oldest) return '';
    var mins = Math.max(1, Math.round((Date.now() - oldest) / 60000));
    return mins < 60 ? mins + ' 分钟前' : Math.round(mins / 60) + ' 小时前';
  }

  /* ---- probing ---------------------------------------------------------------------- */

  function timed(url, timeoutMs) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    var started = performance.now();
    return fetch(url.href, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
      .then(function () { clearTimeout(timer); return performance.now() - started; },
            function (err) { clearTimeout(timer); throw err; });
  }

  /** Warm-up: find the first candidate path that answers, paying DNS/TLS once. */
  function pickPath(server) {
    var index = 0;
    function attempt() {
      if (index >= server.candidates.length) return Promise.resolve(null);
      var url = server.candidates[index];
      index += 1;
      return timed(url, WARMUP_TIMEOUT_MS).then(function () { return url; },
                                                function () { return attempt(); });
    }
    return attempt();
  }

  /**
   * 闸门只看得到海外出口，国内 IDC 的服会被误判成「校验未通过」而整条隐藏。
   * 玩家浏览器就是国内出口：凡是「被隐藏」但本机连得通的，回执一次（每台 10 分钟最多一条，
   * 落 R2 的 site/pings.json，作为 /api/servers/verify 的正向证据）。
   */
  var PING_GAP_MS = 10 * 60 * 1000;
  function reportPing(server) {
    if (!server || !server.id || !(server.quarantined || server.viaBrowser)) return;
    var now = Date.now();
    var k = 'sp_ping_' + server.id;
    try { if (now - (Number(localStorage.getItem(k)) || 0) < PING_GAP_MS) return; localStorage.setItem(k, String(now)); } catch (err) { /* 隐私模式照发 */ }
    var payload = { id: server.id, ok: !server.offline, ms: server.ms == null ? null : Math.round(server.ms) };
    // 房间数与版本只能从响应体里读，而探针是 no-cors（响应不透明）。所以再试一次 CORS 读：
    // 服务器发了 Access-Control-Allow-Origin 才拿得到，拿不到就照旧只报连通性。
    // 同时按原样地址（含 path）探一次入口：no-cors 看不出状态码，但分得出连上与连不上，
    // 于是「闸门说入口 502」能拿到国内视角的佐证。http 地址在 https 页面里浏览器根本不让发，
    // 那种情况不报这个字段，免得把浏览器限制算成服务器挂了。
    var entryProbe = server.url && location.protocol === server.url.protocol
      ? timed(server.url, PROBE_TIMEOUT_MS).then(function () { return true; }, function () { return false; })
      : Promise.resolve(null);
    Promise.all([readHealth(server), entryProbe]).then(function (out) {
      var h = out[0];
      if (h) {
        payload.rooms = h.rooms; payload.humans = h.humans;
        payload.app = h.app; payload.build = h.build; payload.variant = h.variant;
      }
      if (out[1] !== null) payload.entry_ok = out[1];
      return fetch('/api/servers/ping', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      });
    }).catch(function () { /* 回执只是加分项，不打扰用户 */ });
  }

  /** One CORS read of the entry's health endpoint; null when the server sends no ACAO header. */
  function readHealth(server) {
    var url = server.candidates && server.candidates[0];
    if (!url) return Promise.resolve(null);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 6000);
    return fetch(url.href, { mode: 'cors', cache: 'no-store', signal: ctrl.signal })
      .then(function (res) { return res.json(); })
      .then(function (b) {
        clearTimeout(timer);
        if (!b || b.ok !== true) return null;
        var workers = b.runtime === 'cloudflare' || typeof b.version === 'string';
        return {
          rooms: Number.isFinite(b.rooms) ? Math.max(0, Math.min(1e6, Math.round(b.rooms))) : null,
          humans: Number.isFinite(b.humans) ? Math.max(0, Math.min(1e6, Math.round(b.humans))) : null,
          app: String(b.app || (workers ? b.version : '') || '').slice(0, 24) || null,
          build: typeof b.build === 'string' ? b.build.slice(0, 40) : null,
          variant: workers ? 'workers' : 'node',
        };
      }, function () { clearTimeout(timer); return null; });
  }

  function sample(server, url) {
    var results = [];
    var chain = Promise.resolve();
    var index;
    for (index = 0; index < SAMPLES; index += 1) {
      chain = chain.then(function () {
        return timed(url, PROBE_TIMEOUT_MS)
          .then(function (ms) { results.push(ms); }, function () { results.push(null); });
      });
    }
    return chain.then(function () {
      var good = results.filter(function (value) { return typeof value === 'number'; });
      server.okCount = good.length;
      if (!good.length) {
        server.ms = null;
        server.offline = true;
        server.level = 'bad';
        return;
      }
      good.sort(function (a, b) { return a - b; });
      server.ms = good[Math.floor(good.length / 2)];
      server.offline = false;
      server.level = server.ms < GOOD_MS ? 'good' : server.ms < OK_MS ? 'ok' : 'slow';
      reportPing(server);
    });
  }

  function probeAll(force) {
    if (state.running) return Promise.resolve();
    // Servers without a cached result are always measured (first sight); with a cache,
    // a full re-measure only happens when the user explicitly clicks 立即测速.
    var missing = state.servers.filter(function (s) { return s.probeable && s.ms == null && !s.offline; });
    if (!force && !missing.length) {
      state.lastRun = Date.now();
      if (document.body) document.body.setAttribute('data-probe', 'done');
      schedule();
      return Promise.resolve();
    }
    state.running = true;
    if (document.body) document.body.setAttribute('data-probe', 'running');
    setText(el.note, force ? '手动测速进行中…' : '正在补测新服务器…');
    var targets = force ? state.servers : missing;
    // 限并发：以前一次把 29 台全铺开（每台预热 + 3 次采样 ≈116 个请求），走代理的机器上
    // 这条隧道同时也在拉页面自己的 JS/CSS/清单 —— 结果就是"清单加载很慢"。4 路一组，
    // 每台测完立刻刷那一行，观感比一把梭更快。
    var queue = targets.slice();
    function worker() {
      var server = queue.shift();
      if (!server) return Promise.resolve();
      var step;
      if (!server.probeable) {
        server.level = 'na';
        step = Promise.resolve();
      } else {
        step = pickPath(server).then(function (url) {
          if (!url) { server.level = 'bad'; server.offline = true; server.ms = null; return undefined; }
          return sample(server, url).then(function () { render(); });
        }).catch(function () { /* 单台异常不拖垮整轮 */ });
      }
      return step.then(worker);
    }
    var lanes = [];
    for (var w = 0; w < PROBE_CONCURRENCY; w += 1) lanes.push(worker());
    var done = Promise.all(lanes);
    return done.then(function () {
      state.running = false;
      state.lastRun = Date.now();
      state.fromCache = false;
      if (document.body) document.body.setAttribute('data-probe', 'done');
      saveCache(snapshotCache());
      setText(el.note, '延迟为当前浏览器实测往返时间（每台先预热再取 3 次采样中位数），仅供参考。');
      render();
      schedule();
    });
  }

  /* ---- scheduling ------------------------------------------------------------------- */

  /** Scheduling jitter (not a security use). Uses crypto.getRandomValues where available
   *  so the value comes from the platform CSPRNG; falls back to no jitter when unavailable
   *  (e.g. an insecure local context). */
  function jitter() {
    try {
      var buf = new Uint32Array(1);
      (window.crypto || window.msCrypto).getRandomValues(buf);
      return (buf[0] / 4294967296) * 2 * JITTER_MS - JITTER_MS;
    } catch (err) {
      return 0;
    }
  }

  function schedule() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (document.hidden) { state.nextRun = 0; return; }
    var delay = CYCLE_MS + Math.round(jitter());
    state.nextRun = Date.now() + delay;
    state.timer = setTimeout(function () { probeAll(); }, delay);
  }

  function tick() {
    if (state.running) { setText(el.timer, '测速中…'); return; }
    if (!state.nextRun) { setText(el.timer, ''); return; }
    var left = Math.max(0, Math.ceil((state.nextRun - Date.now()) / 1000));
    setText(el.timer, '下次测速 ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0'));
  }

  /* ---- rendering -------------------------------------------------------------------- */

  function msText(server) {
    if (server.level === 'na') return '不可测速';
    if (server.offline) return '离线';
    if (server.ms == null) return '—';
    return Math.round(server.ms) + ' ms' + (server.okCount < SAMPLES ? ' *' : '');
  }

  function row(server) {
    var div = document.createElement('div');
    div.className = 'sv-row is-' + (server.level || 'pending');
    var occ = state.occupancy[server.id];
    if (occ && typeof occ.rooms === 'number') {
      if (occ.rooms >= ROOM_CAPACITY) div.className = 'sv-row is-full';
      else if (occ.rooms >= ROOM_CAPACITY * 0.7) div.className = 'sv-row is-hot';
    }

    var dot = document.createElement('span');
    dot.className = 'sv-dot';
    div.appendChild(dot);

    var main = document.createElement('div');
    main.className = 'sv-main';
    var name = document.createElement('span');
    name.className = 'sv-name';
    name.textContent = server.name;
    var host = document.createElement('span');
    host.className = 'sv-host';
    host.textContent = server.url
      ? server.url.host
      : '无效地址' + (server.reason ? ' · ' + server.reason : '');
    main.appendChild(name);
    main.appendChild(host);
    div.appendChild(main);

    // Meter = room load (rooms / 1000). Occupancy comes from the shared server-side
    // verification; node builds report rooms/humans, workers builds have none (dash).
    var occ = state.occupancy[server.id];
    var meter = document.createElement('span');
    meter.className = 'sv-meter';
    var bar = document.createElement('span');
    bar.className = 'sv-bar';
    var occLoad = occ && typeof occ.rooms === 'number' ? Math.min(1, occ.rooms / ROOM_CAPACITY) : null;
    bar.style.width = occLoad != null ? Math.max(4, Math.round(occLoad * 100)) + '%' : '0%';
    meter.appendChild(bar);
    meter.title = occLoad != null
      ? '负载：' + occ.rooms + ' / ' + ROOM_CAPACITY + ' 房间'
      : '该服务器类型不提供房间统计';
    div.appendChild(meter);
    // version label sits right after the host line (append inside `main`)
    // 只显版本号 v0.1.3 这种形态；构建哈希不进标题，收在悬浮提示里
    var versionText = occ && occ.app && /^\d+(\.\d+){1,3}/.test(String(occ.app)) ? 'v' + String(occ.app).replace(/^v/, '') : '';
    if (versionText && host) {
      var hostVer = document.createElement('span');
      hostVer.className = 'sv-hostver';
      hostVer.title = '服务器当前版本（不强制，仅标注）' + (occ.build ? '\n构建 ' + occ.build : '');
      hostVer.textContent = versionText;
      host.appendChild(hostVer);
    }
    // 后端在应答、清单那条入口却 5xx（闸门只标注不隐藏，10-05 定的口径）：把这半坏说出来，
    // 否则玩家点开才知道是 502，还以为是我们给的错地址。
    var entryBad = occ && occ.entry_status && occ.entry_status.ok === false;
    if (entryBad) {
      var warn = document.createElement('span');
      warn.className = 'sv-entrywarn';
      warn.textContent = occ.entry_status.status ? '入口 ' + occ.entry_status.status : '入口打不开';
      warn.title = (occ.entry_status.error || '入口地址打不开') + '（后端健康端点正常）'
        + (occ.entry_status.rounds > 1 ? ' · 已连续 ' + occ.entry_status.rounds + ' 轮' : '');
      main.appendChild(warn);
      div.className += ' is-degraded';
    }

    var ms = document.createElement('span');
    ms.className = 'sv-ms';
    ms.textContent = msText(server);
    ms.title = server.cachedAt
      ? '缓存于 ' + new Date(server.cachedAt).toLocaleString('zh-CN', { hour12: false })
      : '';
    div.appendChild(ms);

    // 「进不去」排在「打开」前面：先给判断再给跳转。报进不去的人多半就是刚点开过的那个，
    // 按钮放在跳转后面等于让他先做动作再回头找入口。
    var c = state.voteCounts[server.id] || {};
    if (c.bad) {
      var vb = document.createElement('span');
      vb.className = 'sv-vouchbadge is-bad';
      vb.textContent = c.bad + ' 人进不去';
      vb.title = '同一台要 ' + VOUCH_BAD_MIN + ' 个不同来源报告进不去才隐藏这一行（当前 ' + c.bad + ' 个）';
      main.appendChild(vb);
    }
    // 打开跳转的点击数：服务端快照 + 本机刚点过的增量（数字要立刻动，不等 120s 缓存）
    var oc = document.createElement('span');
    var on = openCount(server.id);
    oc.className = 'sv-opencount';
    oc.hidden = !on.total;
    oc.textContent = '目前已点击 ' + on.total + ' 次';
    oc.title = openTitle(on);
    main.appendChild(oc);

    var bad = document.createElement('button');
    bad.type = 'button';
    bad.className = 'btn btn--ghost btn--sm sv-votebad';
    var bl = document.createElement('span');
    bl.className = 'btn__label';
    if (reportedBad(server.id)) {
      bl.textContent = '已报告 · 点撤回';
      bad.title = '撤回自己这张「进不去」（撤回后这一行立刻回到清单）';
      bad.addEventListener('click', function () { postVouch(server, 'clear', bad, bl); });
    } else {
      bl.textContent = '进不去';
      bad.title = '只在「页面打得开、进不了游戏」时点。' + VOUCH_BAD_MIN
        + ' 个不同来源报告进不去才会隐藏这一行（单条报告多半是本地网络噪声）';
      bad.addEventListener('click', function () { postVouch(server, 'bad', bad, bl); });
    }
    bad.appendChild(bl);
    div.appendChild(bad);

    if (server.url) {
      var open = document.createElement('a');
      open.className = 'btn btn--secondary btn--sm';
      open.href = server.url.href;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      var label = document.createElement('span');
      label.className = 'btn__label';
      label.textContent = '打开';
      open.appendChild(label);
      open.addEventListener('click', function () { countOpen(server, oc); });
      div.appendChild(open);
    }
    return div;
  }

  function openTitle(on) {
    return '统计玩家点「打开」跳转的次数（同一来源 10 秒内只算一次，不去重到人）'
      + (on.today ? '；今日 ' + on.today + ' 次' : '');
  }

  /** 点了就本地加一 + 后台记账：不拦跳转，也不因为网络失败而回退数字（这只是一个粗信号）。 */
  function countOpen(server, node) {
    bumpOpenLocal(server.id);
    var on = openCount(server.id);
    if (node) {
      node.hidden = false;
      node.textContent = '目前已点击 ' + on.total + ' 次';
      node.title = openTitle(on);
    }
    fetch(OPEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: server.id }),
      keepalive: true,
    }).catch(function () { /* 记账失败不打扰玩家 */ });
  }

  /**
   * 投「进不去」或撤回自己那张。门槛是 2 个不同来源（见 verify.js 的注释：单条"我连不上"
   * 多半是本地噪声，10-05 就因此误藏过当天最大的一台服），所以投完要明确说还差几个。
   */
  function postVouch(server, verdict, btn, label) {
    if (!btn || btn.disabled) return;
    var old = label ? label.textContent : '';
    btn.disabled = true;
    if (label) label.textContent = '提交中…';
    fetch(VOUCH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: server.id, verdict: verdict }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; });
    }).then(function (outcome) {
      var c = (outcome.data && outcome.data.counts) || {};
      // 429 = 今天这台你已经投过了：本地同样按已投处理，别继续摆着让人重复点
      if (outcome.status === 429) { markMine(server.id, true); render(); return; }
      if (!outcome.data.ok) throw new Error(outcome.data.error || ('HTTP ' + outcome.status));
      markMine(server.id, verdict !== 'clear');
      if (verdict === 'clear') {
        setText(el.note, '已撤回你对「' + server.name + '」的「进不去」（现在 '
          + (c.bad || 0) + ' 人报告进不去）。');
      } else {
        var left = Math.max(0, VOUCH_BAD_MIN - (Number(c.bad) || 0));
        setText(el.note, '已报告「' + server.name + '」进不去（' + (c.bad || 1) + ' 个来源报告'
          + (left ? '，还差 ' + left + ' 个才会隐藏这一行；单条报告多半是本地网络噪声' : '，已达隐藏门槛') + '）。');
      }
      render();
      triggerVerify(); // 请服务端把票认进分区（档位内走缓存直返分支，也会立刻补这一层）
    }).catch(function (err) {
      btn.disabled = false;
      if (label) label.textContent = old;
      setText(el.note, '举报没提交上去：' + (err && err.message ? err.message : '网络'));
    });
  }

  function render() {
    if (!el.list) return;
    el.list.textContent = '';
    var shown = 0;
    state.servers.forEach(function (server) {
      if (server.quarantined) return; // failed server-side verification: hidden from the page
      el.list.appendChild(row(server));
      shown += 1;
    });
    if (state.updated) {
      var stamp = new Date(state.updated);
      setText(el.updated, '清单更新 ' + (isNaN(stamp.getTime())
        ? state.updated
        : stamp.toLocaleString('zh-CN', { hour12: false })));
    } else {
      setText(el.updated, '清单来源：内置快照');
    }
    if (state.hiddenCount) {
      setText(el.updated, (el.updated.textContent || '') + ' · ' + state.hiddenCount + ' 台待复核');
    }
    if (state.fromCache && state.servers.some(function (s) { return s.cachedAt; })) {
      setText(el.timer, '缓存 ' + cacheAge());
    }
  }

  /* ---- visitor submit modal --------------------------------------------------------- */

  var PRIVATE_V4_SUBMIT = [/^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
                           /^172\.(1[6-9]|2[0-9]|3[01])\./];

  function submitTargetOk(raw) {
    var url;
    try { url = new URL(String(raw).trim()); } catch (err) { return { error: '地址无法解析' }; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: '仅允许 http/https' };
    if (url.username || url.password) return { error: '地址中不能包含账号密码' };
    var h = url.hostname.toLowerCase();
    var unsafe = !h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
    if (!unsafe && h.charAt(0) === '[') {
      var v6 = h.slice(1, -1);
      unsafe = v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
    }
    if (!unsafe && h !== '0.0.0.0') {
      unsafe = PRIVATE_V4_SUBMIT.some(function (re) { return re.test(h); });
    }
    if (unsafe) return { error: '拒绝内网/环回/保留地址' };
    return { url: url };
  }

  function showSubmitError(text) {
    if (!el.addErr) return;
    if (text) { el.addErr.hidden = false; setText(el.addErr, text); }
    else { el.addErr.hidden = true; setText(el.addErr, ''); }
  }

  function openModal() {
    if (!el.modal) return;
    el.modal.hidden = false;
    showSubmitError('');
    if (el.addName) el.addName.focus();
  }

  function closeModal() {
    if (el.modal) el.modal.hidden = true;
  }

  function onSubmit(event) {
    event.preventDefault();
    var check = submitTargetOk(el.addUrl.value);
    if (check.error) { showSubmitError(check.error); return; }
    var probe = String(el.addProbe.value || '/healthz').trim() || '/healthz';
    if (!probe.startsWith('/')) probe = '/' + probe;
    var name = (el.addName.value || '').trim() || check.url.host;
    var payload = { servers: [{ name: name, url: check.url.href, probe: probe }] };
    if ((el.addNote.value || '').trim()) payload.servers[0].note = el.addNote.value.trim();

    if (el.addGo) { el.addGo.disabled = true; setText(el.addGo.querySelector('.btn__label'), '校验中…'); }
    showSubmitError('');
    fetch('/api/servers/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; });
    }).then(function (outcome) {
      if (!outcome.data.ok) throw new Error(outcome.data.error || ('HTTP ' + outcome.status));
      closeModal();
      el.addName.value = ''; el.addUrl.value = ''; el.addNote.value = '';
      // The list just gained a server: refresh the manifest and measure the newcomer.
      loadList().then(function (data) { prepare(data); applyCache(loadCache()); render(); probeAll(false); });
      setText(el.note, '「' + name + '」校验通过，已加入清单（服务端实测 /healthz 确认为卫戍协议服务器）。');
    }).catch(function (err) {
      showSubmitError('提交失败：' + (err && err.message ? err.message : '网络'));
    }).finally(function () {
      if (el.addGo) { el.addGo.disabled = false; setText(el.addGo.querySelector('.btn__label'), '校验并提交'); }
    });
  }

  /* ---- boot ------------------------------------------------------------------------- */

  function boot() {
    state.mine = loadMine();
    if (el.refresh) {
      el.refresh.addEventListener('click', function () { probeAll(true); });
    }
    if (el.add) el.add.addEventListener('click', openModal);
    if (el.modalForm) el.modalForm.addEventListener('submit', onSubmit);
    if (el.modal) {
      el.modal.addEventListener('click', function (ev) {
        if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-close')) closeModal();
      });
    }
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && el.modal && !el.modal.hidden) closeModal();
    });
    // deep link: servers.html#submit opens the dialog directly (also used for screenshots)
    if (location.hash === '#submit') openModal();
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (state.timer) { clearTimeout(state.timer); state.timer = null; }
        state.nextRun = 0;
      } else if (Date.now() - state.lastRun > CYCLE_MS) {
        probeAll();
      } else {
        schedule();
      }
    });
    setInterval(tick, 1000);

    loadList().then(function (data) {
      prepare(data);
      var hits = applyCache(loadCache());
      // Occupancy/version from the local cache first (same as latency), then the live
      // verified.json refreshes it in the background.
      applyOccupancyCache(loadOccupancyCache());
      render();
      if (!state.servers.length) {
        setText(el.note, '清单为空或不可用，请稍后再试。');
        return undefined;
      }
      // Server-side fingerprint verdicts: hide entries that are not Stronghold Protocol
      // servers (or are broken), then keep the partition fresh every 5 minutes.
      loadVerified();
      if (state.verifyTimer) clearInterval(state.verifyTimer);
      state.verifyTimer = setInterval(triggerVerify, VERIFY_REFRESH_MS);
      setTimeout(triggerVerify, 1500); // first shared re-verify shortly after load
      if (hits) {
        state.fromCache = true;
        state.lastRun = Date.now();
        setText(el.note, '显示上次测速结果（缓存）；点「立即测速」重新实测，或等 30 分钟自动刷新。');
        schedule();
        return undefined;
      }
      return probeAll(true);
    }).catch(function () {
      setText(el.note, '清单加载失败，请稍后再试。');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
