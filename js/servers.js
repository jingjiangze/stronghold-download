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
  var VERIFY_REFRESH_MS = 5 * 60 * 1000; // matches the probe cadence
  var PROBE_TIMEOUT_MS = 5000;
  var WARMUP_TIMEOUT_MS = 6000;
  var LIST_TIMEOUT_MS = 8000;
  var SAMPLES = 3;
  var CYCLE_MS = 5 * 60 * 1000;
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

  var state = { servers: [], updated: null, running: false, lastRun: 0, nextRun: 0, timer: null, fromCache: false, occupancy: {} };

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

  function loadList(index) {
    index = index || 0;
    if (index >= LIST_SOURCES.length) return Promise.resolve(null);
    return fetchJson(LIST_SOURCES[index]).catch(function () { return loadList(index + 1); });
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

  function applyVerified(doc) {
    if (!doc) return 0;
    applyOccupancy(doc);
    if (!Array.isArray(doc.valid) || !Array.isArray(doc.invalid)) return 0;
    var okIds = {};
    doc.valid.forEach(function (id) { okIds[id] = true; });
    var reasons = {};
    doc.invalid.forEach(function (item) { reasons[item.id] = item.reason || '校验未通过'; });
    var hidden = 0;
    state.servers.forEach(function (server) {
      // A published id must be in `valid` to stay visible; anything else quarantines.
      if (okIds[server.id]) { server.quarantined = false; return; }
      server.quarantined = true;
      server.quarantineReason = reasons[server.id] || '服务端校验未通过';
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
    // Measure servers in parallel: each runs its own warm-up + samples, and the UI row
    // updates as soon as that server finishes instead of after the whole round.
    var done = Promise.all(targets.map(function (server) {
      if (!server.probeable) { server.level = 'na'; return undefined; }
      return pickPath(server).then(function (url) {
        if (!url) { server.level = 'bad'; server.offline = true; server.ms = null; return undefined; }
        return sample(server, url).then(function () { render(); });
      });
    }));
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
    var versionText = occ ? (occ.build ? 'build ' + String(occ.build).slice(0, 7)
      : (occ.app ? 'v' + occ.app : '')) : '';
    if (versionText && host) {
      var hostVer = document.createElement('span');
      hostVer.className = 'sv-hostver';
      hostVer.title = '服务器当前版本（不强制，仅标注）';
      hostVer.textContent = versionText;
      host.appendChild(hostVer);
    }

    var ms = document.createElement('span');
    ms.className = 'sv-ms';
    ms.textContent = msText(server);
    ms.title = server.cachedAt
      ? '缓存于 ' + new Date(server.cachedAt).toLocaleString('zh-CN', { hour12: false })
      : '';
    div.appendChild(ms);

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
      div.appendChild(open);
    }
    return div;
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
        setText(el.note, '显示上次测速结果（缓存）；点「立即测速」重新实测，或等 5 分钟自动刷新。');
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
