/* ==========================================================================================
   admin.js — key-gated list management.

   Auth: the key is entered once (kept in sessionStorage only), then verified server-side
   by PUT /api/servers with the x-admin-key header — a wrong key returns 401 and the gate
   stays up. With a valid key the page can:
     - toggle (enable/disable) or delete any published server (PUT /api/servers);
     - add a server (POST /api/servers/submit — server-side health check + auto-publish);
     - re-admit or drop servers quarantined by /api/servers/verify (the live list still
       holds them; re-publishing unchanged data restores the entry).
   The key never appears in page source; it lives only in this tab's sessionStorage.
   ========================================================================================== */
(function () {
  'use strict';

  var LIST_SOURCES = [
    'https://weishucdn.jiangjiangze.icu/site/servers.json',
    './data/servers.json'
  ];
  var VERIFIED_URL = 'https://weishucdn.jiangjiangze.icu/site/verified.json';
  var LIST_TIMEOUT_MS = 8000;
  var KEY_STORE = 'sp.adminKey';

  var el = {
    status: document.getElementById('ad-status'),
    gate: document.getElementById('ad-gate'),
    gateLogin: document.getElementById('ad-gate-login'),
    keyForm: document.getElementById('ad-key-form'),
    keyInput: document.getElementById('ad-key-input'),
    keyErr: document.getElementById('ad-key-err'),
    keyGo: document.getElementById('ad-key-go'),
    list: document.getElementById('ad-list'),
    review: document.getElementById('ad-review'),
    pending: document.getElementById('ad-pending'),
    reload: document.getElementById('ad-reload'),
    form: document.getElementById('ad-form'),
    name: document.getElementById('ad-name'),
    url: document.getElementById('ad-url'),
    probe: document.getElementById('ad-probe'),
    note: document.getElementById('ad-note'),
    err: document.getElementById('ad-err'),
    submit: document.getElementById('ad-submit')
  };

  var base = [];

  function setText(node, text) { if (node) node.textContent = text; }

  function showError(text) {
    if (!el.err) return;
    if (text) { el.err.hidden = false; setText(el.err, text); }
    else { el.err.hidden = true; setText(el.err, ''); }
  }

  function key() {
    try { return sessionStorage.getItem(KEY_STORE) || ''; } catch (err) { return ''; }
  }

  /* ---- data -------------------------------------------------------------------------- */

  function fetchJson(url, headers) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, LIST_TIMEOUT_MS);
    return fetch(url, { signal: ctrl.signal, cache: 'no-store', headers: headers || {} })
      .then(function (res) {
        clearTimeout(timer);
        return res.json().then(function (data) { return { status: res.status, data: data }; },
          function () { return { status: res.status, data: null }; });
      }, function (err) { clearTimeout(timer); throw err; });
  }

  function loadPublished() {
    var chain = Promise.resolve(null);
    return LIST_SOURCES.reduce(function (acc, src) {
      return acc.then(function (data) {
        return data || fetchJson(src).then(function (out) { return out.data; }).catch(function () { return null; });
      });
    }, chain).then(function (data) {
      base = (data && Array.isArray(data.servers)) ? data.servers.slice() : [];
    });
  }

  function loadVerified() {
    return fetchJson(VERIFIED_URL).then(function (out) {
      return (out.data && out.data.invalid) || [];
    }).catch(function () { return []; });
  }

  function publishList() {
    var payload = {
      updated: new Date().toISOString(),
      servers: base.map(function (s) {
        var clean = {
          id: s.id, name: s.name, url: s.url,
          probe: s.probe || '/healthz', enabled: s.enabled !== false
        };
        if (s.note) clean.note = s.note;
        return clean;
      })
    };
    return fetch('/api/servers', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': key() },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data };
      });
    }).then(function (out) {
      if (out.status === 401) throw new Error('密钥无效');
      if (!out.data.ok) throw new Error(out.data.error || ('HTTP ' + out.status));
      return out.data;
    });
  }

  /* ---- rendering --------------------------------------------------------------------- */

  function pubRow(entry, index) {
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
    host.textContent = entry.url + (entry.note ? ' · ' + entry.note : '');
    main.appendChild(name);
    main.appendChild(host);
    div.appendChild(main);

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'sv-toggle';
    toggle.textContent = disabled ? '已停用' : '启用中';
    toggle.addEventListener('click', function () {
      base[index] = Object.assign({}, entry, { enabled: disabled });
      publishList().then(function () { render(); })
        .catch(function (err) { showError(err.message); render(); });
    });
    div.appendChild(toggle);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'sv-del';
    del.textContent = '删除';
    del.addEventListener('click', function () {
      base.splice(index, 1);
      publishList().then(function () { render(); })
        .catch(function (err) { showError(err.message); render(); });
    });
    div.appendChild(del);
    return div;
  }

  function quarRow(item) {
    var div = document.createElement('div');
    div.className = 'sv-row is-disabled';

    var dot = document.createElement('span');
    dot.className = 'sv-dot';
    div.appendChild(dot);

    var main = document.createElement('div');
    main.className = 'sv-main';
    var name = document.createElement('span');
    name.className = 'sv-name';
    name.textContent = item.name || item.id;
    var host = document.createElement('span');
    host.className = 'sv-host';
    host.textContent = (item.url || '') + ' · ' + (item.reason || '校验未通过');
    main.appendChild(name);
    main.appendChild(host);
    div.appendChild(main);

    var restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'sv-toggle';
    restore.textContent = '恢复展示';
    restore.addEventListener('click', function () {
      // Quarantine hides the entry in the UI but never deletes it from the published
      // list; re-publishing unchanged data is enough, the next verify round re-checks it.
      var entry = base.filter(function (s) { return s.id === item.id; })[0];
      if (!entry) { showError('该条目已不在清单中，请用下方表单重新添加'); return; }
      base = base.map(function (s) {
        return s.id === item.id ? Object.assign({}, s, { enabled: true }) : s;
      });
      publishList().then(function () {
        setText(el.status, '已恢复（下轮校验通过后自动回到前台）');
        render();
        loadReview();
      }).catch(function (err) { showError(err.message); });
    });
    div.appendChild(restore);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'sv-del';
    del.textContent = '删除';
    del.addEventListener('click', function () {
      var index = base.findIndex(function (s) { return s.id === item.id; });
      if (index < 0) { showError('该条目已不在清单中'); return; }
      base.splice(index, 1);
      publishList().then(function () { render(); loadReview(); })
        .catch(function (err) { showError(err.message); });
    });
    div.appendChild(del);
    return div;
  }

  function render() {
    if (!el.list) return;
    el.list.textContent = '';
    base.forEach(function (entry, index) { el.list.appendChild(pubRow(entry, index)); });
    setText(el.status, '清单 ' + base.length + ' 台');
  }

  function loadReview() {
    return loadVerified().then(function (invalid) {
      if (!el.review) return;
      if (!invalid.length) { el.review.hidden = true; return; }
      el.review.hidden = false;
      el.pending.textContent = '';
      invalid.forEach(function (item) { el.pending.appendChild(quarRow(item)); });
    });
  }

  /* ---- add server -------------------------------------------------------------------- */

  var PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
                    /^172\.(1[6-9]|2[0-9]|3[01])\./];

  function validateUrl(raw) {
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
      unsafe = PRIVATE_V4.some(function (re) { return re.test(h); });
    }
    if (unsafe) return { error: '拒绝内网/环回/保留地址' };
    return { url: url };
  }

  function onAdd(event) {
    event.preventDefault();
    showError('');
    var check = validateUrl(el.url.value);
    if (check.error) { showError(check.error); return; }
    var probe = String(el.probe.value || '/healthz').trim() || '/healthz';
    if (!probe.startsWith('/')) probe = '/' + probe;
    var entry = { name: (el.name.value || '').trim() || check.url.host, url: check.url.href, probe: probe };
    if ((el.note.value || '').trim()) entry.note = el.note.value.trim();
    if (el.submit) { el.submit.disabled = true; setText(el.submit.querySelector('.btn__label'), '校验中…'); }
    fetch('/api/servers/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ servers: [entry] })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; });
    }).then(function (out) {
      if (!out.data.ok) throw new Error(out.data.error || ('HTTP ' + out.status));
      setText(el.status, '「' + entry.name + '」已通过校验并加入清单');
      el.name.value = ''; el.url.value = ''; el.note.value = '';
      return loadPublished().then(render);
    }).catch(function (err) {
      showError('提交失败：' + (err && err.message ? err.message : '网络'));
    }).finally(function () {
      if (el.submit) { el.submit.disabled = false; setText(el.submit.querySelector('.btn__label'), '校验并添加'); }
    });
  }

  /* ---- key gate ---------------------------------------------------------------------- */

  function enterGate() {
    el.gate.hidden = false;
    el.gateLogin.hidden = true;
    loadPublished().then(function () { render(); loadReview(); })
      .catch(function () { setText(el.status, '清单加载失败，可稍后刷新'); });
  }

  function onKeySubmit(event) {
    event.preventDefault();
    var value = (el.keyInput.value || '').trim();
    if (!value) return;
    if (el.keyGo) { el.keyGo.disabled = true; setText(el.keyGo.querySelector('.btn__label'), '验证中…'); }
    if (el.keyErr) el.keyErr.hidden = true;
    // Server-side key check: the same key protects PUT /api/servers. An empty-body PUT
    // with a VALID key answers 400 (bad servers[]) — that status proves the key.
    fetch('/api/servers', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': value },
      body: JSON.stringify({ noop: true })
    }).then(function (res) {
      if (res.status === 401) throw new Error('密钥无效');
      try { sessionStorage.setItem(KEY_STORE, value); } catch (err) { /* ignore */ }
      enterGate();
    }).catch(function (err) {
      if (el.keyErr) { el.keyErr.hidden = false; setText(el.keyErr, err && err.message ? err.message : '验证失败'); }
    }).finally(function () {
      if (el.keyGo) { el.keyGo.disabled = false; setText(el.keyGo.querySelector('.btn__label'), '进入管理'); }
    });
  }

  /* ---- boot -------------------------------------------------------------------------- */

  function boot() {
    if (el.keyForm) el.keyForm.addEventListener('submit', onKeySubmit);
    if (el.form) el.form.addEventListener('submit', onAdd);
    if (el.reload) el.reload.addEventListener('click', loadReview);

    var stored = '';
    try { stored = sessionStorage.getItem(KEY_STORE) || ''; } catch (err) { /* ignore */ }
    if (stored) {
      el.keyInput.value = stored;
      onKeySubmit.call(el.keyForm, { preventDefault: function () {} });
    } else {
      // Locked: show ONLY the key gate. The management panel stays hidden until the key
      // verifies server-side (401 = wrong key, gate stays up).
      el.gate.hidden = true;
      el.gateLogin.hidden = false;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
