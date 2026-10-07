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
  // 玩家自己的评价（大杯=好评 / 小杯=差评）记在本地：按钮要显示已投的那只，撤回要能立刻改回位置。
  var VOUCH_KEY = 'sp.vouchMine.v3';
  var VOUCH_LOCAL_TTL_MS = 24 * 60 * 60 * 1000;
  var VOUCH_URL = '/api/servers/vouch';
  var OPEN_URL = '/api/servers/open';
  var LAT_URL = '/api/servers/latency';
  var LAT_REPORT_GAP_MS = 10 * 60 * 1000;   // 每个客户端每 10 分钟最多交一批
  var LAT_REPORT_MAX = 64;
  var OPEN_LOCAL_KEY = 'sp.openLocal.v1';
  var PROBE_CONCURRENCY = 4; // 一次打满 29 台会把本机代理隧道挤死（页面自己的资源也走那条路）

  var state = { servers: [], updated: null, running: false, lastRun: 0, nextRun: 0, timer: null,
                fromCache: false, occupancy: {}, latency: {}, mine: {}, voteCounts: {}, opens: {}, openLocal: {} };

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
    var gotLive = false;
    var preparedSources = 0;
    var grab = function (url, isLive) {
      return fetchJson(url).catch(function () { return null; }).then(function (data) {
        if (!data) return null;
        // 现网值已经到了就别让仓库里那份快照盖回去（快照是手工同步的，可能落后）
        if (!isLive && gotLive) return data;
        if (isLive) gotLive = true;
        var hadList = preparedSources > 0;
        preparedSources += 1;
        prepare(data);
        render();
        saveListCache(data);
        // 第二份来源到货：换源带来的新条目要补测（第一份由 boot() 负责；正在跑就排队）
        if (hadList) {
          if (state.running) state.reprobe = true;
          else probeAll(false);
        }
        return data;
      });
    };
    var snap = grab(LIST_SOURCES[1], false);
    var live = grab(LIST_SOURCES[0], true);
    // boot() 把 verified.json 排在清单之后，所以这里**只等先到的那一路**。
    // 以前是 Promise.all：10-07 实测 R2 现网值 0.9 s、打包快照 6.9 s，
    // 负载条和版本判定就被最慢的一路整整拖了 6 秒（首屏 13.7 s 才出现）。
    return Promise.race([live, snap]);
  }

  function prepare(data) {
    var raw = data && Array.isArray(data.servers) ? data.servers : [];
    state.updated = (data && data.updated) || null;
    // 换源不换成绩：R2 现网清单与打包快照各自到货都会重建这份列表，后到的那次会把先到
    // 那次已经测出的本机 ms 全部带走。10-08 实测到的现象正是「数字先出来、测速一结束
    // 又全变回 ≈/—，要等下一个周期才回来」—— 用户报的「延迟数字加载慢」就是这个。
    // 按 id|host 把成绩带过去（条目没了自然丢弃）。
    var carried = {};
    (state.servers || []).forEach(function (s) {
      if (!s || !s.id) return;
      carried[s.id + '|' + (s.url ? s.url.host : '')] = {
        ms: s.ms, okCount: s.okCount, offline: !!s.offline,
        probedAt: s.probedAt || 0, cachedAt: s.cachedAt || 0, level: s.level || 'pending'
      };
    });
    // frozenOrder 里装的是旧对象：换源后留着它，排序与渲染会继续读已被换掉的成绩
    frozenOrder = null;
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
      // 同一 host 可以挂多个实例，所以缺 id 时用 host+path 兜底，避免两行共用一份 occupancy
      var id = String(s.id || (target && (target.hostname + (target.pathname === '/' ? '' : target.pathname))) || 'server');
      var entry = {
        id: id,
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
      var prev = carried[id + '|' + (target ? target.host : '')];
      if (prev && (typeof prev.ms === 'number' || prev.offline)) {
        entry.ms = prev.ms;
        entry.okCount = prev.okCount || 0;
        entry.offline = prev.offline;
        entry.level = prev.level;
        entry.probedAt = prev.probedAt;
        entry.cachedAt = prev.cachedAt;
      }
      return entry;
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

  /* ---- 玩家评价（大杯=好评 / 小杯=差评）+ 打开点击数 ---------------------------------- */

  /**
   * 自己今天在这一条上的取向：{v:'good'|'bad'|'clear', at:ms, was?:'good'|'bad'}。
   * 'clear' 也要记（带 was）：服务端快照有 120 s 边缘缓存，刚撤回时那份里可能还含着自己
   * 那一票 —— 不记就会一直按"有票"算，位置回不来（用户报的"撤回后还有提示"就是这个滞后）。
   */
  function loadMine() {
    var out = {};
    var cut = Date.now() - VOUCH_LOCAL_TTL_MS;
    try {
      var doc = JSON.parse(localStorage.getItem(VOUCH_KEY) || '{}');
      if (doc && typeof doc === 'object') {
        Object.keys(doc).forEach(function (k) {
          var rec = doc[k] || {};
          var at = Number(rec.at);
          if (at >= cut && (rec.v === 'good' || rec.v === 'bad' || rec.v === 'clear')) {
            out[k] = { v: rec.v, at: at, was: rec.was || null };
          }
        });
      }
    } catch (err) { /* 隐私模式 / 坏数据：当没投过 */ }
    return out;
  }

  function markMine(id, rec) {
    if (rec) state.mine[id] = rec; else delete state.mine[id];
    try { localStorage.setItem(VOUCH_KEY, JSON.stringify(state.mine)); } catch (err) { /* 本次会话内记住 */ }
  }

  function myVote(id) { return state.mine[id] || null; }

  /** 共享延迟（verified.json 的 latency）：盒子国内探测优先，其次上一位玩家的实测回执。 */
  function applyLatency(doc) {
    var src = (doc && doc.latency && typeof doc.latency === 'object') ? doc.latency : {};
    var out = {};
    Object.keys(src).forEach(function (k) {
      var v = src[k] || {};
      var ms = Number(v.ms);
      if (ms >= 0) out[k] = { ms: ms, src: v.src || 'shared', n: Number(v.n) || 1,
                              ageMin: Number(v.ageMin) || null };
    });
    state.latency = out;
  }

  function applyVoteCounts(doc) {
    var out = {};
    var src = (doc && doc.vouches && typeof doc.vouches === 'object') ? doc.vouches : {};
    Object.keys(src).forEach(function (k) {
      var v = src[k] || {};
      out[k] = { good: Number(v.good) || 0, bad: Number(v.bad) || 0, at: v.at || null };
    });
    state.voteCounts = out;
  }

  /**
   * 净分 = 服务端 (大杯 - 小杯) + 本机这一票的修正。
   * 修正只在"我的动作晚于快照 at"时生效：那时快照还没把我的票算进去。
   * 撤回则反向修正（was=good 的票被撤 → 快照里那份要当没有）。
   */
  function scoreOf(id) {
    var s = state.voteCounts[id] || { good: 0, bad: 0, at: null };
    var net = s.good - s.bad;
    var mine = myVote(id);
    if (!mine || !mine.at) return net;
    var cut = s.at ? (Date.parse(s.at) || 0) : 0;
    if (mine.at <= cut) return net;
    if (mine.v === 'good') return net + 1;
    if (mine.v === 'bad') return net - 1;
    if (mine.v === 'clear') return net + (mine.was === 'good' ? -1 : (mine.was === 'bad' ? 1 : 0));
    return net;
  }

  /** 打开点击数：服务端快照（verified.json 里的 opens）+ **只算快照之后**的本机点击。
   *  快照里带该条最后写入时间 at，早于它的本地增量已经被服务端计过了，再叠加就是重复计数
   *  （实测点一次显示 2 次就是这么来的）。 */
  function applyOpens(doc) {
    var src = (doc && doc.opens && typeof doc.opens === 'object') ? doc.opens : {};
    var out = {};
    Object.keys(src).forEach(function (k) {
      out[k] = { total: Number(src[k].total) || 0, today: Number(src[k].today) || 0, at: src[k].at || null };
    });
    state.opens = out;
    var local = {};
    try {
      var cut = Date.now() - VOUCH_LOCAL_TTL_MS;
      var doc2 = JSON.parse(localStorage.getItem(OPEN_LOCAL_KEY) || '{}');
      Object.keys(doc2 || {}).forEach(function (k) {
        var keep = (Array.isArray(doc2[k]) ? doc2[k] : []).filter(function (t) { return Number(t) >= cut; });
        if (keep.length) local[k] = keep;
      });
    } catch (err) { /* 没本地增量就用服务端值 */ }
    state.openLocal = local;
  }

  function openCount(id) {
    var s = state.opens[id] || { total: 0, today: 0, at: null };
    var cut = s.at ? (Date.parse(s.at) || 0) : 0;
    var extra = (state.openLocal[id] || []).filter(function (t) { return Number(t) > cut; }).length;
    // people = 去重点击人数（服务端按 sha256(ip|id) 算好的计数，只发数不发键）
    return { total: (s.total || 0) + extra, today: (s.today || 0) + extra,
             people: (Number(s.people) || 0) + (extra ? 1 : 0) };
  }

  /** 「（待核）」什么时候该消失：判据在服务端（verify.js 每轮真探后改名重签），
   *  这里只是万一清单还没改过来时的兜底显示，不改变任何数据。 */
  function displayName(server) {
    var name = server.name || '';
    if (!/（待核）\s*$/.test(name)) return name;
    var on = openCount(server.id);
    return on.people > 5 ? name.replace(/（待核）\s*$/, '') : name;
  }

  function bumpOpenLocal(id) {
    var list = state.openLocal[id] || [];
    list.push(Date.now());
    state.openLocal[id] = list;
    try { localStorage.setItem(OPEN_LOCAL_KEY, JSON.stringify(state.openLocal)); } catch (err) { /* ignore */ }
  }

  function applyVerified(doc) {
    if (!doc) return 0;
    applyOccupancy(doc);
    applyLatency(doc);
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

  function loadVerified(prestarted) {
    // verified.json 与清单相互独立：boot() 在 loadList 出膛的同时就把这一发打出去，
    // 清单一到立刻有共享延迟可画（≈ 值），不用等清单回来再串行等第二段往返。
    var p = prestarted || fetchJson(VERIFIED_URL);
    return p.then(function (doc) {
      if (!doc) return 0;
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
      reportLatency();   // 把这轮的实测值交给服务端，当"共同延迟"的样本
      setText(el.note, '延迟为当前浏览器实测往返时间（每台先预热再取 3 次采样中位数），仅供参考。');
      render();
      schedule();
      // 这一轮进行中有来源换过清单（新条目进来）：立刻补测，不等下一个周期
      if (state.reprobe) { state.reprobe = false; probeAll(false); }
    });
  }

  /**
   * 一轮测速跑完后批量上报本机实测延迟。服务端按 (来源, 条目, 当天) 去重后取中位数，
   * 作为清单排序的"共同延迟"第一来源 —— 也就是"用用户反馈的延迟做共同权重"。
   * 一次 POST 交一批：每台一次会把 R2 的写额度打爆（29 台 × 每访客每 10 分钟）。
   */
  function reportLatency() {
    var last = 0;
    try { last = Number(localStorage.getItem('sp.latReported.v1') || 0); } catch (err) { /* 隐私模式照发 */ }
    if (Date.now() - last < LAT_REPORT_GAP_MS) return;
    var samples = state.servers.filter(function (s) {
      return s.id && !s.offline && typeof s.ms === 'number' && s.ms >= 0;
    }).slice(0, LAT_REPORT_MAX).map(function (s) { return { id: s.id, ms: Math.round(s.ms) }; });
    if (!samples.length) return;
    try { localStorage.setItem('sp.latReported.v1', String(Date.now())); } catch (err) { /* ignore */ }
    fetch(LAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ samples: samples }),
      keepalive: true,
    }).catch(function () { /* 交不上就算了，下一轮再试 */ });
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

  /** 共享探测值（verified.json 的 latency，随排序链路一起到页面）。本机没测出来时延迟列
   *  先拿它顶上 —— 以前这里只有「—」，首访要等探针队列跑完（几十秒）才见数字。 */
  function sharedOf(server) {
    var sh = state.latency[server.id];
    return sh && sh.ms != null ? sh : null;
  }

  function sharedTitle(sh) {
    var src = sh.src === 'players-cn' ? '国内玩家实测样本'
      : sh.src === 'players' ? '玩家实测样本'
      : sh.src === 'cn-probe' ? '盒子国内探测'
      : '共享探测';
    return '共享探测参考值（' + src + '，' + (sh.n || 1) + ' 个样本'
      + (sh.ageMin != null ? '，' + sh.ageMin + ' 分钟前' : '') + '）；本机测速完成后会换成你自己的实测值';
  }

  function msText(server) {
    if (server.offline) return '离线';
    if (server.ms == null) {
      // 本机还没测到（或协议不让测，如 http 条目）：有共享值就先给 ≈ 参考值，
      // 比一直摆着「—」/「不可测速」有用 —— 用户报过「延迟数字加载慢」就是这一段。
      var sh = sharedOf(server);
      if (sh) return '≈ ' + Math.round(sh.ms) + ' ms';
      return server.level === 'na' ? '不可测速' : '—';
    }
    return Math.round(server.ms) + ' ms' + (server.okCount < SAMPLES ? ' *' : '');
  }

  /** 一只杯子按钮。自己投过的那只亮着，再点一下就是撤回 —— 不另外摆"撤回"文案，
   *  那东西上次留在行上成了甩不掉的提示。 */
  function cupButton(server, side) {
    var label = side === 'good' ? '大杯' : '小杯';
    var mine = myVote(server.id);
    var on = !!mine && mine.v === side;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn--ghost btn--sm sv-cup sv-cup--' + side + (on ? ' is-on' : '');
    var s = document.createElement('span');
    s.className = 'btn__label';
    s.textContent = label;
    b.title = on
      ? '你已经给过这一台' + label + '。点一下撤回，它回到原来的位置'
      : (side === 'good'
        ? '大杯 = 好评：这一台在同版本里往前挪（不会因此改变是否显示）'
        : '小杯 = 差评：这一台在同版本里往后挪（不会因此被隐藏）');
    b.addEventListener('click', function () { postVouch(server, on ? 'clear' : side, b, s); });
    b.appendChild(s);
    return b;
  }

  function cupGroup(server) {
    var wrap = document.createElement('span');
    wrap.className = 'sv-cups';
    wrap.appendChild(cupButton(server, 'good'));
    wrap.appendChild(cupButton(server, 'bad'));
    return wrap;
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
    name.textContent = displayName(server);
    // 版本号是**域名的兄弟**，不是域名的孩子：`.sv-host` 带 ellipsis 裁剪，以前把版本 span
    // 塞在它里面，域名一长（game.lingluotoki.dpdns.org）就把 `v0.1.4` 咬成 `v⋯`。
    var hostline = document.createElement('span');
    hostline.className = 'sv-hostline';
    var host = document.createElement('span');
    host.className = 'sv-host';
    host.textContent = server.url
      ? server.url.host
      : '无效地址' + (server.reason ? ' · ' + server.reason : '');
    main.appendChild(name);
    hostline.appendChild(host);
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
    // 版本标签跟在域名后面（只显 v0.1.3 这种点分号，构建哈希收进悬浮提示）。
    // 它是 `.sv-hostline` 的第二列且 `flex:0 0 auto` —— 挤不动的永远是域名，不是版本号。
    var versionText = occ && occ.app && /^\d+(\.\d+){1,3}/.test(String(occ.app)) ? 'v' + String(occ.app).replace(/^v/, '') : '';
    if (versionText) {
      var hostVer = document.createElement('span');
      hostVer.className = 'sv-hostver';
      hostVer.title = '服务器当前版本（不强制，仅标注）' + (occ.build ? '\n构建 ' + occ.build : '');
      hostVer.textContent = versionText;
      hostline.appendChild(hostVer);
    }
    main.appendChild(hostline);
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
    var shared = sharedOf(server);
    var showShared = server.ms == null && !server.offline && shared;
    if (showShared) ms.className = 'sv-ms sv-ms--shared';
    else ms.className = 'sv-ms';
    ms.textContent = msText(server);
    ms.title = server.cachedAt
      ? '缓存于 ' + new Date(server.cachedAt).toLocaleString('zh-CN', { hour12: false })
      : (showShared ? sharedTitle(shared) : '');
    div.appendChild(ms);

    // 大杯=好评、小杯=差评，放在「打开」前面（先给判断再给跳转）。两个都只调排序权重：
    // 净分高的在同版本里往前挪，**不会因为被差评就消失**（理由见 vouch.js 的注释）。
    var cup = cupGroup(server);
    div.appendChild(cup);

    // 打开跳转的点击数：服务端快照 + 本机刚点过的增量（数字要立刻动，不等 120s 缓存）
    var oc = document.createElement('span');
    var on = openCount(server.id);
    oc.className = 'sv-opencount';
    oc.hidden = !on.total;
    oc.textContent = '目前已点击 ' + on.total + ' 次' + (on.people > 1 ? '（' + on.people + ' 人）' : '');
    oc.title = openTitle(on);
    main.appendChild(oc);

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
      node.textContent = '目前已点击 ' + on.total + ' 次' + (on.people > 1 ? '（' + on.people + ' 人）' : '');
      node.title = openTitle(on);
    }
    fetch(OPEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: server.id }),
      keepalive: true,
    }).catch(function () { /* 记账失败不打扰玩家 */ });
  }

  /** 投大杯/小杯，或撤回自己那张。两者只改排序权重，不改某台显不显示。 */
  function postVouch(server, verdict, btn, label) {
    if (!btn || btn.disabled) return;
    var prev = myVote(server.id);
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
      var tally = (c.good || 0) + ' 大杯 / ' + (c.bad || 0) + ' 小杯';
      // 429 = 今天这台你已经投过了：本地同样按已投处理，别继续摆着让人重复点
      if (outcome.status === 429) { markMine(server.id, { v: verdict, at: Date.now() }); render(); return; }
      if (!outcome.data.ok) throw new Error(outcome.data.error || ('HTTP ' + outcome.status));
      if (verdict === 'clear') {
        // 记下撤的是哪一边：服务端快照有 120 s 边缘缓存，那份里可能还含着自己这一票，
        // 不记就不知道要把净分往回补多少，位置会卡住（上次"撤回后提示还在"就是这个滞后）。
        markMine(server.id, { v: 'clear', was: (prev && prev.v) || null, at: Date.now() });
        setText(el.note, '已撤回你对「' + server.name + '」的评价（现在 ' + tally + '）。');
      } else {
        markMine(server.id, { v: verdict, at: Date.now() });
        setText(el.note, '已给「' + server.name + '」' + (verdict === 'good' ? '一个大杯' : '一张小杯')
          + '（' + tally + '），它在同版本里' + (verdict === 'good' ? '往前挪了。' : '往后挪了。'));
      }
      render();
      triggerVerify(); // 请服务端把票认进分区（档位内走缓存直返分支，也会立刻补这一层）
    }).catch(function (err) {
      btn.disabled = false;
      if (label) label.textContent = old;
      setText(el.note, '评价没提交上去：' + (err && err.message ? err.message : '网络'));
    });
  }

  /**
   * 版本号排序键：`0.1.3` → 数值。**读不到版本号的按 -1 排在最后**（"版本低的放到后面"，
   * 而"我们不知道它是什么版本"本质上比"它是旧版"更该往后放 —— 玩家先看能玩的）。
   * 数据来自 occupancy.app（边缘真探 / 盒子国内探测 / 玩家 CORS 回执三条路），
   * 所以同一台在不同轮次可能换档，这是排序跟着事实走，不是抖动。
   */
  function versionRank(server) {
    var occ = state.occupancy[server.id] || {};
    var m = /^v?(\d{1,4})\.(\d{1,4})(?:\.(\d{1,4}))?(?:\.(\d{1,4}))?/.exec(String(occ.app || ''));
    if (!m) return -1;
    return Number(m[1]) * 1e12 + Number(m[2]) * 1e8 + Number(m[3] || 0) * 1e4 + Number(m[4] || 0);
  }

  /**
   * 版本归一化表：把当前这批服务器里出现过的版本号排成 0..1（最高版本=1，最低=0）。
   * 读不到版本的给 -0.2 —— 是**罚分**而不是"0 分"：这样它即使延迟再好也压在最底下，
   * 保住"版本低的放到后面"那条硬要求，同时不干扰有版本的那批按综合分排。
   */
  function versionScale(list) {
    var seen = {};
    list.forEach(function (s) {
      var r = versionRank(s);
      if (r > 0) seen[r] = 1;
    });
    var ranks = Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
    var map = {};
    ranks.forEach(function (r, i) { map[r] = ranks.length > 1 ? i / (ranks.length - 1) : 1; });
    map.unknown = -0.2;
    map.hasUnknown = ranks.length < list.length;
    return map;
  }

  function versionScore(server, scale) {
    var r = versionRank(server);
    return r > 0 ? (scale[r] != null ? scale[r] : 0) : scale.unknown;
  }

  /**
   * 权重用的那个延迟值：**共享探测优先**（盒子国内探测 → 上一位玩家的实测回执），
   * 本机自己测的那次只在共享值缺失时兜底。
   * 为什么不是"各人用自己测的"：那会让顺序随访客的网络浮动，而且**测不到就等于慢** ——
   * http 条目在 https 页面浏览器根本不让发探测（显示"不可测速"），这纯属协议限制，
   * 拿它当"这台很慢"是把好服务器压到底部（用户就是这么发现的）。延迟列里显示的还是本机实测，
   * 那是这一页对玩家的承诺；排序要的是公平。
   */
  function latencyOf(server) {
    var sh = state.latency[server.id];
    if (sh && sh.ms != null) return sh;
    if (server.ms != null && !server.offline) return { ms: server.ms, src: 'local' };
    return { ms: null, src: null };
  }

  /** 延迟归一化 = **同批已测到的里面的百分位**（最快 1、最慢 0，并列取同一档）。
   *  这样"没数据"给 0.5 就是字面意思的中位，而不是旧版绝对映射里的 ≈832 ms。 */
  function latencyScale(list) {
    var vals = [];
    list.forEach(function (s) {
      var l = latencyOf(s);
      if (l.ms != null) vals.push(Math.round(l.ms));
    });
    vals.sort(function (a, b) { return a - b; });
    var uniq = vals.filter(function (v, i) { return i === 0 || v !== vals[i - 1]; });
    var map = {};
    uniq.forEach(function (ms, i) { map[ms] = uniq.length > 1 ? 1 - i / (uniq.length - 1) : 1; });
    map.n = uniq.length;
    return map;
  }

  function latencyScore(server, scale) {
    var l = latencyOf(server);
    if (l.ms == null) {
      // 共享值和本机值都没有时，只有"本机明确测到离线"才算负面证据；
      // 协议不让测（level='na'）走不到这里，落到中性 0.5。
      return server.offline ? -0.2 : 0.5;
    }
    var v = scale[Math.round(l.ms)];
    return v == null ? 0.5 : v;
  }

  /** 评价归一化：净分（大杯-小杯）过一道软饱和，±4 杯基本就到顶/到底，
   *  免得某台被刷十几杯就把延迟和版本完全压过去。 */
  function cupScore(id) {
    var net = scoreOf(id);
    return net / (Math.abs(net) + 4);
  }

  /**
   * 综合权重 = 延迟 45% + 版本 30% + 评价 25%，三项都归一到 0..1。
   * 延迟占最大头（这一页的标题就是"延迟实测清单"），但用的是**共享探测值 + 同批百分位**，
   * 所以顺序对所有访客一致，且"没测到"是中位而不是垫底。
   */
  var W_LATENCY = 0.45;
  var W_VERSION = 0.30;
  var W_CUP = 0.25;

  function weightOf(server, scale, lscale) {
    return W_LATENCY * latencyScore(server, lscale)
      + W_VERSION * versionScore(server, scale)
      + W_CUP * cupScore(server.id);
  }

  /**
   * 排序结果在**测速进行中冻结**。不冻的话每台测完都会 render 一次，
   * 行会一边出结果一边往前跳，玩家根本点不到自己想点的那一行。
   * 一轮跑完（state.running=false）再重排 —— 现在延迟主用共享值，本机测速对顺序的影响
   * 只剩"共享值缺失的那几台"，跳动比旧版小得多。
   */
  var frozenOrder = null;

  function sortedServers() {
    if (state.running && frozenOrder) return frozenOrder;
    var visible = state.servers.filter(function (s) { return !s.quarantined; });
    var scale = versionScale(visible);
    var lscale = latencyScale(visible);
    // Array.prototype.sort 稳定：权重相同的保持清单原顺序
    visible.sort(function (a, b) { return weightOf(b, scale, lscale) - weightOf(a, scale, lscale); });
    frozenOrder = visible;
    return visible;
  }

  var LAT_SRC = { 'players-cn': '玩家反馈中位数（国内出口）', players: '玩家反馈中位数',
                  'cn-probe': '国内探测共享值（盒子出口）', browser: '上一位玩家的实测回执', local: '本机实测' };

  function weightText(server, scale, lscale) {
    var v = versionRank(server);
    var l = latencyOf(server);
    var latLine = l.ms == null
      ? (server.offline ? '本机测到离线，且没有共享值（按负面证据罚分）' : '没测到（共享值也没有）→ 按中位算，不罚')
      : Math.round(l.ms) + ' ms → 同批第 ' + Math.round(latencyScore(server, lscale) * 100) + ' 百分位（'
        + (LAT_SRC[l.src] || l.src) + (l.n > 1 ? '，' + l.n + ' 个来源' : '')
        + '；这一列里显示的是你本机实测的数）';
    return '权重 = 延迟 ' + Math.round(W_LATENCY * 100) + '% + 版本 ' + Math.round(W_VERSION * 100)
      + '% + 评价 ' + Math.round(W_CUP * 100) + '% = ' + weightOf(server, scale, lscale).toFixed(3) + '\n'
      + '  延迟：' + latLine + '\n'
      + '  版本：' + ((state.occupancy[server.id] || {}).app || '读不到') + (v > 0 ? '' : '（无版本，垫底处理）') + '\n'
      + '  评价：净分 ' + scoreOf(server.id) + '（大杯-小杯，含你自己这一票）';
  }

  function render() {
    if (!el.list) return;
    el.list.textContent = '';
    var shown = 0;
    var order = sortedServers();
    var scale = versionScale(order);
    var lscale = latencyScale(order);
    order.forEach(function (server) {
      var node = row(server);
      node.title = weightText(server, scale, lscale);
      el.list.appendChild(node);
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
    var s = String(raw || '').trim();
    if (!s) return { error: '地址不能为空' };
    // 和后端 normalizeTarget 同一套规则：没写协议就补 https，主机转小写、去尾点与重复斜杠。
    // 玩家手打的 `dx.frp-gap.com:29943` 以前会在这里被判"地址无法解析"，压根到不了服务端。
    if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(s)) s = 'https://' + s.replace(/^\/+/, '');
    var url;
    try { url = new URL(s); } catch (err) { return { error: '地址无法解析' }; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: '仅允许 http/https' };
    if (url.username || url.password) return { error: '地址中不能包含账号密码' };
    url.search = ''; url.hash = '';
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');
    var h = url.hostname.toLowerCase().replace(/\.+$/, '');
    var unsafe = !h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
    if (!unsafe && h.charAt(0) === '[') {
      var v6 = h.slice(1, -1);
      unsafe = v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
    }
    if (!unsafe && h !== '0.0.0.0') {
      unsafe = PRIVATE_V4_SUBMIT.some(function (re) { return re.test(h); });
    }
    if (unsafe) return { error: '拒绝内网/环回/保留地址' };
    var href = url.href.replace(/\/+$/, '');
    return { url: url, href: href || url.href };
  }

  /* ---- visitor-side probe ------------------------------------------------------------
   * 浏览器是**唯一能穿过"证书警告 + 继续访问"**这条路径的观察者。Cloudflare 边缘在 TLS
   * 握手就被自签源站挡死的服务器（SakuraFrp 这类映射给的自动证书），服务端永远看不见指纹，
   * 而玩家自己点得进去。于是提交前让访客浏览器也打一轮，把结果作为**复核材料**随单上传。
   * 三条纪律：
   *   1) 这份证据只帮维护者判断，绝不作为放行依据（任何人都能伪造它，服务端还会再洗一遍字段）；
   *   2) 只做有边界的并发探测（候选路径并行、每路 3.5s 超时），不阻塞提交太久；
   *   3) 分类要说老实话：读到 JSON 才算指纹，opaque 响应只能证明"连上了"。
   */
  var BV_PATHS = ['/healthz', '/api/status', '/api/health', '/health'];
  var BV_TIMEOUT = 3500;

  function bvFetch(href, mode) {
    var timedOut = false;
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () {
      timedOut = true;
      if (ctrl) { try { ctrl.abort(); } catch (err) {} }
    }, BV_TIMEOUT);
    return fetch(href, {
      method: 'GET',
      mode: mode,
      cache: 'no-store',
      credentials: 'omit',
      headers: mode === 'cors' ? { accept: 'application/json' } : {},
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) { clearTimeout(timer); return res; },
      function (err) { clearTimeout(timer); err && (err.__bvTimeout = timedOut); throw err; });
  }

  function bvKindOfError(err) {
    return err && (err.__bvTimeout || err.name === 'AbortError' || err.name === 'TimeoutError') ? 'timeout' : 'blocked';
  }

  function bvFingerprint(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (body.ok !== true) return null;
    var numeric = typeof body.version === 'number';
    var shaped = numeric || body.runtime === 'cloudflare' || typeof body.app === 'string';
    if (!shaped) return null;
    var out = { ok: true };
    if (numeric) out.version = body.version;
    if (body.runtime === 'cloudflare') out.runtime = 'cloudflare';
    if (typeof body.app === 'string') out.app = body.app.slice(0, 32);
    if (typeof body.build === 'string') out.build = body.build.slice(0, 40);
    var fields = ['uptimeSec', 'sockets', 'sessions', 'rooms', 'matches', 'humans', 'bots'];
    for (var i = 0; i < fields.length; i += 1) {
      var v = body[fields[i]];
      if (typeof v === 'number' && isFinite(v)) out[fields[i]] = v;
    }
    return out;
  }

  /** 一条候选路径：先按 cors 打（能读 body 才算真凭据），被 CORS 挡了再用 no-cors 分清
   *  "连上了读不到" 和 "根本连不上"。返回 { path, kind, code? }。 */
  function bvProbePath(href, path) {
    return bvFetch(href, 'cors').then(function (res) {
      if (!res.ok) return { path: path, kind: 'http', code: res.status };
      var type = (res.headers.get('content-type') || '');
      return res.text().then(function (text) {
        var body = null;
        if (type.indexOf('json') >= 0 || /^[\s]*\{/.test(text || '')) {
          try { body = JSON.parse(text); } catch (err) { body = null; }
        }
        var fp = bvFingerprint(body);
        if (fp) return { path: path, kind: 'protocol', code: 200, fingerprint: fp };
        if (body && typeof body === 'object') return { path: path, kind: 'not-protocol', code: 200 };
        return { path: path, kind: 'not-json', code: 200 };
      });
    }, function (err) {
      if (bvKindOfError(err) === 'timeout') return { path: path, kind: 'timeout' };
      // TypeError：可能是 CORS，也可能是证书/DNS —— 用 no-cors 再试一次来区分
      return bvFetch(href, 'no-cors').then(function () {
        return { path: path, kind: 'cors' };
      }, function (err2) {
        return { path: path, kind: bvKindOfError(err2) };
      });
    });
  }

  function bvReachable(href) {
    return bvFetch(href, 'no-cors').then(function () { return true; }, function () { return false; });
  }

  /** 汇总成一份 browserVerify；服务端会再洗一次字段，这里只管如实记录看到了什么。 */
  function browserVerify(base, entryHref) {
    var tasks = [];
    for (var i = 0; i < BV_PATHS.length; i += 1) {
      var path = BV_PATHS[i];
      tasks.push(bvProbePath(base + path, path));
    }
    tasks.push(bvReachable(entryHref).then(function (ok) { return { __entry: ok }; },
      function () { return { __entry: false }; }));
    return Promise.all(tasks).then(function (list) {
      var results = [], fingerprint = null, probePath = null, reachable = false, entryReachable = false;
      for (var j = 0; j < list.length; j += 1) {
        var item = list[j] || {};
        if (item.__entry !== undefined) { entryReachable = !!item.__entry; continue; }
        results.push({ path: item.path, kind: item.kind, code: item.code });
        if (item.kind !== 'timeout' && item.kind !== 'blocked') reachable = true;
        if (item.kind === 'protocol' && !fingerprint) { fingerprint = item.fingerprint; probePath = item.path; }
      }
      return {
        results: results,
        fingerprint: fingerprint,
        probePath: probePath,
        reachable: reachable,
        entryReachable: entryReachable,
        at: new Date().toISOString()
      };
    });
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
    // 名称、探针路径、备注**全部可留空**：名称由服务端回落成域名，探针交给多候选路径逐个试，
    // 备注本来就是可选项。以前三个都填才让提交，等于把不懂挂载点的玩家挡在门外。
    var entry = { url: check.href };
    var givenName = (el.addName.value || '').trim();
    if (givenName) entry.name = givenName;
    var probe = String(el.addProbe.value || '').trim();
    if (probe) entry.probe = probe.charAt(0) === '/' ? probe : '/' + probe;
    var note = (el.addNote.value || '').trim();
    if (note) entry.note = note;
    var name = givenName || check.url.host;
    var payload = { servers: [entry] };

    if (el.addGo) { el.addGo.disabled = true; setText(el.addGo.querySelector('.btn__label'), '浏览器自检中…'); }
    showSubmitError('');
    // 先让访客浏览器打一轮（候选路径并行、3.5s 上限），再连同证据一起提交
    browserVerify(check.url.origin + '/', check.href).then(function (bv) {
      payload.browserVerify = bv;
      if (el.addGo) setText(el.addGo.querySelector('.btn__label'), '提交中…');
      return fetch('/api/servers/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; });
    }).then(function (outcome) {
      var data = outcome.data;
      if (!data.ok) throw new Error(data.error || ('HTTP ' + outcome.status));
      closeModal();
      el.addName.value = ''; el.addUrl.value = ''; el.addProbe.value = ''; el.addNote.value = '';
      if (data.queued) {
        // 进暂存区不是失败：把原因和"会复核"讲明白，别让访客以为石沉大海
        if (el.addErr) showSubmitError(data.hint || '已提交，等待维护者复核。');
        setText(el.note, '「' + name + '」已提交到暂存区，标注「需要复核」，维护者会带两边证据判定后再上线。');
        return;
      }
      // The list just gained a server: refresh the manifest and measure the newcomer.
      loadList().then(function (res) { prepare(res); applyCache(loadCache()); render(); probeAll(false); });
      setText(el.note, '「' + name + '」校验通过，已加入清单（服务端实测健康端点确认为卫戍协议服务器）。');
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

    // 与清单并行出膛：清单一到，applyVerified 里的共享延迟就能立刻上列（≈ 值）
    var verifiedDoc = fetchJson(VERIFIED_URL).catch(function () { return null; });

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
      loadVerified(verifiedDoc);
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
