/* ==========================================================================================
   admin.js — server list editor.

   Two publishing paths:
   - With a publish key (admin.html?k=<key> or typed into the key field once, kept in
     localStorage): writes straight to the R2 hot list (site/servers.json) via the R2 REST
     API through a Pages Function at /api/servers — the key never appears in page source.
   - Without a key: edits are staged in localStorage and the servers page merges them in
     ("only for me"); a "copy JSON" button hands over the diff for manual publishing.

   The same validation as the probe page applies: public http(s) URLs only, no credentials
   in URLs, no localhost / private / reserved targets.
   ========================================================================================== */
(function () {
  'use strict';

  var LIST_SOURCES = [
    'https://weishucdn.jiangjiangze.icu/site/servers.json',
    './data/servers.json'
  ];
  var LS_DRAFT = 'sp.serverList.draft.v1';
  var LS_KEY = 'sp.serverList.key.v1';
  var LIST_TIMEOUT_MS = 8000;

  var el = {
    status: document.getElementById('ad-status'),
    list: document.getElementById('ad-list'),
    form: document.getElementById('ad-form'),
    name: document.getElementById('ad-name'),
    url: document.getElementById('ad-url'),
    probe: document.getElementById('ad-probe'),
    note: document.getElementById('ad-note'),
    err: document.getElementById('ad-err'),
    save: document.getElementById('ad-save'),
    revert: document.getElementById('ad-revert')
  };

  var base = [];   // published list as loaded
  var draft = null; // working copy (array of entries) when dirty

  function setText(node, text) { if (node) node.textContent = text; }

  function showError(text) {
    if (!el.err) return;
    if (text) { el.err.hidden = false; setText(el.err, text); }
    else { el.err.hidden = true; setText(el.err, ''); }
  }

  /* ---- validation (mirrors servers.js) ---------------------------------------------- */

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

  function validateUrl(raw) {
    var url;
    try { url = new URL(String(raw).trim()); } catch (err) { return { error: '地址无法解析' }; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: '仅允许 http/https' };
    if (url.username || url.password) return { error: '地址中不能包含账号密码' };
    if (isUnsafeHostname(url.hostname)) return { error: '拒绝内网/环回/保留地址' };
    return { url: url };
  }

  function normalizeProbe(raw, base) {
    var text = String(raw || '/healthz').trim() || '/healthz';
    if (!text.startsWith('/')) text = '/' + text;
    var url;
    try { url = new URL(text, base); } catch (err) { return null; }
    return url.href;
  }

  /* ---- data -------------------------------------------------------------------------- */

  function fetchJson(url) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, LIST_TIMEOUT_MS);
    return fetch(url, { signal: ctrl.signal, cache: 'no-store' })
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }, function (err) { clearTimeout(timer); throw err; });
  }

  function loadPublished() {
    var chain = Promise.resolve(null);
    return LIST_SOURCES.reduce(function (acc, src) {
      return acc.then(function (data) {
        return data || fetchJson(src).catch(function () { return null; });
      });
    }, chain).then(function (data) {
      base = (data && Array.isArray(data.servers)) ? data.servers.slice() : [];
      if (data && data.updated) base.updated = data.updated;
    });
  }

  function current() { return draft || base; }

  function persistDraft() {
    try {
      if (draft) localStorage.setItem(LS_DRAFT, JSON.stringify({ updated: new Date().toISOString(), servers: draft }));
      else localStorage.removeItem(LS_DRAFT);
    } catch (err) { /* storage unavailable */ }
  }

  function restoreDraft() {
    try {
      var raw = localStorage.getItem(LS_DRAFT);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.servers)) draft = parsed.servers;
    } catch (err) { /* ignore corrupt draft */ }
  }

  function publishKey() {
    var params = new URLSearchParams(location.search);
    var fromQuery = params.get('k');
    if (fromQuery) {
      try { localStorage.setItem(LS_KEY, fromQuery); } catch (err) { /* ignore */ }
      history.replaceState(null, '', location.pathname);
      return fromQuery;
    }
    try { return localStorage.getItem(LS_KEY) || ''; } catch (err) { return ''; }
  }

  /* ---- rendering --------------------------------------------------------------------- */

  function row(entry, index) {
    var disabled = entry.enabled === false;
    var div = document.createElement('div');
    div.className = 'sv-row' + (disabled ? ' is-disabled' : '');

    var dot = document.createElement('span');
    dot.className = 'sv-dot';
    div.appendChild(dot);

    var main = document.createElement('div');
    main.className = 'sv-main';
    var name = document.createElement('span');
    name.className = 'sv-name';
    name.textContent = entry.name || entry.url;
    var host = document.createElement('span');
    host.className = 'sv-host';
    host.textContent = (entry.url || '') + (entry.note ? ' · ' + entry.note : '');
    main.appendChild(name);
    main.appendChild(host);
    div.appendChild(main);

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'sv-toggle';
    toggle.textContent = disabled ? '已停用' : '启用中';
    toggle.addEventListener('click', function () {
      var list = current().slice();
      list[index] = Object.assign({}, entry, { enabled: disabled });
      draft = list;
      persistDraft();
      render();
    });
    div.appendChild(toggle);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'sv-del';
    del.textContent = '删除';
    del.addEventListener('click', function () {
      var list = current().slice();
      list.splice(index, 1);
      draft = list;
      persistDraft();
      render();
    });
    div.appendChild(del);
    return div;
  }

  function render() {
    if (!el.list) return;
    el.list.textContent = '';
    current().forEach(function (entry, index) { el.list.appendChild(row(entry, index)); });

    var dirty = !!draft;
    setText(el.status, dirty ? '有未发布的修改（暂存在本机）' : '与线上清单一致');
    if (el.save) el.save.disabled = !dirty;
  }

  /* ---- actions ----------------------------------------------------------------------- */

  function onAdd(ev) {
    ev.preventDefault();
    showError('');
    var check = validateUrl(el.url.value);
    if (check.error) { showError(check.error); return; }
    var probeHref = normalizeProbe(el.probe.value, check.url);
    if (!probeHref) { showError('探针路径无效'); return; }
    var entry = {
      id: 'srv-' + Date.now().toString(36),
      name: (el.name.value || '').trim() || check.url.host,
      url: check.url.href.replace(/\/$/, '') + (check.url.pathname === '/' ? '' : ''),
      probe: probeHref.replace(/^https?:\/\/[^/]+/, ''),
      enabled: true
    };
    if (check.url.pathname && check.url.pathname !== '/') entry.url = check.url.origin + check.url.pathname.replace(/\/$/, '');
    if ((el.note.value || '').trim()) entry.note = el.note.value.trim();
    if (entry.probe === '/') delete entry.probe;

    var list = current().slice();
    if (list.some(function (s) { return s.url === entry.url; })) {
      showError('该地址已在清单中');
      return;
    }
    list.push(entry);
    draft = list;
    persistDraft();
    el.name.value = '';
    el.url.value = '';
    el.note.value = '';
    render();
  }

  function publishPayload() {
    return JSON.stringify({
      updated: new Date().toISOString(),
      servers: current().map(function (s) {
        var clean = { id: s.id, name: s.name, url: s.url, probe: s.probe || '/healthz', enabled: s.enabled !== false };
        if (s.note) clean.note = s.note;
        return clean;
      })
    }, null, 2) + '\n';
  }

  function onPublish() {
    showError('');
    var key = publishKey();
    if (!key) {
      key = window.prompt('输入发布密钥（跳过则修改只保存在本机）', '') || '';
      if (!key) {
        if (el.note) setText(el.note, '已暂存在本机。可在服务器清单页看到合并结果；把 JSON 交给维护者即可发布。');
        try { localStorage.setItem(LS_KEY, ''); } catch (err) { /* ignore */ }
        return;
      }
      try { localStorage.setItem(LS_KEY, key); } catch (err) { /* ignore */ }
    }
    if (el.save) { el.save.disabled = true; setText(el.save.querySelector('.btn__label'), '发布中…'); }
    fetch('/api/servers', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: publishPayload()
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json().catch(function () { return {}; });
    }).then(function () {
      draft = null;
      persistDraft();
      setText(el.status, '已发布');
      return loadPublished().then(render);
    }).catch(function (err) {
      showError('发布失败（' + (err && err.message ? err.message : '网络') + '），修改仍暂存在本机');
      render();
    }).finally(function () {
      if (el.save) setText(el.save.querySelector('.btn__label'), '保存并发布');
    });
  }

  function onRevert() {
    draft = null;
    persistDraft();
    showError('');
    render();
  }

  /* ---- boot -------------------------------------------------------------------------- */

  function boot() {
    if (el.form) el.form.addEventListener('submit', onAdd);
    if (el.save) el.save.addEventListener('click', onPublish);
    if (el.revert) el.revert.addEventListener('click', onRevert);
    loadPublished().then(function () {
      restoreDraft();
      render();
    }).catch(function () {
      setText(el.status, '线上清单加载失败（可离线编辑）');
      restoreDraft();
      render();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
